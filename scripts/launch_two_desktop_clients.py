from __future__ import annotations

import argparse
import os
import shlex
import shutil
import signal
import subprocess
import sys
import time
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
SRC_ROOT = REPO_ROOT / "src"


def _find_nats_server(explicit: str = "") -> str:
    if explicit:
        return explicit
    found = shutil.which("nats-server")
    if found:
        return found
    for candidate in (
        Path("/opt/homebrew/opt/nats-server/bin/nats-server"),
        Path("/usr/local/opt/nats-server/bin/nats-server"),
    ):
        if candidate.exists():
            return str(candidate)
    raise FileNotFoundError("nats-server not found. Install it or pass --nats-server.")


def _log_path(name: str) -> Path:
    path = REPO_ROOT / "tmp" / "test-logs" / name
    path.parent.mkdir(parents=True, exist_ok=True)
    return path


def _client_command(
    *,
    python_bin: str,
    client_id: str,
    display_name: str,
    nats_url: str,
    nodes: str,
    poll_interval_sec: float,
    log_level: str,
    state_root: Path,
) -> list[str]:
    state_dir = state_root / client_id
    state_dir.mkdir(parents=True, exist_ok=True)
    return [
        python_bin,
        "-m",
        "workflow_desktop",
        "--client-id",
        client_id,
        "--display-name",
        display_name,
        "--nats-url",
        nats_url,
        "--nodes",
        nodes,
        "--poll-interval-sec",
        str(poll_interval_sec),
        "--settings-path",
        str(state_dir / "settings.json"),
        "--conversation-state-path",
        str(state_dir / "conversations.json"),
        "--mcp-config-path",
        str(state_dir / "mcp-services.json"),
        "--log-level",
        log_level,
        "--log-file",
        str(_log_path(f"{client_id}.app.log")),
    ]


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Launch two visible Workflow Desktop clients locally.")
    parser.add_argument("--python", default=sys.executable)
    parser.add_argument("--nats-url", default="nats://127.0.0.1:4222")
    parser.add_argument("--nats-server", default=os.getenv("NATS_SERVER", ""))
    parser.add_argument("--nats-config", default="configs/nats-dev.conf")
    parser.add_argument("--no-start-nats", action="store_true")
    parser.add_argument("--startup-sec", type=float, default=1.0)
    parser.add_argument("--client-a", default="desktop-a")
    parser.add_argument("--client-b", default="desktop-b")
    parser.add_argument("--display-a", default="Desktop A")
    parser.add_argument("--display-b", default="Desktop B")
    parser.add_argument("--nodes", default="node-pi")
    parser.add_argument("--poll-interval-sec", type=float, default=2.0)
    parser.add_argument("--log-level", default="INFO")
    parser.add_argument("--state-dir", default=str(REPO_ROOT / "tmp" / "desktop-clients"))
    parser.add_argument("--reset-state", action="store_true", help="Remove per-client settings, conversation, and MCP state before launch.")
    parser.add_argument("--dry-run", action="store_true")
    return parser


def _print_command(label: str, command: list[str]) -> None:
    print(f"[{label}] {shlex.join(command)}")


def _reset_client_state(*, state_root: Path, client_ids: tuple[str, str]) -> None:
    for client_id in client_ids:
        state_dir = state_root / client_id
        for name in ("settings.json", "conversations.json", "mcp-services.json"):
            (state_dir / name).unlink(missing_ok=True)


def main() -> int:
    args = build_parser().parse_args()
    env = os.environ.copy()
    env["PYTHONPATH"] = str(SRC_ROOT)
    env.pop("QT_QPA_PLATFORM", None)
    state_root = Path(args.state_dir)
    if args.reset_state:
        _reset_client_state(state_root=state_root, client_ids=(args.client_a, args.client_b))

    commands: list[tuple[str, list[str]]] = []
    if not args.no_start_nats:
        commands.append(("nats", [_find_nats_server(args.nats_server), "-c", args.nats_config]))
    commands.append(
        (
            args.client_a,
            _client_command(
                python_bin=args.python,
                client_id=args.client_a,
                display_name=args.display_a,
                nats_url=args.nats_url,
                nodes=args.nodes,
                poll_interval_sec=max(0.5, args.poll_interval_sec),
                log_level=args.log_level,
                state_root=state_root,
            ),
        )
    )
    commands.append(
        (
            args.client_b,
            _client_command(
                python_bin=args.python,
                client_id=args.client_b,
                display_name=args.display_b,
                nats_url=args.nats_url,
                nodes=args.nodes,
                poll_interval_sec=max(0.5, args.poll_interval_sec),
                log_level=args.log_level,
                state_root=state_root,
            ),
        )
    )

    for label, command in commands:
        _print_command(label, command)
    if args.dry_run:
        return 0

    processes: list[tuple[str, subprocess.Popen, object, object]] = []
    try:
        for index, (label, command) in enumerate(commands):
            stdout = _log_path(f"{label}.launcher.out.log").open("w", encoding="utf-8")
            stderr = _log_path(f"{label}.launcher.err.log").open("w", encoding="utf-8")
            proc = subprocess.Popen(command, cwd=str(REPO_ROOT), stdout=stdout, stderr=stderr, env=env)
            processes.append((label, proc, stdout, stderr))
            time.sleep(args.startup_sec if index == 0 and label == "nats" else 0.4)
            if proc.poll() is not None:
                raise RuntimeError(f"{label} exited early with code {proc.returncode}")
        print("[launcher] running. Press Ctrl+C to stop all child processes.")
        while True:
            time.sleep(1.0)
            for label, proc, _stdout, _stderr in processes:
                if proc.poll() is not None:
                    raise RuntimeError(f"{label} exited with code {proc.returncode}")
    except KeyboardInterrupt:
        print("[launcher] stopping...")
        return 0
    except Exception as exc:
        print(f"[launcher] failed: {exc}", file=sys.stderr)
        return 1
    finally:
        for _label, proc, _stdout, _stderr in reversed(processes):
            if proc.poll() is None:
                try:
                    proc.send_signal(signal.SIGTERM)
                    proc.wait(timeout=5)
                except Exception:
                    proc.kill()
        for _label, _proc, stdout, stderr in processes:
            stdout.close()
            stderr.close()


if __name__ == "__main__":
    raise SystemExit(main())
