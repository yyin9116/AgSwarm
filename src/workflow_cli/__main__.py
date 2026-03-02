from __future__ import annotations

import argparse
import asyncio
import json
import logging
import os
from dataclasses import asdict

from workflow_discovery import (
    DISCOVERY_BROADCAST_DEFAULT,
    DISCOVERY_PORT_DEFAULT,
    LanNodeBroadcaster,
    resolve_advertise_nats_url,
)
from workflow_control_client import WorkflowControlClient
from workflow_logging import setup_logging
from workflow_node_daemon import NatsDaemonBridge, WorkflowNodeDaemon
from workflow_runtime.adapters import LatexMcpAdapter
from workflow_runtime.adapters.base import Adapter
from workflow_runtime.error_codes import build_error_summary
from workflow_runtime.event_sink import EventSink
from workflow_runtime.protocol import AdapterConfig, TaskEnvelope
from workflow_runtime.runtime import Runtime
from workflow_transport import NatsTransportProvider

logger = logging.getLogger(__name__)


def _env_flag(name: str, default: bool = False) -> bool:
    raw = os.getenv(name)
    if raw is None:
        return default
    return raw.strip().lower() in {"1", "true", "yes", "on"}


def _parse_skills(raw: str | None) -> list[str]:
    if not raw:
        return []
    return [x.strip() for x in raw.split(",") if x.strip()]


def _attach_error_summary(result: dict) -> dict:
    summary = build_error_summary(result)
    if summary["code"] or summary["message"]:
        result["error_summary"] = summary
    return result


def _print_error_and_exit(exc: Exception, *, context: dict | None = None) -> None:
    payload: dict = {"ok": False, "status": "failed", "error": str(exc)}
    if context:
        payload.update(context)
    payload = _attach_error_summary(payload)
    print(json.dumps(payload, ensure_ascii=False, indent=2))
    raise SystemExit(2)


class EchoAdapter(Adapter):
    name = "echo"

    async def run(self, task: TaskEnvelope, sink: EventSink) -> None:
        await sink.emit("adapter.started", {"adapter": self.name})
        await sink.emit("adapter.token", {"text": task.input_text, "progress": 80, "step": "echo"})
        await sink.emit("adapter.completed", {"output": task.input_text, "progress": 100})


async def cmd_node(args: argparse.Namespace) -> None:
    runtime = Runtime(
        adapters=[
            EchoAdapter(),
            LatexMcpAdapter(
                default_workspace=args.latex_workspace,
                default_server_cwd=args.latex_server_cwd,
            ),
        ],
        skill_catalog_path=args.skills_config,
    )
    daemon = WorkflowNodeDaemon(
        runtime,
        max_concurrency=args.max_concurrency,
        default_retries=args.default_retries,
    )
    transport = NatsTransportProvider(server_url=args.nats_url)
    bridge = NatsDaemonBridge(
        node_id=args.node_id,
        daemon=daemon,
        transport=transport,
    )
    broadcaster: LanNodeBroadcaster | None = None

    await daemon.start()
    await bridge.start()
    discovery_enabled = not bool(args.disable_discovery)
    advertise_nats_url = ""
    if discovery_enabled:
        advertise_nats_url = resolve_advertise_nats_url(
            args.nats_url,
            explicit_advertise_url=(args.advertise_nats_url or None),
        )
        broadcaster = LanNodeBroadcaster(
            node_id=args.node_id,
            nats_url=advertise_nats_url,
            port=max(1, int(args.discovery_port)),
            broadcast_addr=str(args.discovery_broadcast),
            interval_sec=max(0.5, float(args.discovery_interval_sec)),
            snapshot_provider=lambda: asdict(daemon.get_node_snapshot()),
        )
        await broadcaster.start()
    print(
        json.dumps(
            {
                "ok": True,
                "node_id": args.node_id,
                "nats_url": args.nats_url,
                "max_concurrency": args.max_concurrency,
                "default_retries": args.default_retries,
                "latex_workspace": args.latex_workspace,
                "latex_server_cwd": args.latex_server_cwd,
                "skills_config": args.skills_config,
                "discovery_enabled": discovery_enabled,
                "discovery_port": int(args.discovery_port),
                "discovery_broadcast": str(args.discovery_broadcast),
                "discovery_interval_sec": float(args.discovery_interval_sec),
                "advertise_nats_url": advertise_nats_url if discovery_enabled else "",
            },
            ensure_ascii=False,
        )
    )
    try:
        while True:
            await asyncio.sleep(60)
    finally:
        if broadcaster is not None:
            await broadcaster.stop()
        await bridge.stop()
        await daemon.stop()


async def _with_client(args: argparse.Namespace) -> WorkflowControlClient:
    transport = NatsTransportProvider(server_url=args.nats_url)
    client = WorkflowControlClient(client_id=args.client_id, transport=transport)
    await client.connect()
    return client


async def cmd_submit_echo(args: argparse.Namespace) -> None:
    client = await _with_client(args)
    try:
        metadata: dict[str, object] = {}
        selected_skills = _parse_skills(args.skills)
        if selected_skills:
            metadata["skills"] = selected_skills
        task = TaskEnvelope(
            adapter=AdapterConfig(name="echo"),
            input_text=args.text,
            controls={"stream": True, "timeout_ms": args.timeout_ms, "max_steps": 16},
            metadata=metadata,
        )
        result = await client.run_task_and_wait(
            target_node_id=args.node_id,
            task=task,
            timeout_sec=args.wait_timeout_sec,
        )
        result = _attach_error_summary(result)
        print(json.dumps(result, ensure_ascii=False, indent=2))
    finally:
        await client.close()


async def cmd_submit_latex(args: argparse.Namespace) -> None:
    client = await _with_client(args)
    try:
        metadata: dict[str, object] = {"scenario": "latex_compile_cli"}
        selected_skills = _parse_skills(args.skills)
        if selected_skills:
            metadata["skills"] = selected_skills
        options = {
            "workspace": args.workspace,
            "server_cwd": args.latex_mcp_dir,
            "tool": "compile_and_preview",
            "file_list": [args.main_tex],
            "main_tex": args.main_tex,
            "engine": args.engine,
            "output_subdir": args.output_subdir,
            "latex_bin_dir": args.latex_bin_dir,
            "tool_args": {
                "preview_page": args.preview_page,
                "preview_dpi": args.preview_dpi,
                "timeout_sec": args.compile_timeout_sec,
            },
        }
        task = TaskEnvelope(
            adapter=AdapterConfig(name="latex_mcp", options=options),
            input_text=f"Compile LaTeX file: {args.main_tex}",
            controls={"stream": True, "timeout_ms": args.timeout_ms, "max_steps": 64},
            metadata=metadata,
        )
        result = await client.run_task_and_wait(
            target_node_id=args.node_id,
            task=task,
            timeout_sec=args.wait_timeout_sec,
        )
        result = _attach_error_summary(result)
        print(json.dumps(result, ensure_ascii=False, indent=2))
    finally:
        await client.close()


async def cmd_upload_file(args: argparse.Namespace) -> None:
    client = await _with_client(args)
    try:
        try:
            result = await client.upload_file(
                target_node_id=args.node_id,
                source_path=args.source_path,
                remote_name=args.remote_name,
                chunk_size=args.chunk_size,
                transfer_id=args.transfer_id,
                max_parallelism=args.max_parallelism,
                chunk_retries=args.chunk_retries,
            )
        except Exception as exc:
            _print_error_and_exit(
                exc,
                context={"node_id": args.node_id, "source_path": args.source_path, "command": "upload-file"},
            )
        result = _attach_error_summary(result)
        print(json.dumps(result, ensure_ascii=False, indent=2))
    finally:
        await client.close()


async def cmd_upload_dir(args: argparse.Namespace) -> None:
    client = await _with_client(args)
    try:
        try:
            result = await client.upload_directory(
                target_node_id=args.node_id,
                source_dir=args.source_dir,
                remote_dir=args.remote_dir,
                chunk_size=args.chunk_size,
                max_parallelism=args.max_parallelism,
                chunk_retries=args.chunk_retries,
                continue_on_error=args.continue_on_error,
            )
        except Exception as exc:
            _print_error_and_exit(
                exc,
                context={"node_id": args.node_id, "source_dir": args.source_dir, "command": "upload-dir"},
            )
        result = _attach_error_summary(result)
        print(json.dumps(result, ensure_ascii=False, indent=2))
    finally:
        await client.close()


async def cmd_download_file(args: argparse.Namespace) -> None:
    client = await _with_client(args)
    try:
        try:
            result = await client.download_file(
                target_node_id=args.node_id,
                source_path=args.source_path,
                output_path=args.output_path,
                chunk_size=args.chunk_size,
                download_id=args.download_id,
                chunk_retries=args.chunk_retries,
                request_timeout_sec=args.request_timeout_sec,
                allow_overwrite=args.overwrite,
            )
        except Exception as exc:
            _print_error_and_exit(
                exc,
                context={"node_id": args.node_id, "source_path": args.source_path, "command": "download-file"},
            )
        result = _attach_error_summary(result)
        print(json.dumps(result, ensure_ascii=False, indent=2))
    finally:
        await client.close()


async def cmd_download_dir(args: argparse.Namespace) -> None:
    client = await _with_client(args)
    try:
        try:
            result = await client.download_directory(
                target_node_id=args.node_id,
                source_dir=args.source_dir,
                output_dir=args.output_dir,
                max_files=args.max_files,
                list_page_size=args.list_page_size,
                max_parallelism=args.max_parallelism,
                chunk_size=args.chunk_size,
                chunk_retries=args.chunk_retries,
                request_timeout_sec=args.request_timeout_sec,
                continue_on_error=args.continue_on_error,
                allow_overwrite=args.overwrite,
            )
        except Exception as exc:
            _print_error_and_exit(
                exc,
                context={"node_id": args.node_id, "source_dir": args.source_dir, "command": "download-dir"},
            )
        result = _attach_error_summary(result)
        print(json.dumps(result, ensure_ascii=False, indent=2))
    finally:
        await client.close()


async def cmd_node_snapshot(args: argparse.Namespace) -> None:
    client = await _with_client(args)
    try:
        snapshot = await client.request_node_snapshot(node_id=args.node_id, timeout_sec=args.timeout_sec)
        print(json.dumps(snapshot, ensure_ascii=False, indent=2))
    finally:
        await client.close()


def _parse_required_adapters(raw: str) -> list[str]:
    if not raw:
        return []
    return [x.strip() for x in raw.split(",") if x.strip()]


async def cmd_agent_check(args: argparse.Namespace) -> None:
    client = await _with_client(args)
    try:
        snapshot = await client.request_node_snapshot(node_id=args.node_id, timeout_sec=args.timeout_sec)
    finally:
        await client.close()

    required = _parse_required_adapters(args.require_adapters)
    adapters = snapshot.get("adapters")
    if isinstance(adapters, list):
        adapter_set = {str(x) for x in adapters}
    else:
        adapter_set = set()
    missing_adapters = [name for name in required if name not in adapter_set]

    status = str(snapshot.get("status", "unknown"))
    can_accept = bool(snapshot.get("can_accept_tasks", status != "stopped"))
    agent_ready = bool(snapshot.get("agent_ready", can_accept and len(adapter_set) > 0))
    skills_loaded = bool(snapshot.get("skills_loaded", False))
    checks = {
        "node_reachable": True,
        "can_accept_tasks": can_accept,
        "agent_ready": agent_ready,
        "required_adapters_ok": len(missing_adapters) == 0,
        "skills_loaded": skills_loaded,
    }
    ok = all(checks.values())
    report = {
        "ok": ok,
        "node_id": args.node_id,
        "checks": checks,
        "required_adapters": required,
        "missing_adapters": missing_adapters,
        "snapshot": snapshot,
    }
    print(json.dumps(report, ensure_ascii=False, indent=2))


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="workflow-cli", description="Workflow NATS test CLI")
    parser.add_argument(
        "--log-level",
        default=os.getenv("WORKFLOW_LOG_LEVEL", "INFO"),
        help="Log level: DEBUG/INFO/WARN/ERROR",
    )
    parser.add_argument(
        "--log-file",
        default=os.getenv("WORKFLOW_LOG_FILE"),
        help="Optional log file path for rotating logs.",
    )
    sub = parser.add_subparsers(dest="command", required=True)

    node = sub.add_parser("node", help="Run node daemon bridge")
    node.add_argument("--node-id", default="node-a")
    node.add_argument("--nats-url", default="nats://127.0.0.1:4222")
    node.add_argument("--max-concurrency", type=int, default=2)
    node.add_argument("--default-retries", type=int, default=1)
    node.add_argument("--latex-workspace", default=None)
    node.add_argument("--latex-server-cwd", default=None)
    node.add_argument(
        "--disable-discovery",
        action="store_true",
        default=_env_flag("WORKFLOW_DISABLE_DISCOVERY", default=False),
        help="Disable LAN UDP auto-discovery broadcast.",
    )
    node.add_argument(
        "--discovery-port",
        type=int,
        default=int(os.getenv("WORKFLOW_DISCOVERY_PORT", str(DISCOVERY_PORT_DEFAULT))),
        help="UDP port for LAN discovery broadcast/listen.",
    )
    node.add_argument(
        "--discovery-interval-sec",
        type=float,
        default=float(os.getenv("WORKFLOW_DISCOVERY_INTERVAL_SEC", "2.0")),
        help="Seconds between node discovery heartbeats.",
    )
    node.add_argument(
        "--discovery-broadcast",
        default=os.getenv("WORKFLOW_DISCOVERY_BROADCAST", DISCOVERY_BROADCAST_DEFAULT),
        help="Discovery broadcast address (default 255.255.255.255).",
    )
    node.add_argument(
        "--advertise-nats-url",
        default=os.getenv("WORKFLOW_ADVERTISE_NATS_URL", ""),
        help="Optional advertised NATS URL for discovery payload.",
    )
    node.add_argument(
        "--skills-config",
        default=os.getenv("WORKFLOW_SKILLS_CONFIG"),
        help="Optional path to skills json config (or set WORKFLOW_SKILLS_CONFIG).",
    )

    echo = sub.add_parser("submit-echo", help="Submit echo task")
    echo.add_argument("--client-id", default="cli-client")
    echo.add_argument("--node-id", default="node-a")
    echo.add_argument("--nats-url", default="nats://127.0.0.1:4222")
    echo.add_argument("--text", default="hello from workflow-cli")
    echo.add_argument("--skills", default="", help="Comma-separated skill ids to apply for this task.")
    echo.add_argument("--timeout-ms", type=int, default=120000)
    echo.add_argument("--wait-timeout-sec", type=float, default=120.0)

    latex = sub.add_parser("submit-latex", help="Submit latex-mcp task")
    latex.add_argument("--client-id", default="cli-client")
    latex.add_argument("--node-id", default="node-a")
    latex.add_argument("--nats-url", default="nats://127.0.0.1:4222")
    latex.add_argument("--workspace", required=True)
    latex.add_argument("--latex-mcp-dir", required=True)
    latex.add_argument("--main-tex", required=True)
    latex.add_argument("--skills", default="", help="Comma-separated skill ids to apply for this task.")
    latex.add_argument("--engine", default="pdflatex")
    latex.add_argument("--output-subdir", default="build_case_cli")
    latex.add_argument("--latex-bin-dir", default=None)
    latex.add_argument("--preview-page", type=int, default=1)
    latex.add_argument("--preview-dpi", type=int, default=160)
    latex.add_argument("--compile-timeout-sec", type=int, default=360)
    latex.add_argument("--timeout-ms", type=int, default=600000)
    latex.add_argument("--wait-timeout-sec", type=float, default=900.0)

    upload = sub.add_parser("upload-file", help="Upload a file to node")
    upload.add_argument("--client-id", default="cli-client")
    upload.add_argument("--node-id", default="node-a")
    upload.add_argument("--nats-url", default="nats://127.0.0.1:4222")
    upload.add_argument("--source-path", required=True)
    upload.add_argument("--remote-name", default=None)
    upload.add_argument("--chunk-size", type=int, default=256 * 1024)
    upload.add_argument("--transfer-id", default=None)
    upload.add_argument("--max-parallelism", type=int, default=4)
    upload.add_argument("--chunk-retries", type=int, default=1)

    upload_dir = sub.add_parser("upload-dir", help="Upload a directory to node (recursive)")
    upload_dir.add_argument("--client-id", default="cli-client")
    upload_dir.add_argument("--node-id", default="node-a")
    upload_dir.add_argument("--nats-url", default="nats://127.0.0.1:4222")
    upload_dir.add_argument("--source-dir", required=True)
    upload_dir.add_argument("--remote-dir", default=None)
    upload_dir.add_argument("--chunk-size", type=int, default=256 * 1024)
    upload_dir.add_argument("--max-parallelism", type=int, default=4)
    upload_dir.add_argument("--chunk-retries", type=int, default=1)
    upload_dir.add_argument("--continue-on-error", action="store_true")

    download = sub.add_parser("download-file", help="Download a file from node")
    download.add_argument("--client-id", default="cli-client")
    download.add_argument("--node-id", default="node-a")
    download.add_argument("--nats-url", default="nats://127.0.0.1:4222")
    download.add_argument("--source-path", required=True, help="Source path on node (absolute or incoming-relative).")
    download.add_argument("--output-path", default=None, help="Local output path. Defaults to tmp/downloads/<name>.")
    download.add_argument("--chunk-size", type=int, default=256 * 1024)
    download.add_argument("--download-id", default=None)
    download.add_argument("--chunk-retries", type=int, default=1)
    download.add_argument("--request-timeout-sec", type=float, default=10.0)
    download.add_argument("--overwrite", action="store_true", help="Overwrite output path if it exists.")

    download_dir = sub.add_parser("download-dir", help="Download a directory from node")
    download_dir.add_argument("--client-id", default="cli-client")
    download_dir.add_argument("--node-id", default="node-a")
    download_dir.add_argument("--nats-url", default="nats://127.0.0.1:4222")
    download_dir.add_argument("--source-dir", required=True, help="Source directory on node.")
    download_dir.add_argument("--output-dir", default=None, help="Local output directory.")
    download_dir.add_argument("--max-files", type=int, default=2000)
    download_dir.add_argument("--list-page-size", type=int, default=500)
    download_dir.add_argument("--max-parallelism", type=int, default=4)
    download_dir.add_argument("--chunk-size", type=int, default=256 * 1024)
    download_dir.add_argument("--chunk-retries", type=int, default=1)
    download_dir.add_argument("--request-timeout-sec", type=float, default=10.0)
    download_dir.add_argument("--continue-on-error", action="store_true")
    download_dir.add_argument("--overwrite", action="store_true")

    snap = sub.add_parser("node-snapshot", help="Request node snapshot")
    snap.add_argument("--client-id", default="cli-client")
    snap.add_argument("--node-id", default="node-a")
    snap.add_argument("--nats-url", default="nats://127.0.0.1:4222")
    snap.add_argument("--timeout-sec", type=float, default=3.0)

    agent_check = sub.add_parser("agent-check", help="Check if node agent is ready and can accept tasks")
    agent_check.add_argument("--client-id", default="cli-client")
    agent_check.add_argument("--node-id", default="node-a")
    agent_check.add_argument("--nats-url", default="nats://127.0.0.1:4222")
    agent_check.add_argument("--timeout-sec", type=float, default=3.0)
    agent_check.add_argument(
        "--require-adapters",
        default="echo,latex_mcp",
        help="Comma separated adapter names required for this node.",
    )

    return parser


async def dispatch(args: argparse.Namespace) -> None:
    if args.command == "node":
        await cmd_node(args)
        return
    if args.command == "submit-echo":
        await cmd_submit_echo(args)
        return
    if args.command == "submit-latex":
        await cmd_submit_latex(args)
        return
    if args.command == "upload-file":
        await cmd_upload_file(args)
        return
    if args.command == "upload-dir":
        await cmd_upload_dir(args)
        return
    if args.command == "download-file":
        await cmd_download_file(args)
        return
    if args.command == "download-dir":
        await cmd_download_dir(args)
        return
    if args.command == "node-snapshot":
        await cmd_node_snapshot(args)
        return
    if args.command == "agent-check":
        await cmd_agent_check(args)
        return
    raise ValueError(f"unknown command: {args.command}")


def main() -> None:
    parser = build_parser()
    args = parser.parse_args()
    setup_logging(level=args.log_level, log_file=args.log_file)
    logger.info("workflow_cli start command=%s", args.command)
    asyncio.run(dispatch(args))


if __name__ == "__main__":
    main()
