from __future__ import annotations

import argparse
import os
import platform
import shutil
import subprocess
import sys
import tarfile
import time
import urllib.request
import zipfile
from pathlib import Path


def _nats_asset(version: str) -> tuple[str, str]:
    system = platform.system().lower()
    machine = platform.machine().lower()
    if system == "windows":
        arch = "amd64" if "64" in machine else "386"
        ext = "zip"
        name = f"nats-server-v{version}-windows-{arch}.{ext}"
    elif system == "darwin":
        arch = "arm64" if "arm" in machine or "aarch64" in machine else "amd64"
        ext = "zip"
        name = f"nats-server-v{version}-darwin-{arch}.{ext}"
    else:
        arch = "amd64" if "64" in machine else "386"
        ext = "tar.gz"
        name = f"nats-server-v{version}-linux-{arch}.{ext}"
    url = f"https://github.com/nats-io/nats-server/releases/download/v{version}/{name}"
    return name, url


def _ensure_nats_server(version: str, tools_dir: Path) -> Path:
    tools_dir.mkdir(parents=True, exist_ok=True)
    exe_name = "nats-server.exe" if os.name == "nt" else "nats-server"
    target_exe = tools_dir / exe_name
    if target_exe.exists():
        return target_exe

    asset_name, url = _nats_asset(version)
    archive_path = tools_dir / asset_name
    print(f"[phase2] downloading nats-server: {url}")
    urllib.request.urlretrieve(url, archive_path)

    extract_root = tools_dir / f"nats-server-v{version}"
    extract_root.mkdir(parents=True, exist_ok=True)
    if archive_path.suffix == ".zip":
        with zipfile.ZipFile(archive_path, "r") as zf:
            zf.extractall(extract_root)
    else:
        with tarfile.open(archive_path, "r:gz") as tf:
            tf.extractall(extract_root)

    found = list(extract_root.rglob(exe_name))
    if not found:
        raise FileNotFoundError(f"failed to find {exe_name} after extracting {archive_path}")
    shutil.copy2(found[0], target_exe)
    if os.name != "nt":
        target_exe.chmod(0o755)
    return target_exe


def _open_log(path: Path):
    path.parent.mkdir(parents=True, exist_ok=True)
    return path.open("w", encoding="utf-8")


def main() -> int:
    parser = argparse.ArgumentParser(description="Run local Phase-2 baseline (nats + node + regression).")
    parser.add_argument("--nats-url", default="nats://127.0.0.1:4222")
    parser.add_argument("--node-id", default="node-a")
    parser.add_argument("--python", default=sys.executable, help="Python executable used for workflow_cli and scripts.")
    parser.add_argument("--nats-version", default="2.11.0")
    parser.add_argument("--repeat", type=int, default=5)
    parser.add_argument("--repeat-interval-sec", type=float, default=0.2)
    parser.add_argument("--pass-rate-threshold", type=float, default=0.9)
    parser.add_argument("--skip-latex", action="store_true", help="Skip latex scenario.")
    parser.add_argument("--with-latex", action="store_true", help="Enable latex scenario (overrides --skip-latex).")
    parser.add_argument("--report-path", default="", help="Optional explicit report path.")
    args = parser.parse_args()

    root = Path(__file__).resolve().parent.parent
    tools_dir = root / "tools" / "nats-server"
    logs_dir = root / "tmp" / "test-logs"
    nats_out = _open_log(logs_dir / "phase2.nats.out.log")
    nats_err = _open_log(logs_dir / "phase2.nats.err.log")
    node_out = _open_log(logs_dir / "phase2.node.out.log")
    node_err = _open_log(logs_dir / "phase2.node.err.log")

    env = os.environ.copy()
    env["PYTHONPATH"] = str(root / "src")
    nats_proc = None
    node_proc = None
    try:
        nats_exe = _ensure_nats_server(args.nats_version, tools_dir)
        nats_proc = subprocess.Popen(
            [str(nats_exe), "-a", "127.0.0.1", "-p", "4222"],
            cwd=str(root),
            stdout=nats_out,
            stderr=nats_err,
            env=env,
        )
        time.sleep(1.2)
        node_proc = subprocess.Popen(
            [
                args.python,
                "-m",
                "workflow_cli",
                "node",
                "--node-id",
                args.node_id,
                "--nats-url",
                args.nats_url,
            ],
            cwd=str(root),
            stdout=node_out,
            stderr=node_err,
            env=env,
        )
        time.sleep(2.0)

        report_path = args.report_path
        if not report_path:
            ts = time.strftime("%Y%m%d_%H%M%S")
            report_path = str(root / "tmp" / "test-reports" / f"phase2_local_baseline_{ts}.json")
        cmd = [
            args.python,
            "scripts/regression_mac_win.py",
            "--nats-url",
            args.nats_url,
            "--node-id",
            args.node_id,
            "--repeat",
            str(max(1, args.repeat)),
            "--repeat-interval-sec",
            str(max(0.0, args.repeat_interval_sec)),
            "--pass-rate-threshold",
            str(args.pass_rate_threshold),
            "--report-path",
            report_path,
        ]
        if args.skip_latex and not args.with_latex:
            cmd.append("--skip-latex")
        print("[phase2] running:", " ".join(cmd))
        completed = subprocess.run(cmd, cwd=str(root), env=env, check=False)
        print(f"[phase2] report: {report_path}")
        print(f"[phase2] regression exit code: {completed.returncode}")
        return completed.returncode
    finally:
        if node_proc is not None and node_proc.poll() is None:
            node_proc.terminate()
            try:
                node_proc.wait(timeout=5)
            except Exception:
                node_proc.kill()
        if nats_proc is not None and nats_proc.poll() is None:
            nats_proc.terminate()
            try:
                nats_proc.wait(timeout=5)
            except Exception:
                nats_proc.kill()
        for fp in (nats_out, nats_err, node_out, node_err):
            fp.close()


if __name__ == "__main__":
    raise SystemExit(main())
