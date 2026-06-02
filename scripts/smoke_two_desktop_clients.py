from __future__ import annotations

import argparse
import asyncio
import json
import os
import shutil
import subprocess
import sys
import time
from pathlib import Path
from typing import Any

REPO_ROOT = Path(__file__).resolve().parent.parent
SRC_ROOT = REPO_ROOT / "src"
if str(SRC_ROOT) not in sys.path:
    sys.path.insert(0, str(SRC_ROOT))

from workflow_desktop.main_window import MainWindow
from workflow_desktop.models import DesktopConfig


def _open_log(path: Path):
    path.parent.mkdir(parents=True, exist_ok=True)
    return path.open("w", encoding="utf-8")


def _find_nats_server(explicit: str = "") -> str:
    if explicit:
        return explicit
    found = shutil.which("nats-server")
    if found:
        return found
    homebrew = Path("/opt/homebrew/opt/nats-server/bin/nats-server")
    if homebrew.exists():
        return str(homebrew)
    intel_homebrew = Path("/usr/local/opt/nats-server/bin/nats-server")
    if intel_homebrew.exists():
        return str(intel_homebrew)
    raise FileNotFoundError("nats-server not found. Install it or pass --nats-server.")


def _start_nats(*, args: argparse.Namespace, env: dict[str, str]) -> tuple[subprocess.Popen | None, list[Any]]:
    if args.no_start_nats:
        return None, []
    nats_server = _find_nats_server(args.nats_server)
    logs_dir = REPO_ROOT / "tmp" / "test-logs"
    stdout = _open_log(logs_dir / "two-desktop.nats.out.log")
    stderr = _open_log(logs_dir / "two-desktop.nats.err.log")
    cmd = [nats_server, "-c", args.nats_config]
    proc = subprocess.Popen(cmd, cwd=str(REPO_ROOT), stdout=stdout, stderr=stderr, env=env)
    time.sleep(args.nats_startup_sec)
    if proc.poll() is not None:
        raise RuntimeError(f"nats-server exited early with code {proc.returncode}; see {stderr.name}")
    return proc, [stdout, stderr]


def _smoke_state_path(*, state_root: Path, client_id: str) -> Path:
    return state_root / client_id / "smoke-conversations.json"


def _client_state_dir(*, state_root: Path, client_id: str) -> Path:
    return state_root / client_id


def _reset_smoke_state(*, state_root: Path, client_ids: tuple[str, ...]) -> None:
    for client_id in client_ids:
        shutil.rmtree(_client_state_dir(state_root=state_root, client_id=client_id), ignore_errors=True)


def _desktop_config(
    *,
    args: argparse.Namespace,
    client_id: str,
    display_name: str,
    conversation_state_path: Path,
) -> DesktopConfig:
    return DesktopConfig(
        nats_url=args.nats_url,
        client_id=client_id,
        display_name=display_name,
        node_candidates=[x.strip() for x in args.nodes.split(",") if x.strip()],
        conversation_state_path=str(conversation_state_path),
        settings_path=str(conversation_state_path.parent / "settings.json"),
        mcp_config_path=str(conversation_state_path.parent / "mcp-services.json"),
        discovery_enabled=False,
        discovery_auto_switch_nats=False,
        config_sync_enabled=False,
    )


def _run_window_flow(args: argparse.Namespace) -> dict[str, Any]:
    os.environ.setdefault("QT_QPA_PLATFORM", args.qt_platform)
    from PySide6.QtWidgets import QApplication
    from qasync import QEventLoop

    state_root = Path(args.state_dir)
    client_c = f"{args.client_b}-background"
    if not args.keep_state:
        _reset_smoke_state(state_root=state_root, client_ids=(args.client_a, args.client_b, client_c))

    app = QApplication.instance() or QApplication([])
    loop = QEventLoop(app)
    asyncio.set_event_loop(loop)
    state_a = _smoke_state_path(state_root=state_root, client_id=args.client_a)
    state_b = _smoke_state_path(state_root=state_root, client_id=args.client_b)
    state_c = _smoke_state_path(state_root=state_root, client_id=client_c)

    a = MainWindow(
        _desktop_config(
            args=args,
            client_id=args.client_a,
            display_name=f"{args.client_a} smoke",
            conversation_state_path=state_a,
        )
    )
    b = MainWindow(
        _desktop_config(
            args=args,
            client_id=args.client_b,
            display_name=f"{args.client_b} smoke",
            conversation_state_path=state_b,
        )
    )
    c = MainWindow(
        _desktop_config(
            args=args,
            client_id=client_c,
            display_name=f"{client_c} smoke",
            conversation_state_path=state_c,
        )
    )

    async def _flow() -> dict[str, Any]:
        nonlocal b
        await a.start()
        await b.start()
        await c.start()
        try:
            a.peer_input.setText(args.client_b)
            a.on_add_peer_clicked()
            b.peer_input.setText(args.client_a)
            b.on_add_peer_clicked()
            c.peer_input.setText(args.client_b)
            c.on_add_peer_clicked()

            a.chat_input.setPlainText(args.chat_text)
            await a.on_send_chat_clicked()
            await asyncio.sleep(args.settle_sec)
            if not any(
                row.get("type") == "chat.message"
                and row.get("direction") == "in"
                and row.get("payload", {}).get("text") == args.chat_text
                for row in b._conversation_messages
            ):
                raise AssertionError("client B did not receive chat.message")

            a.chat_input.setPlainText(args.task_instruction)
            a.script_editor.setPlainText(args.script)
            await a.on_send_task_request_clicked()
            await asyncio.sleep(args.settle_sec)
            if args.task_instruction not in b.script_request_label.text():
                raise AssertionError("client B did not load task request into script runner")
            if args.expected_stdout not in b.script_editor.toPlainText():
                raise AssertionError("client B did not load suggested script")
            active_request_id = str((b._active_task_request or {}).get("message_id", "")).strip()
            if not active_request_id:
                raise AssertionError("client B has no active task request from client A")

            c.chat_input.setPlainText("background request that must not steal B active script binding")
            c.script_editor.setPlainText("print('BACKGROUND_SHOULD_NOT_RUN')")
            await c.on_send_task_request_clicked()
            await asyncio.sleep(args.settle_sec)
            if not b._latest_task_request or str(b._latest_task_request.get("from_client_id", "")) != client_c:
                raise AssertionError("client B did not receive background client C task request")
            if not b._active_task_request or str(b._active_task_request.get("from_client_id", "")) != args.client_a:
                raise AssertionError("client B active task request was stolen by background peer")
            if args.expected_stdout not in b.script_editor.toPlainText():
                raise AssertionError("client B script editor was overwritten by background peer")

            await b.on_run_local_script_clicked()
            if args.expected_stdout not in b.script_result_text.toPlainText():
                raise AssertionError("client B script result does not include expected stdout")
            if "request_message_id" not in b.script_result_text.toPlainText():
                raise AssertionError("client B script result does not include request binding")
            active_inbound_record_id = b._inbound_task_request_records.get(active_request_id, "")
            active_inbound_record = b._task_records.get(active_inbound_record_id, {})
            if active_inbound_record.get("status") != "ready-to-return":
                raise AssertionError("client B inbound request not ready-to-return before restart")
            await b.shutdown()
            restored_b = MainWindow(
                _desktop_config(
                    args=args,
                    client_id=args.client_b,
                    display_name=f"{args.client_b} restored smoke",
                    conversation_state_path=state_b,
                )
            )
            b = restored_b
            await b.start()
            b.peer_input.setText(args.client_a)
            b.on_add_peer_clicked()
            restored_request = b._latest_task_request_for_peer(args.client_a)
            if not restored_request:
                raise AssertionError("client B did not restore task request after restart")
            b._load_task_request(restored_request, overwrite_script=True)
            if args.expected_stdout not in b.script_result_text.toPlainText():
                raise AssertionError("client B did not restore script result after restart")
            if "request_message_id" not in b.script_result_text.toPlainText():
                raise AssertionError("client B restored script result is missing request binding")
            await b.on_send_last_script_result_clicked()
            await asyncio.sleep(args.settle_sec)

            request_records = [
                record for record in a._task_records.values() if record.get("kind") == "client-task-request"
            ]
            if not request_records:
                raise AssertionError("client A has no client-task-request record")
            latest_request = request_records[-1]
            if latest_request.get("status") != "completed":
                raise AssertionError(f"client A request not completed: {latest_request.get('status')}")
            stdout = latest_request.get("result", {}).get("script_result", {}).get("stdout", "")
            if args.expected_stdout not in stdout:
                raise AssertionError("client A request record is missing returned stdout")

            active_inbound_record_id = b._inbound_task_request_records.get(active_request_id, "")
            latest_inbound = b._task_records.get(active_inbound_record_id, {})
            if not latest_inbound:
                raise AssertionError("client B has no active client-task-inbox record")
            if latest_inbound.get("status") != "returned":
                raise AssertionError(f"client B active inbound request not returned: {latest_inbound.get('status')}")

            report = {
                "ok": True,
                "client_a": args.client_a,
                "client_b": args.client_b,
                "chat_received": True,
                "request_status": latest_request.get("status"),
                "inbound_status": latest_inbound.get("status"),
                "active_request_id": active_request_id,
                "stdout": stdout.strip(),
                "client_a_messages": len(a._conversation_messages),
                "client_b_messages": len(b._conversation_messages),
                "client_a_tasks": len(a._task_records),
                "client_b_tasks": len(b._task_records),
                "background_request_did_not_steal_active_binding": True,
                "midflow_restart_result_restored": True,
            }
            return report
        finally:
            await a.shutdown()
            await b.shutdown()
            await c.shutdown()

    with loop:
        result = loop.run_until_complete(_flow())

    restart_a = MainWindow(
        _desktop_config(
            args=args,
            client_id=args.client_a,
            display_name=f"{args.client_a} restart smoke",
            conversation_state_path=state_a,
        )
    )
    restart_b = MainWindow(
        _desktop_config(
            args=args,
            client_id=args.client_b,
            display_name=f"{args.client_b} restart smoke",
            conversation_state_path=state_b,
        )
    )
    restored_request_records = [
        record for record in restart_a._task_records.values() if record.get("kind") == "client-task-request"
    ]
    active_request_id = str(result.get("active_request_id", "")).strip()
    restored_inbound_record_id = restart_b._inbound_task_request_records.get(active_request_id, "")
    restored_inbound_record = restart_b._task_records.get(restored_inbound_record_id, {})
    if len(restart_a._conversation_messages) != result["client_a_messages"]:
        raise AssertionError("client A restored conversation message count does not match")
    if len(restart_b._conversation_messages) != result["client_b_messages"]:
        raise AssertionError("client B restored conversation message count does not match")
    if not restored_request_records or restored_request_records[-1].get("status") != result["request_status"]:
        raise AssertionError("client A restored request status does not match")
    if not restored_inbound_record or restored_inbound_record.get("status") != result["inbound_status"]:
        raise AssertionError("client B restored inbound status does not match")
    result["restart_state_restored"] = True
    result["restart_client_a_messages"] = len(restart_a._conversation_messages)
    result["restart_client_b_messages"] = len(restart_b._conversation_messages)
    result["restart_request_status"] = restored_request_records[-1].get("status")
    result["restart_inbound_status"] = restored_inbound_record.get("status")
    result["restart_after_return_state_restored"] = True
    return result


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Smoke test local Workflow Desktop clients with a background peer.")
    parser.add_argument("--nats-url", default="nats://127.0.0.1:4222")
    parser.add_argument("--nats-server", default=os.getenv("NATS_SERVER", ""))
    parser.add_argument("--nats-config", default="configs/nats-dev.conf")
    parser.add_argument("--no-start-nats", action="store_true")
    parser.add_argument("--nats-startup-sec", type=float, default=1.0)
    parser.add_argument("--client-a", default="desktop-a")
    parser.add_argument("--client-b", default="desktop-b")
    parser.add_argument("--nodes", default="node-pi")
    parser.add_argument("--qt-platform", default=os.getenv("QT_QPA_PLATFORM", "offscreen"))
    parser.add_argument("--settle-sec", type=float, default=0.6)
    parser.add_argument("--state-dir", default=str(REPO_ROOT / "tmp" / "desktop-smoke-state"))
    parser.add_argument("--keep-state", action="store_true", help="Reuse prior smoke conversation state instead of clearing it.")
    parser.add_argument("--chat-text", default="hello from desktop-a")
    parser.add_argument("--task-instruction", default="run the suggested script and return stdout")
    parser.add_argument("--expected-stdout", default="TWO_DESKTOP_CLIENTS_OK")
    parser.add_argument("--report-path", default="")
    parser.add_argument(
        "--script",
        default="print('TWO_DESKTOP_CLIENTS_OK')",
        help="Python script sent as the suggested script for client B.",
    )
    return parser


def main() -> int:
    parser = build_parser()
    args = parser.parse_args()
    env = os.environ.copy()
    env["PYTHONPATH"] = str(SRC_ROOT)
    env.setdefault("QT_QPA_PLATFORM", args.qt_platform)
    nats_proc = None
    log_files: list[Any] = []
    try:
        nats_proc, log_files = _start_nats(args=args, env=env)
        result = _run_window_flow(args)
        if args.report_path:
            report_path = Path(args.report_path)
            report_path.parent.mkdir(parents=True, exist_ok=True)
            report_path.write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding="utf-8")
        print(json.dumps(result, ensure_ascii=False, indent=2))
        return 0 if result.get("ok") else 1
    except Exception as exc:
        payload = {"ok": False, "error": f"{type(exc).__name__}: {exc}"}
        print(json.dumps(payload, ensure_ascii=False, indent=2), file=sys.stderr)
        if args.report_path:
            report_path = Path(args.report_path)
            report_path.parent.mkdir(parents=True, exist_ok=True)
            report_path.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
        return 1
    finally:
        if nats_proc is not None and nats_proc.poll() is None:
            nats_proc.terminate()
            try:
                nats_proc.wait(timeout=5)
            except Exception:
                nats_proc.kill()
        for fp in log_files:
            fp.close()


if __name__ == "__main__":
    raise SystemExit(main())
