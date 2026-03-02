from __future__ import annotations

import asyncio
import logging
import sys

from workflow_desktop.models import DesktopConfig

logger = logging.getLogger(__name__)


def run_desktop_app(config: DesktopConfig) -> int:
    try:
        from PySide6.QtWidgets import QApplication, QMenu, QStyle, QSystemTrayIcon
    except ImportError as exc:  # pragma: no cover
        raise RuntimeError(
            "PySide6 is not installed. Install with: pip install -e '.[desktop]'"
        ) from exc
    try:
        from qasync import QEventLoop
    except ImportError as exc:  # pragma: no cover
        raise RuntimeError(
            "qasync is not installed. Install with: pip install -e '.[desktop]'"
        ) from exc
    from workflow_desktop.main_window import MainWindow

    app = QApplication(sys.argv)
    loop = QEventLoop(app)
    asyncio.set_event_loop(loop)
    window = MainWindow(config)
    tray: QSystemTrayIcon | None = None
    tray_menu: QMenu | None = None
    if QSystemTrayIcon.isSystemTrayAvailable():
        tray = QSystemTrayIcon(app)
        tray.setToolTip("Workflow Desktop")
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
