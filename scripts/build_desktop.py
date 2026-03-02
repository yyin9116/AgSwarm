from __future__ import annotations

import argparse
import os
import shutil
import subprocess
import sys
from pathlib import Path


def _run(cmd: list[str]) -> None:
    print(">", " ".join(cmd))
    subprocess.run(cmd, check=True)


def _artifact_name(base_name: str) -> str:
    if sys.platform.startswith("win"):
        return f"{base_name}-windows-x64"
    if sys.platform == "darwin":
        # GitHub macOS runner is arm64 on macos-14, x64 on some older images.
        arch = os.uname().machine
        return f"{base_name}-macos-{arch}"
    return f"{base_name}-linux"


def _create_zip(*, root_dir: Path, base_dir: str, output_base: Path) -> Path:
    archive = shutil.make_archive(str(output_base), "zip", root_dir=str(root_dir), base_dir=base_dir)
    return Path(archive)


def _create_dmg(*, app_path: Path, output_path: Path, volume_name: str) -> Path:
    if sys.platform != "darwin":
        raise RuntimeError("dmg build is only supported on macOS")
    create_dmg_bin = shutil.which("create-dmg")
    if create_dmg_bin:
        try:
            cmd = [
                create_dmg_bin,
                "--volname",
                volume_name,
                "--window-pos",
                "200",
                "120",
                "--window-size",
                "800",
                "420",
                "--icon-size",
                "100",
                "--icon",
                app_path.name,
                "220",
                "190",
                "--hide-extension",
                app_path.name,
                "--app-drop-link",
                "580",
                "190",
                str(output_path),
                str(app_path.parent),
            ]
            _run(cmd)
            return output_path
        except subprocess.CalledProcessError:
            print("create-dmg failed, fallback to hdiutil")

    cmd = [
        "hdiutil",
        "create",
        "-volname",
        volume_name,
        "-srcfolder",
        str(app_path),
        "-ov",
        "-format",
        "UDZO",
        str(output_path),
    ]
    _run(cmd)
    return output_path


def main() -> int:
    parser = argparse.ArgumentParser(description="Build workflow desktop app with PyInstaller")
    parser.add_argument("--name", default="workflow-desktop")
    parser.add_argument("--clean", action="store_true")
    parser.add_argument("--entry", default="src/workflow_desktop/__main__.py")
    parser.add_argument(
        "--dmg",
        action="store_true",
        help="Create macOS .dmg package.",
    )
    parser.add_argument(
        "--no-dmg",
        action="store_true",
        help="Disable macOS .dmg generation (default is enabled on macOS).",
    )
    parser.add_argument(
        "--no-zip",
        action="store_true",
        help="Skip .zip artifact generation.",
    )
    args = parser.parse_args()

    root = Path(__file__).resolve().parent.parent
    os.chdir(root)

    if args.clean:
        shutil.rmtree(root / "build", ignore_errors=True)
        shutil.rmtree(root / "dist", ignore_errors=True)
        shutil.rmtree(root / "dist-artifacts", ignore_errors=True)
        spec_file = root / f"{args.name}.spec"
        if spec_file.exists():
            spec_file.unlink()

    cmd = [
        sys.executable,
        "-m",
        "PyInstaller",
        "--noconfirm",
        "--windowed",
        "--name",
        args.name,
        "--paths",
        "src",
        "--collect-submodules",
        "workflow_control_client",
        "--collect-submodules",
        "workflow_transport",
        "--collect-submodules",
        "workflow_node_daemon",
        "--collect-submodules",
        "workflow_runtime",
        "--collect-submodules",
        "workflow_desktop",
        "--collect-submodules",
        "qasync",
        "--collect-all",
        "PySide6",
        "--hidden-import",
        "PySide6.QtCore",
        "--hidden-import",
        "PySide6.QtGui",
        "--hidden-import",
        "PySide6.QtWidgets",
        args.entry,
    ]
    _run(cmd)

    dist_dir = root / "dist"
    out_dir = root / "dist-artifacts"
    out_dir.mkdir(parents=True, exist_ok=True)
    artifact_base = _artifact_name(args.name)
    archive_base_path = out_dir / artifact_base
    outputs: list[Path] = []
    create_zip = not args.no_zip
    create_dmg = (sys.platform == "darwin") and (args.dmg or (not args.no_dmg))

    if sys.platform == "darwin":
        app_path = dist_dir / f"{args.name}.app"
        if not app_path.exists():
            raise FileNotFoundError(f"Expected app bundle not found: {app_path}")
        if create_zip:
            outputs.append(_create_zip(root_dir=dist_dir, base_dir=f"{args.name}.app", output_base=archive_base_path))
        if create_dmg:
            dmg_path = out_dir / f"{artifact_base}.dmg"
            outputs.append(_create_dmg(app_path=app_path, output_path=dmg_path, volume_name=args.name))
    else:
        exe_dir = dist_dir / args.name
        if not exe_dir.exists():
            raise FileNotFoundError(f"Expected output directory not found: {exe_dir}")
        if create_zip:
            outputs.append(_create_zip(root_dir=dist_dir, base_dir=args.name, output_base=archive_base_path))

    if not outputs:
        raise RuntimeError("No build artifact generated. Check options --no-zip/--dmg.")

    print("Build artifacts created:")
    for path in outputs:
        print(f" - {path}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
