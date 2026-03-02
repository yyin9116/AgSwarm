from __future__ import annotations

import argparse
import asyncio
import json
import sys
import tempfile
import time
from dataclasses import asdict, dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

REPO_ROOT = Path(__file__).resolve().parent.parent
SRC_ROOT = REPO_ROOT / "src"
if str(SRC_ROOT) not in sys.path:
    sys.path.insert(0, str(SRC_ROOT))

from workflow_control_client import WorkflowControlClient
from workflow_runtime import AdapterConfig, TaskEnvelope
from workflow_transport import NatsTransportProvider


def utc_now_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def parse_skills(raw: str) -> list[str]:
    return [x.strip() for x in raw.split(",") if x.strip()]


def format_exc(exc: Exception) -> str:
    message = str(exc).strip()
    if message:
        return f"{type(exc).__name__}: {message}"
    return type(exc).__name__


@dataclass(slots=True)
class ScenarioResult:
    name: str
    ok: bool
    status: str
    duration_sec: float
    detail: dict[str, Any]


def _build_single_run_report(
    *,
    ok: bool,
    started_at: str,
    finished_at: str,
    nats_url: str,
    node_id: str,
    client_id: str,
    results: list[ScenarioResult],
    run_index: int = 1,
) -> dict[str, Any]:
    return {
        "ok": ok,
        "run_index": run_index,
        "started_at": started_at,
        "finished_at": finished_at,
        "nats_url": nats_url,
        "node_id": node_id,
        "client_id": client_id,
        "results": [asdict(x) for x in results],
    }


def _aggregate_runs(
    *,
    runs: list[dict[str, Any]],
    nats_url: str,
    node_id: str,
    client_id: str,
    pass_rate_threshold: float,
) -> dict[str, Any]:
    total_runs = len(runs)
    run_ok = sum(1 for x in runs if bool(x.get("ok")))
    run_fail = total_runs - run_ok
    run_pass_rate = (run_ok / total_runs) if total_runs > 0 else 0.0

    scenario_stats: dict[str, dict[str, Any]] = {}
    for run in runs:
        for row in run.get("results", []):
            if not isinstance(row, dict):
                continue
            name = str(row.get("name", "")).strip()
            if not name:
                continue
            status = str(row.get("status", "")).strip().lower()
            ok = bool(row.get("ok"))
            duration = float(row.get("duration_sec", 0.0) or 0.0)
            stats = scenario_stats.setdefault(
                name,
                {
                    "runs": 0,
                    "ok": 0,
                    "failed": 0,
                    "skipped": 0,
                    "total_duration_sec": 0.0,
                },
            )
            stats["runs"] += 1
            if status == "skipped":
                stats["skipped"] += 1
            elif ok:
                stats["ok"] += 1
            else:
                stats["failed"] += 1
            stats["total_duration_sec"] += duration

    scenario_summary: dict[str, dict[str, Any]] = {}
    for name, stats in scenario_stats.items():
        executed = max(0, int(stats["runs"]) - int(stats["skipped"]))
        ok_count = int(stats["ok"])
        fail_count = int(stats["failed"])
        skip_count = int(stats["skipped"])
        total_duration = float(stats["total_duration_sec"])
        pass_rate = (ok_count / executed) if executed > 0 else 1.0
        avg_duration = (total_duration / max(1, int(stats["runs"])))
        scenario_summary[name] = {
            "runs": int(stats["runs"]),
            "ok": ok_count,
            "failed": fail_count,
            "skipped": skip_count,
            "pass_rate": round(pass_rate, 4),
            "avg_duration_sec": round(avg_duration, 3),
        }

    overall_ok = run_pass_rate >= pass_rate_threshold
    started_at = runs[0].get("started_at") if runs else utc_now_iso()
    finished_at = runs[-1].get("finished_at") if runs else utc_now_iso()
    return {
        "ok": overall_ok,
        "mode": "repeated",
        "started_at": started_at,
        "finished_at": finished_at,
        "nats_url": nats_url,
        "node_id": node_id,
        "client_id": client_id,
        "repeat": total_runs,
        "pass_rate_threshold": pass_rate_threshold,
        "summary": {
            "run_ok": run_ok,
            "run_failed": run_fail,
            "run_pass_rate": round(run_pass_rate, 4),
            "scenario": scenario_summary,
        },
        "runs": runs,
    }


class RegressionRunner:
    def __init__(self, args: argparse.Namespace) -> None:
        self.args = args
        self.transport = NatsTransportProvider(server_url=args.nats_url)
        self.client = WorkflowControlClient(client_id=args.client_id, transport=self.transport)
        self.results: list[ScenarioResult] = []
        self._download_probe_source: str | None = None
        self._download_probe_dir: str | None = None

    async def run(self) -> dict[str, Any]:
        started_at = utc_now_iso()
        await asyncio.wait_for(self.client.connect(), timeout=self.args.connect_timeout_sec)
        try:
            begin = time.perf_counter()
            snapshot_ok = False
            try:
                snapshot = await self.client.request_node_snapshot(node_id=self.args.node_id, timeout_sec=3.0)
                snapshot_ok = True
                self.results.append(
                    ScenarioResult(
                        name="node_snapshot",
                        ok=True,
                        status="succeeded",
                        duration_sec=round(time.perf_counter() - begin, 3),
                        detail=snapshot,
                    )
                )
            except Exception as exc:
                self.results.append(
                    ScenarioResult(
                        name="node_snapshot",
                        ok=False,
                        status="failed",
                        duration_sec=round(time.perf_counter() - begin, 3),
                        detail={"error": format_exc(exc)},
                    )
                )
            if (not snapshot_ok) and (not self.args.continue_on_snapshot_fail):
                for name in ("echo", "upload_dir", "latex"):
                    self.results.append(
                        ScenarioResult(
                            name=name,
                            ok=False,
                            status="skipped",
                            duration_sec=0.0,
                            detail={"reason": "node_snapshot_failed"},
                        )
                    )
                finished_at = utc_now_iso()
                return _build_single_run_report(
                    ok=False,
                    started_at=started_at,
                    finished_at=finished_at,
                    nats_url=self.args.nats_url,
                    node_id=self.args.node_id,
                    client_id=self.args.client_id,
                    results=self.results,
                    run_index=1,
                )
            await self._run_echo()
            await self._run_upload_dir()
            await self._run_download_dir()
            await self._run_download_file()
            await self._run_latex()
        finally:
            await self.client.close()

        finished_at = utc_now_iso()
        ok = all(item.ok for item in self.results if item.name != "node_snapshot")
        return _build_single_run_report(
            ok=ok,
            started_at=started_at,
            finished_at=finished_at,
            nats_url=self.args.nats_url,
            node_id=self.args.node_id,
            client_id=self.args.client_id,
            results=self.results,
            run_index=1,
        )

    async def _run_echo(self) -> None:
        begin = time.perf_counter()
        name = "echo"
        try:
            task = TaskEnvelope(
                adapter=AdapterConfig(name="echo"),
                input_text=self.args.echo_text,
                controls={"stream": True, "timeout_ms": 120000, "max_steps": 24},
                metadata={"scenario": "mac_win_regression_echo"},
            )
            skills = parse_skills(self.args.skills)
            if skills:
                task.metadata["skills"] = skills
            result = await self.client.run_task_and_wait(
                target_node_id=self.args.node_id,
                task=task,
                timeout_sec=150.0,
            )
            ok = bool(result.get("ok"))
            status = str(result.get("status", "unknown"))
            detail = {
                "task_id": result.get("task_id"),
                "status": status,
                "user_messages": result.get("user_messages", []),
                "terminal_event": result.get("terminal_event"),
            }
            self.results.append(
                ScenarioResult(
                    name=name,
                    ok=ok,
                    status=status,
                    duration_sec=round(time.perf_counter() - begin, 3),
                    detail=detail,
                )
            )
        except Exception as exc:
            self.results.append(
                ScenarioResult(
                    name=name,
                    ok=False,
                    status="failed",
                    duration_sec=round(time.perf_counter() - begin, 3),
                    detail={"error": format_exc(exc)},
                )
            )

    async def _run_upload_dir(self) -> None:
        begin = time.perf_counter()
        name = "upload_dir"
        try:
            with tempfile.TemporaryDirectory(prefix="workflow-regression-") as td:
                root = Path(td)
                (root / "a.txt").write_text("alpha\n", encoding="utf-8")
                (root / "nested").mkdir(parents=True, exist_ok=True)
                (root / "nested" / "b.txt").write_text("beta\n", encoding="utf-8")
                remote_dir = f"mac-win-regression-{int(time.time())}"
                result = await self.client.upload_directory(
                    target_node_id=self.args.node_id,
                    source_dir=str(root),
                    remote_dir=remote_dir,
                    continue_on_error=False,
                )
                self._download_probe_source = f"{remote_dir}/a.txt"
                self._download_probe_dir = remote_dir
            ok = bool(result.get("ok"))
            status = "succeeded" if ok else "failed"
            detail = {
                "source_files": 2,
                "files_uploaded": result.get("files_uploaded"),
                "files_failed": result.get("files_failed"),
                "remote_dir": result.get("remote_dir"),
                "failures": result.get("failures", []),
            }
            self.results.append(
                ScenarioResult(
                    name=name,
                    ok=ok,
                    status=status,
                    duration_sec=round(time.perf_counter() - begin, 3),
                    detail=detail,
                )
            )
        except Exception as exc:
            self.results.append(
                ScenarioResult(
                    name=name,
                    ok=False,
                    status="failed",
                    duration_sec=round(time.perf_counter() - begin, 3),
                    detail={"error": format_exc(exc)},
                )
            )

    async def _run_download_dir(self) -> None:
        begin = time.perf_counter()
        name = "download_dir"
        source_dir = self._download_probe_dir
        if not source_dir:
            self.results.append(
                ScenarioResult(
                    name=name,
                    ok=False,
                    status="skipped",
                    duration_sec=0.0,
                    detail={"reason": "missing_probe_dir"},
                )
            )
            return
        try:
            with tempfile.TemporaryDirectory(prefix="workflow-regression-download-dir-") as td:
                output_dir = Path(td) / "downloaded"
                result = await self.client.download_directory(
                    target_node_id=self.args.node_id,
                    source_dir=source_dir,
                    output_dir=str(output_dir),
                    list_page_size=self.args.download_list_page_size,
                    max_parallelism=self.args.download_max_parallelism,
                    continue_on_error=False,
                    allow_overwrite=True,
                )
                a_text = (output_dir / "a.txt").read_text(encoding="utf-8")
                b_text = (output_dir / "nested" / "b.txt").read_text(encoding="utf-8")
            ok = bool(result.get("ok")) and a_text == "alpha\n" and b_text == "beta\n"
            status = "succeeded" if ok else "failed"
            detail = {
                "source_dir": source_dir,
                "output_dir": result.get("output_dir"),
                "files_downloaded": result.get("files_downloaded"),
                "files_failed": result.get("files_failed"),
                "list_pages": result.get("list_pages"),
                "truncated": result.get("truncated"),
            }
            self.results.append(
                ScenarioResult(
                    name=name,
                    ok=ok,
                    status=status,
                    duration_sec=round(time.perf_counter() - begin, 3),
                    detail=detail,
                )
            )
        except Exception as exc:
            self.results.append(
                ScenarioResult(
                    name=name,
                    ok=False,
                    status="failed",
                    duration_sec=round(time.perf_counter() - begin, 3),
                    detail={"error": format_exc(exc)},
                )
            )

    async def _run_download_file(self) -> None:
        begin = time.perf_counter()
        name = "download_file"
        source_path = self._download_probe_source
        if not source_path:
            self.results.append(
                ScenarioResult(
                    name=name,
                    ok=False,
                    status="skipped",
                    duration_sec=0.0,
                    detail={"reason": "missing_probe_source"},
                )
            )
            return
        try:
            with tempfile.TemporaryDirectory(prefix="workflow-regression-download-") as td:
                output = Path(td) / "a.txt"
                result = await self.client.download_file(
                    target_node_id=self.args.node_id,
                    source_path=source_path,
                    output_path=str(output),
                    allow_overwrite=True,
                )
                text = output.read_text(encoding="utf-8")
            ok = bool(result.get("ok")) and text == "alpha\n"
            status = "succeeded" if ok else "failed"
            detail = {
                "source_path": source_path,
                "output_path": result.get("output_path"),
                "size_bytes": result.get("size_bytes"),
                "sha256": result.get("sha256"),
                "content_preview": text[:32],
            }
            self.results.append(
                ScenarioResult(
                    name=name,
                    ok=ok,
                    status=status,
                    duration_sec=round(time.perf_counter() - begin, 3),
                    detail=detail,
                )
            )
        except Exception as exc:
            self.results.append(
                ScenarioResult(
                    name=name,
                    ok=False,
                    status="failed",
                    duration_sec=round(time.perf_counter() - begin, 3),
                    detail={"error": format_exc(exc)},
                )
            )

    async def _run_latex(self) -> None:
        begin = time.perf_counter()
        name = "latex"
        if self.args.skip_latex:
            self.results.append(
                ScenarioResult(
                    name=name,
                    ok=True,
                    status="skipped",
                    duration_sec=0.0,
                    detail={"reason": "skip_latex=true"},
                )
            )
            return

        required = [self.args.latex_workspace, self.args.latex_mcp_dir, self.args.main_tex]
        if any(not x for x in required):
            self.results.append(
                ScenarioResult(
                    name=name,
                    ok=False,
                    status="failed",
                    duration_sec=0.0,
                    detail={
                        "error": "latex args missing: --latex-workspace --latex-mcp-dir --main-tex are required unless --skip-latex",
                    },
                )
            )
            return

        try:
            options = {
                "workspace": self.args.latex_workspace,
                "server_cwd": self.args.latex_mcp_dir,
                "tool": "compile_and_preview",
                "file_list": [self.args.main_tex],
                "main_tex": self.args.main_tex,
                "engine": self.args.engine,
                "output_subdir": self.args.output_subdir,
                "tool_args": {
                    "preview_page": self.args.preview_page,
                    "preview_dpi": self.args.preview_dpi,
                    "timeout_sec": self.args.compile_timeout_sec,
                },
            }
            if self.args.latex_bin_dir:
                options["latex_bin_dir"] = self.args.latex_bin_dir

            task = TaskEnvelope(
                adapter=AdapterConfig(name="latex_mcp", options=options),
                input_text=f"Compile LaTeX file: {self.args.main_tex}",
                controls={"stream": True, "timeout_ms": int(self.args.wait_timeout_sec * 1000), "max_steps": 96},
                metadata={"scenario": "mac_win_regression_latex"},
            )
            skills = parse_skills(self.args.skills)
            if skills:
                task.metadata["skills"] = skills
            result = await self.client.run_task_and_wait(
                target_node_id=self.args.node_id,
                task=task,
                timeout_sec=self.args.wait_timeout_sec,
            )
            ok = bool(result.get("ok"))
            status = str(result.get("status", "unknown"))
            terminal_event = result.get("terminal_event") if isinstance(result.get("terminal_event"), dict) else {}
            payload = terminal_event.get("payload") if isinstance(terminal_event, dict) else {}
            output = payload.get("output") if isinstance(payload, dict) else {}
            detail = {
                "task_id": result.get("task_id"),
                "status": status,
                "user_messages": result.get("user_messages", []),
                "pdf_path": output.get("pdf_path") if isinstance(output, dict) else None,
                "preview_image_path": output.get("preview_image_path") if isinstance(output, dict) else None,
                "diagnostics": output.get("diagnostics") if isinstance(output, dict) else None,
                "terminal_event": terminal_event,
            }
            self.results.append(
                ScenarioResult(
                    name=name,
                    ok=ok,
                    status=status,
                    duration_sec=round(time.perf_counter() - begin, 3),
                    detail=detail,
                )
            )
        except Exception as exc:
            self.results.append(
                ScenarioResult(
                    name=name,
                    ok=False,
                    status="failed",
                    duration_sec=round(time.perf_counter() - begin, 3),
                    detail={"error": format_exc(exc)},
                )
            )


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Cross-machine regression (Mac client -> Windows node).")
    parser.add_argument("--nats-url", default="nats://127.0.0.1:4222")
    parser.add_argument("--node-id", default="node-win")
    parser.add_argument("--client-id", default="regression-mac-client")
    parser.add_argument("--connect-timeout-sec", type=float, default=8.0)
    parser.add_argument("--skills", default="safe_default")
    parser.add_argument("--echo-text", default="hello from mac regression")
    parser.add_argument("--download-max-parallelism", type=int, default=4)
    parser.add_argument("--download-list-page-size", type=int, default=500)
    parser.add_argument(
        "--continue-on-snapshot-fail",
        action="store_true",
        help="Continue running scenarios even when node snapshot fails.",
    )

    parser.add_argument("--skip-latex", action="store_true")
    parser.add_argument("--latex-workspace", default="")
    parser.add_argument("--latex-mcp-dir", default="")
    parser.add_argument("--main-tex", default="")
    parser.add_argument("--engine", default="pdflatex")
    parser.add_argument("--output-subdir", default="build_case4_nats_regression")
    parser.add_argument("--latex-bin-dir", default="")
    parser.add_argument("--preview-page", type=int, default=1)
    parser.add_argument("--preview-dpi", type=int, default=160)
    parser.add_argument("--compile-timeout-sec", type=int, default=360)
    parser.add_argument("--wait-timeout-sec", type=float, default=900.0)
    parser.add_argument("--repeat", type=int, default=1, help="Number of full regression rounds to run.")
    parser.add_argument(
        "--repeat-interval-sec",
        type=float,
        default=0.0,
        help="Sleep interval between rounds when --repeat > 1.",
    )
    parser.add_argument(
        "--pass-rate-threshold",
        type=float,
        default=1.0,
        help="Overall run-pass threshold (0~1) for repeated mode.",
    )

    parser.add_argument("--report-path", default="")
    return parser


def default_report_path() -> Path:
    stamp = datetime.now().strftime("%Y%m%d_%H%M%S")
    return REPO_ROOT / "tmp" / "test-reports" / f"mac_win_regression_{stamp}.json"


def write_report(path: Path, payload: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")


def print_summary(report: dict[str, Any], report_path: Path) -> None:
    print("Regression Summary")
    print(f"  ok: {report.get('ok')}")
    print(f"  node: {report.get('node_id')} | nats: {report.get('nats_url')}")
    mode = str(report.get("mode", "single"))
    if mode == "repeated":
        summary = report.get("summary", {}) if isinstance(report.get("summary"), dict) else {}
        print(
            "  repeated: runs={runs} ok={ok} failed={failed} pass_rate={rate} threshold={threshold}".format(
                runs=report.get("repeat"),
                ok=summary.get("run_ok"),
                failed=summary.get("run_failed"),
                rate=summary.get("run_pass_rate"),
                threshold=report.get("pass_rate_threshold"),
            )
        )
        scenario = summary.get("scenario", {}) if isinstance(summary.get("scenario"), dict) else {}
        for name in sorted(scenario.keys()):
            row = scenario.get(name, {})
            print(
                "  - {name}: ok={ok} failed={failed} skipped={skipped} pass_rate={rate} avg={avg}s".format(
                    name=name,
                    ok=row.get("ok"),
                    failed=row.get("failed"),
                    skipped=row.get("skipped"),
                    rate=row.get("pass_rate"),
                    avg=row.get("avg_duration_sec"),
                )
            )
    else:
        for item in report.get("results", []):
            print(
                f"  - {item.get('name')}: status={item.get('status')} ok={item.get('ok')} duration={item.get('duration_sec')}s"
            )
    print(f"  report: {report_path}")


async def main_async(args: argparse.Namespace) -> int:
    repeat = max(1, int(args.repeat))
    pass_rate_threshold = float(args.pass_rate_threshold)
    if pass_rate_threshold < 0.0:
        pass_rate_threshold = 0.0
    if pass_rate_threshold > 1.0:
        pass_rate_threshold = 1.0

    if repeat == 1:
        report: dict[str, Any]
        try:
            runner = RegressionRunner(args)
            report = await runner.run()
        except Exception as exc:
            if isinstance(exc, TimeoutError):
                error_text = f"TimeoutError: connect timeout after {args.connect_timeout_sec}s"
            else:
                error_text = format_exc(exc)
            report = {
                "ok": False,
                "started_at": utc_now_iso(),
                "finished_at": utc_now_iso(),
                "nats_url": args.nats_url,
                "node_id": args.node_id,
                "client_id": args.client_id,
                "results": [
                    asdict(
                        ScenarioResult(
                            name="runner",
                            ok=False,
                            status="failed",
                            duration_sec=0.0,
                            detail={"error": error_text},
                        )
                    )
                ],
            }
    else:
        runs: list[dict[str, Any]] = []
        for index in range(1, repeat + 1):
            try:
                runner = RegressionRunner(args)
                single = await runner.run()
                single["run_index"] = index
            except Exception as exc:
                if isinstance(exc, TimeoutError):
                    error_text = f"TimeoutError: connect timeout after {args.connect_timeout_sec}s"
                else:
                    error_text = format_exc(exc)
                single = {
                    "ok": False,
                    "run_index": index,
                    "started_at": utc_now_iso(),
                    "finished_at": utc_now_iso(),
                    "nats_url": args.nats_url,
                    "node_id": args.node_id,
                    "client_id": args.client_id,
                    "results": [
                        asdict(
                            ScenarioResult(
                                name="runner",
                                ok=False,
                                status="failed",
                                duration_sec=0.0,
                                detail={"error": error_text},
                            )
                        )
                    ],
                }
            runs.append(single)
            if index < repeat and args.repeat_interval_sec > 0:
                await asyncio.sleep(args.repeat_interval_sec)
        report = _aggregate_runs(
            runs=runs,
            nats_url=args.nats_url,
            node_id=args.node_id,
            client_id=args.client_id,
            pass_rate_threshold=pass_rate_threshold,
        )
    report_path = Path(args.report_path) if args.report_path else default_report_path()
    write_report(report_path, report)
    print_summary(report, report_path)
    return 0 if report.get("ok") else 1


def main() -> int:
    parser = build_parser()
    args = parser.parse_args()
    return asyncio.run(main_async(args))


if __name__ == "__main__":
    raise SystemExit(main())
