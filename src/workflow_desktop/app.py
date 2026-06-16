from __future__ import annotations

import asyncio
import logging
import os
import sys
import traceback
from datetime import datetime
from pathlib import Path

from workflow_desktop.models import DesktopConfig

logger = logging.getLogger(__name__)


def _prepare_windows_dll_paths() -> None:
    """Ensure packaged Qt/PySide6 DLLs are preferred on Windows."""
    if os.name != "nt":
        return

    raw_base = getattr(sys, "_MEIPASS", None)
    if raw_base:
        base = Path(raw_base)
        # In onedir builds, _MEIPASS is usually "<app>\\_internal".
        candidates = [
            base,
            base / "PySide6",
            base / "shiboken6",
            base.parent,
        ]
    else:
        repo_root = Path(__file__).resolve().parents[2]
        candidates = [
            repo_root,
            repo_root / ".venv" / "Lib" / "site-packages" / "PySide6",
            repo_root / ".venv" / "Lib" / "site-packages" / "shiboken6",
        ]

    existing: list[str] = []
    seen: set[str] = set()
    for path in candidates:
        if not path.exists():
            continue
        resolved = str(path.resolve())
        if resolved in seen:
            continue
        seen.add(resolved)
        existing.append(resolved)
        try:
            os.add_dll_directory(resolved)
        except (FileNotFoundError, OSError):
            continue

    if existing:
        current_path = os.environ.get("PATH", "")
        os.environ["PATH"] = ";".join(existing + [current_path]) if current_path else ";".join(existing)


def _resolve_app_icon_path() -> Path | None:
    candidates: list[Path] = []
    bundle_root = getattr(sys, "_MEIPASS", None)
    if bundle_root:
        candidates.append(Path(bundle_root) / "assets" / "icons" / "app-icon.png")
    repo_root = Path(__file__).resolve().parents[2]
    candidates.append(repo_root / "assets" / "icons" / "app-icon.png")
    for path in candidates:
        if path.exists():
            return path
    return None


def _write_crash_log(message: str) -> None:
    try:
        crash_dir = Path.home() / ".workflow-desktop" / "crash-logs"
        crash_dir.mkdir(parents=True, exist_ok=True)
        ts = datetime.now().strftime("%Y%m%d_%H%M%S")
        path = crash_dir / f"desktop-crash-{ts}.log"
        path.write_text(message, encoding="utf-8")
    except Exception:
        logger.exception("failed to write crash log")


def _install_crash_handlers(loop: asyncio.AbstractEventLoop) -> None:
    def _excepthook(exc_type, exc_value, exc_tb) -> None:  # type: ignore[no-untyped-def]
        text = "".join(traceback.format_exception(exc_type, exc_value, exc_tb))
        logger.error("unhandled exception:\n%s", text)
        _write_crash_log(text)

    def _loop_exception_handler(_loop: asyncio.AbstractEventLoop, context: dict) -> None:
        exc = context.get("exception")
        if exc is not None:
            text = "".join(traceback.format_exception(type(exc), exc, exc.__traceback__))
        else:
            text = str(context)
        logger.error("asyncio exception: %s", text)
        _write_crash_log(text)

    sys.excepthook = _excepthook
    loop.set_exception_handler(_loop_exception_handler)


def run_desktop_app(config: DesktopConfig) -> int:
    _prepare_windows_dll_paths()
    try:
        from PySide6.QtGui import QIcon
        from PySide6.QtWidgets import QApplication, QMenu, QStyle, QSystemTrayIcon
    except ImportError as exc:  # pragma: no cover
        raise RuntimeError(
            f"PySide6 import failed: {exc}. Install with: pip install -e '.[desktop]'"
        ) from exc
    try:
        from qasync import QEventLoop
    except ImportError as exc:  # pragma: no cover
        raise RuntimeError(
            f"qasync import failed: {exc}. Install with: pip install -e '.[desktop]'"
        ) from exc
    from workflow_desktop.main_window import MainWindow

    app = QApplication(sys.argv)
    icon_path = _resolve_app_icon_path()
    if icon_path is not None:
        app_icon = QIcon(str(icon_path))
        if not app_icon.isNull():
            app.setWindowIcon(app_icon)
    loop = QEventLoop(app)
    asyncio.set_event_loop(loop)
    _install_crash_handlers(loop)
    window = MainWindow(config)
    tray: QSystemTrayIcon | None = None
    tray_menu: QMenu | None = None
    if QSystemTrayIcon.isSystemTrayAvailable():
        tray = QSystemTrayIcon(app)
        tray.setToolTip("AgSwarm")
        tray_icon = app.windowIcon()
        if tray_icon.isNull():
            tray_icon = app.style().standardIcon(QStyle.StandardPixmap.SP_ComputerIcon)
        tray.setIcon(tray_icon)
        window.setWindowIcon(tray_icon)
        tray_menu = QMenu()
        show_action = tray_menu.addAction("Show Window")
        quit_action = tray_menu.addAction("Quit")
        show_action.triggered.connect(window.show_from_tray)
        quit_action.triggered.connect(window.request_exit_from_tray)

        def _on_tray_activated(reason: QSystemTrayIcon.ActivationReason) -> None:
            if reason in (
                QSystemTrayIcon.ActivationReason.Trigger,
                QSystemTrayIcon.ActivationReason.DoubleClick,
            ):
                window.show_from_tray()

        tray.activated.connect(_on_tray_activated)
        tray.setContextMenu(tray_menu)
        tray.show()
        window.enable_tray(True)
    else:
        logger.warning("system tray is not available on this platform/session")
        window.enable_tray(False)
    window.show()

    stop_event = asyncio.Event()
    app.aboutToQuit.connect(lambda: stop_event.set())

    async def _runner() -> None:
        await window.start()
        await stop_event.wait()
        logger.info("desktop shutdown requested")
        await window.shutdown()
        if tray is not None:
            tray.hide()

    with loop:
        loop.run_until_complete(_runner())
    return 0
