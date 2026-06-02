from __future__ import annotations

import asyncio
import hashlib
import json
import logging
import os
import shlex
import shutil
import sys
from datetime import datetime
from pathlib import Path
from time import monotonic
from typing import Any
from urllib.parse import urlsplit

from PySide6.QtCore import QSize, Qt, QUrl
from PySide6.QtGui import QColor, QDesktopServices, QGuiApplication, QPixmap
from PySide6.QtWidgets import (
    QComboBox,
    QFileDialog,
    QFormLayout,
    QGridLayout,
    QGroupBox,
    QHBoxLayout,
    QHeaderView,
    QLabel,
    QLineEdit,
    QListWidget,
    QListWidgetItem,
    QMainWindow,
    QMessageBox,
    QPushButton,
    QPlainTextEdit,
    QScrollArea,
    QFrame,
    QSplitter,
    QTableWidget,
    QTableWidgetItem,
    QTabWidget,
    QVBoxLayout,
    QWidget,
)
from qasync import asyncSlot

from workflow_desktop.conversation_store import load_conversation_state, save_conversation_state
from workflow_desktop.mcp_store import load_mcp_services, save_mcp_services
from workflow_desktop.i18n import LANGUAGE_LABELS, SUPPORTED_LANGS, normalize_language, translate_text
from workflow_desktop.config_sync import CONFLICT_POLICY_OPTIONS, decide_sync_action
from workflow_desktop.models import DesktopConfig, McpServiceConfig, default_conversation_state_path
from workflow_desktop.service import DesktopControlService
from workflow_desktop.settings_store import load_settings, save_settings
from workflow_desktop.updater import UpdateInfo, check_for_update, current_app_version
from workflow_discovery import (
    DISCOVERY_PORT_DEFAULT,
    DiscoveredNode,
    LanNodeListener,
    is_loopback_nats_url,
)
from workflow_runtime.error_codes import ERROR_CODE_LABELS, build_error_summary, extract_error_code, extract_error_message

logger = logging.getLogger(__name__)

PATH_KEYS = {
    "saved_path",
    "pdf_path",
    "preview_image_path",
    "image_path",
    "log_path",
    "output_path",
    "output_dir",
}

MAX_NOTIFICATIONS = 500
NOTIFICATION_DEDUPE_WINDOW_SEC = 12.0
NOTIFICATION_RECENT_PRUNE_SEC = 1800.0
MIN_NOTIFICATION_CAPACITY = 50
MAX_NOTIFICATION_CAPACITY = 5000
DISCOVERY_MAX_AGE_SEC_DEFAULT = 8.0
RETRY_BATCH_MAX_LIMIT_DEFAULT = 20
RETRY_BATCH_INTERVAL_SEC_DEFAULT = 0.2
RETRY_BATCH_SKIP_KINDS_DEFAULT = {"download_file", "download_dir"}
RETRY_BATCH_SUPPORTED_KINDS = {"echo", "latex", "upload", "download_file", "download_dir"}
RETRY_REROUTE_MODE_DEFAULT = "off"
RETRY_REROUTE_MODE_OPTIONS = ("off", "echo_only", "echo_upload", "all_supported")
CONFIG_SYNC_CONFLICT_POLICY_DEFAULT = "desktop_wins"
CONFIG_SYNC_CONFLICT_POLICY_OPTIONS = CONFLICT_POLICY_OPTIONS
RETRY_ATTEMPTS_PER_TASK_DEFAULT = 2
RETRY_BACKOFF_BASE_SEC_DEFAULT = 0.8
UPDATE_FEED_URL_DEFAULT = os.getenv("WORKFLOW_UPDATE_FEED_URL", "").strip()
DEFAULT_DESKTOP_LOG_FILE = str(Path.home() / ".workflow-desktop" / "logs" / "desktop.app.log")
CONNECT_TIMEOUT_SEC = 8.0
if sys.platform == "darwin":
    UPDATE_ASSET_PATTERN_DEFAULT = "*macos-*.dmg"
elif os.name == "nt":
    UPDATE_ASSET_PATTERN_DEFAULT = "*windows-*.zip"
else:
    UPDATE_ASSET_PATTERN_DEFAULT = "*.zip"


class MainWindow(QMainWindow):
    def __init__(self, config: DesktopConfig) -> None:
        super().__init__()
        self.config = config
        self.service = DesktopControlService(client_id=config.client_id, nats_url=config.nats_url)
        self._running = False
        self._poll_task: asyncio.Task[None] | None = None
        self._discovery_listener: LanNodeListener | None = None
        self._discovered_nodes: dict[str, DiscoveredNode] = {}
        self._discovery_auto_switch_last_attempt: str | None = None
        self._task_index = 0
        self._task_records: dict[str, dict[str, Any]] = {}
        self._task_order: list[str] = []
        self._latest_failed_record_id: str | None = None
        self._latest_failed_context: dict[str, Any] | None = None
        self._notification_index = 0
        self._notifications: list[dict[str, Any]] = []
        self._notification_recent: dict[str, tuple[float, str]] = {}
        self._syncing_notification_selection = False
        self._history_filter = ""
        self._mcp_services: list[McpServiceConfig] = []
        self._last_snapshots: list[tuple[str, dict | None]] = []
        self._client_peers: dict[str, dict[str, Any]] = {}
        self._conversation_messages: list[dict[str, Any]] = []
        self._conversation_message_ids: set[str] = set()
        self._peer_read_cursors: dict[str, str] = {}
        self._syncing_peer_selection = False
        self._selected_peer_id = ""
        self._latest_task_request: dict[str, Any] | None = None
        self._active_task_request: dict[str, Any] | None = None
        self._task_request_records: dict[str, str] = {}
        self._inbound_task_request_records: dict[str, str] = {}
        self._last_script_result: dict[str, Any] | None = None
        self._last_script_result_request_id = ""
        self._script_loaded_request_id = ""
        self._script_loaded_text = ""
        self._syncing_artifact_selection = False
        self._notification_max_items = MAX_NOTIFICATIONS
        self._notification_dedupe_window_sec = NOTIFICATION_DEDUPE_WINDOW_SEC
        self._notification_auto_mark_read = True
        self._retry_batch_max_limit = RETRY_BATCH_MAX_LIMIT_DEFAULT
        self._retry_batch_interval_sec = RETRY_BATCH_INTERVAL_SEC_DEFAULT
        self._retry_batch_skip_kinds: set[str] = set(RETRY_BATCH_SKIP_KINDS_DEFAULT)
        self._retry_reroute_mode = RETRY_REROUTE_MODE_DEFAULT
        self._retry_attempts_per_task = RETRY_ATTEMPTS_PER_TASK_DEFAULT
        self._retry_backoff_base_sec = RETRY_BACKOFF_BASE_SEC_DEFAULT
        self._current_version = current_app_version()
        self._update_enabled = True
        self._update_feed_url = UPDATE_FEED_URL_DEFAULT
        self._update_asset_pattern = UPDATE_ASSET_PATTERN_DEFAULT
        self._update_check_on_start = True
        self._tray_enabled = False
        self._tray_force_close = False
        self._tray_hide_hint_shown = False
        if not self.config.conversation_state_path:
            self.config.conversation_state_path = default_conversation_state_path(self.config.client_id)
        self._display_name = self.config.display_name.strip() or self.config.client_id
        self._discovery_enabled = bool(config.discovery_enabled)
        self._discovery_port = max(1, int(config.discovery_port or DISCOVERY_PORT_DEFAULT))
        self._discovery_max_age_sec = max(2.0, float(config.discovery_max_age_sec or DISCOVERY_MAX_AGE_SEC_DEFAULT))
        self._discovery_auto_switch_nats = bool(config.discovery_auto_switch_nats)
        self._language = normalize_language(config.language)
        self._config_sync_enabled = bool(config.config_sync_enabled)
        self._config_sync_interval_sec = max(5.0, float(config.config_sync_interval_sec or 30.0))
        self._config_sync_last_run_monotonic = 0.0
        self._config_sync_last_digest = ""
        self._config_sync_node_digest: dict[str, str] = {}
        self._config_sync_retry_after: dict[str, float] = {}
        policy = str(config.config_sync_conflict_policy or CONFIG_SYNC_CONFLICT_POLICY_DEFAULT).strip().lower()
        self._config_sync_conflict_policy = (
            policy if policy in CONFIG_SYNC_CONFLICT_POLICY_OPTIONS else CONFIG_SYNC_CONFLICT_POLICY_DEFAULT
        )
        self._connection_state = "disconnected"
        self._last_connection_error = ""

        self.setWindowTitle(f"AgSwarm Client - {self._display_name}")
        self.resize(1460, 900)
        self.setMinimumSize(1180, 760)

        root = QWidget()
        self.setCentralWidget(root)
        outer = QVBoxLayout(root)
        outer.setContentsMargins(22, 18, 22, 18)
        outer.setSpacing(12)

        header = QWidget()
        header.setObjectName("appHeader")
        header_layout = QHBoxLayout(header)
        header_layout.setContentsMargins(0, 0, 0, 0)
        header_layout.setSpacing(12)
        self.app_icon_label = QLabel("A")
        self.app_icon_label.setObjectName("appIcon")
        self.app_icon_label.setAlignment(Qt.AlignCenter)
        header_layout.addWidget(self.app_icon_label)
        title_col = QVBoxLayout()
        title_col.setContentsMargins(0, 0, 0, 0)
        title_col.setSpacing(2)
        self.title_label = QLabel(f"AgSwarm Client | {self._display_name}")
        self.subtitle_label = QLabel("Ask me to orchestrate tasks across your devices.")
        title_col.addWidget(self.title_label)
        title_col.addWidget(self.subtitle_label)
        header_layout.addLayout(title_col, 1)
        header_layout.addWidget(self._build_top_status_bar(), 2)
        outer.addWidget(header)
        self.tabs = QTabWidget()
        self.tabs.setDocumentMode(True)
        self.tabs.setTabPosition(QTabWidget.South)
        self.tabs.setUsesScrollButtons(False)
        outer.addWidget(self.tabs, 1)
        self._tab_titles = [
            "Copilot",
            "Devices",
            "Task Detail",
            "Files",
            "Activity",
            "Alerts",
            "MCP Config",
            "Settings",
        ]
        self.tabs.addTab(self._build_conversation_tab(), self._tab_titles[0])
        self.tabs.addTab(self._build_task_center_tab(), self._tab_titles[1])
        self.tabs.addTab(self._build_task_detail_tab(), self._tab_titles[2])
        self.tabs.addTab(self._build_results_tab(), self._tab_titles[3])
        self.tabs.addTab(self._build_history_tab(), self._tab_titles[4])
        self.tabs.addTab(self._build_notifications_tab(), self._tab_titles[5])
        self.tabs.addTab(self._build_mcp_tab(), self._tab_titles[6])
        self.tabs.addTab(self._build_settings_tab(), self._tab_titles[7])
        self._apply_prototype_styles()

        self._refresh_header()
        self._load_conversation_state()
        self._load_settings_into_ui()
        if self.service.nats_url != self.config.nats_url:
            self.service = DesktopControlService(client_id=self.config.client_id, nats_url=self.config.nats_url)
        self._load_mcp_services()
        self._apply_language()
        self.statusBar().showMessage("Ready", 5000)

    def _refresh_header(self) -> None:
        configured = len(self._iter_node_candidates())
        online = sum(1 for _, snap in self._last_snapshots if snap is not None)
        lan_seen = len(self._discovered_nodes)
        runtime = "running" if self._running else "ready"
        conn = self._connection_state
        self.status_left_label.setText(
            "Controller: "
            f"{self.config.client_id} | Connection: {conn} | "
            f"Network: {online}/{configured} online | LAN discovered: {lan_seen} | Runtime: {runtime}"
        )
        self.status_right_label.setText(f"Last sync {datetime.now().strftime('%H:%M:%S')}")

    def _tr(self, text: str) -> str:
        return translate_text(text, self._language)

    def _apply_language(self) -> None:
        self.setWindowTitle("AgSwarm Client")
        self.title_label.setText(self._tr("AgSwarm Client"))
        self.subtitle_label.setText(self._tr("Ask me to orchestrate tasks across your devices."))
        for i, title in enumerate(getattr(self, "_tab_titles", [])):
            if i < self.tabs.count():
                self.tabs.setTabText(i, self._tr(title))
        for group in self.findChildren(QGroupBox):
            title = group.title().strip()
            if title:
                group.setTitle(self._tr(title))
        for label in self.findChildren(QLabel):
            text = label.text().strip()
            if text:
                label.setText(self._tr(text))
        for button in self.findChildren(QPushButton):
            text = button.text().strip()
            if text:
                button.setText(self._tr(text))
        self._update_settings_path_label()
        self._refresh_header()

    def _update_settings_path_label(self) -> None:
        if hasattr(self, "settings_path_label"):
            self.settings_path_label.setText(f"{self._tr('Settings path')}: {self.config.settings_path}")

    def _build_top_status_bar(self) -> QWidget:
        bar = QWidget()
        row = QHBoxLayout(bar)
        row.setContentsMargins(0, 0, 0, 0)
        self.status_left_label = QLabel()
        self.status_right_label = QLabel()
        row.addWidget(self.status_left_label, 1)
        row.addWidget(self.status_right_label)
        return bar

    def _build_conversation_tab(self) -> QWidget:
        page = QWidget()
        layout = QVBoxLayout(page)
        split = QSplitter(Qt.Horizontal)
        layout.addWidget(split, 1)

        peers_box = QGroupBox("Devices")
        peers_layout = QVBoxLayout(peers_box)
        self.peer_input = QLineEdit()
        self.peer_input.setPlaceholderText("target device/client id, e.g. desktop-b")
        peers_layout.addWidget(self.peer_input)
        peer_row = QHBoxLayout()
        add_peer = QPushButton("Add Device")
        add_peer.clicked.connect(self.on_add_peer_clicked)
        peer_row.addWidget(add_peer)
        announce = QPushButton("Announce")
        announce.clicked.connect(self.on_announce_presence_clicked)
        peer_row.addWidget(announce)
        peers_layout.addLayout(peer_row)
        self.peers_list = QListWidget()
        self.peers_list.itemSelectionChanged.connect(self.on_peer_selection_changed)
        peers_layout.addWidget(self.peers_list, 1)
        split.addWidget(peers_box)

        conversation_box = QGroupBox("Agent Copilot")
        conversation_layout = QVBoxLayout(conversation_box)
        self.conversation_title = QLabel("Select or add a device.")
        self.conversation_title.setObjectName("queueTitle")
        conversation_layout.addWidget(self.conversation_title)
        self.conversation_summary_label = QLabel("No device conversation selected.")
        self.conversation_summary_label.setWordWrap(True)
        conversation_layout.addWidget(self.conversation_summary_label)
        self.conversation_list = QListWidget()
        self.conversation_list.itemSelectionChanged.connect(self.on_conversation_selection_changed)
        conversation_layout.addWidget(self.conversation_list, 1)
        self.chat_input = QPlainTextEdit()
        self.chat_input.setPlaceholderText("Ask AgSwarm to send a message, run a task, or return a file...")
        self.chat_input.setFixedHeight(90)
        conversation_layout.addWidget(self.chat_input)
        action_row = QHBoxLayout()
        send_message = QPushButton("Send Message")
        send_message.clicked.connect(self.on_send_chat_clicked)
        action_row.addWidget(send_message)
        send_task = QPushButton("Request Task")
        send_task.setObjectName("dispatchPrimary")
        send_task.clicked.connect(self.on_send_task_request_clicked)
        action_row.addWidget(send_task)
        load_task = QPushButton("Use Latest Request")
        load_task.clicked.connect(self.on_use_latest_task_request_clicked)
        action_row.addWidget(load_task)
        action_row.addStretch(1)
        conversation_layout.addLayout(action_row)
        split.addWidget(conversation_box)

        task_box = QGroupBox("Incoming Task")
        task_layout = QVBoxLayout(task_box)
        self.script_request_label = QLabel("No task request selected.")
        self.script_request_label.setWordWrap(True)
        task_layout.addWidget(self.script_request_label)
        self.script_editor = QPlainTextEdit()
        self.script_editor.setPlaceholderText("write Python script for the selected request")
        task_layout.addWidget(self.script_editor, 2)
        script_row = QHBoxLayout()
        run_script = QPushButton("Run Script")
        run_script.setObjectName("dispatchPrimary")
        run_script.clicked.connect(self.on_run_local_script_clicked)
        script_row.addWidget(run_script)
        send_result = QPushButton("Send Last Result")
        send_result.clicked.connect(self.on_send_last_script_result_clicked)
        script_row.addWidget(send_result)
        script_row.addStretch(1)
        task_layout.addLayout(script_row)
        self.script_result_text = QPlainTextEdit()
        self.script_result_text.setReadOnly(True)
        task_layout.addWidget(self.script_result_text, 1)
        split.addWidget(task_box)
        split.setSizes([320, 760, 560])
        return page

    def _build_task_center_tab(self) -> QWidget:
        page = QWidget()
        layout = QVBoxLayout(page)
        split = QSplitter(Qt.Horizontal)
        layout.addWidget(split, 1)
        split.addWidget(self._wrap_scroll_container(self._build_left_panel()))
        split.addWidget(self._wrap_scroll_container(self._build_center_panel()))
        split.addWidget(self._wrap_scroll_container(self._build_queue_artifacts_column()))
        split.setSizes([380, 940, 620])
        return page

    def _wrap_scroll_container(self, content: QWidget) -> QWidget:
        scroll = QScrollArea()
        scroll.setWidgetResizable(True)
        scroll.setFrameShape(QFrame.NoFrame)
        scroll.setHorizontalScrollBarPolicy(Qt.ScrollBarAsNeeded)
        scroll.setVerticalScrollBarPolicy(Qt.ScrollBarAsNeeded)
        scroll.setWidget(content)
        return scroll

    def _build_queue_artifacts_column(self) -> QWidget:
        box = QGroupBox("Activity and Files")
        box.setObjectName("queueColumn")
        layout = QVBoxLayout(box)
        layout.addWidget(self._build_right_panel(), 3)

        artifacts = QGroupBox("Returned Files")
        artifacts_layout = QVBoxLayout(artifacts)
        self.queue_hint_label = QLabel("Live progress, retries, outputs and returned files")
        self.queue_hint_label.setObjectName("queueHint")
        layout.addWidget(self.queue_hint_label)
        self.quick_artifact_list = QListWidget()
        self.quick_artifact_list.itemSelectionChanged.connect(self.on_quick_artifact_selection_changed)
        artifacts_layout.addWidget(self.quick_artifact_list, 1)
        quick_row = QHBoxLayout()
        quick_open = QPushButton("Open")
        quick_open.clicked.connect(self.on_open_result_path)
        quick_row.addWidget(quick_open)
        quick_copy = QPushButton("Copy Path")
        quick_copy.clicked.connect(self.on_copy_result_path)
        quick_row.addWidget(quick_copy)
        quick_download = QPushButton("Download")
        quick_download.clicked.connect(self.on_download_result_clicked)
        quick_row.addWidget(quick_download)
        artifacts_layout.addLayout(quick_row)
        layout.addWidget(artifacts, 2)

        quick_ops = QGroupBox("Developer Tools")
        quick_ops_layout = QVBoxLayout(quick_ops)
        self.rerun_btn = QPushButton("Re-run Selected Task")
        self.rerun_btn.clicked.connect(self.on_rerun_selected_task_clicked)
        quick_ops_layout.addWidget(self.rerun_btn)
        self.export_events_btn = QPushButton("Export Event Stream (.ndjson)")
        self.export_events_btn.clicked.connect(self.on_export_event_stream_clicked)
        quick_ops_layout.addWidget(self.export_events_btn)
        retry_batch_row = QHBoxLayout()
        self.retry_batch_kind_filter = QComboBox()
        self.retry_batch_kind_filter.addItems(["all", "echo", "latex", "upload", "download_file", "download_dir"])
        retry_batch_row.addWidget(self.retry_batch_kind_filter)
        self.retry_batch_error_code_input = QLineEdit()
        self.retry_batch_error_code_input.setPlaceholderText("error code filter (optional)")
        retry_batch_row.addWidget(self.retry_batch_error_code_input, 1)
        self.retry_batch_limit_input = QLineEdit("3")
        self.retry_batch_limit_input.setPlaceholderText("limit")
        retry_batch_row.addWidget(self.retry_batch_limit_input)
        quick_ops_layout.addLayout(retry_batch_row)
        self.retry_batch_btn = QPushButton("Retry Failed Batch")
        self.retry_batch_btn.clicked.connect(self.on_retry_failed_batch_clicked)
        quick_ops_layout.addWidget(self.retry_batch_btn)
        quick_ops_hint = QLabel(
            "- Open artifact folder\n"
            "- Copy artifact path\n"
            "- Re-run task with same inputs\n"
            "- Batch retry failed tasks (strategy from Settings)\n"
            "- Export event stream (.ndjson)"
        )
        quick_ops_hint.setObjectName("queueBody")
        quick_ops_layout.addWidget(quick_ops_hint)
        layout.addWidget(quick_ops)
        return box

    def _apply_prototype_styles(self) -> None:
        self.setStyleSheet(
            """
            QWidget { font-family: "Inter", "Segoe UI", "PingFang SC", "Microsoft YaHei"; font-size: 13px; }
            QMainWindow, QWidget { background: #F5F5F7; color: #1D1D1F; }
            QWidget#appHeader { background: transparent; }
            QLabel#appIcon {
                min-width: 42px; max-width: 42px; min-height: 42px; max-height: 42px;
                background: #14B8A6; color: #FFFFFF; border-radius: 12px;
                font-size: 23px; font-weight: 800;
            }
            QLabel#title { font-size: 26px; font-weight: 700; color: #1D1D1F; }
            QLabel#subtitle { font-size: 14px; color: #6B7280; }
            QGroupBox {
                background: #FFFFFF;
                border: 1px solid #ECEEF2; border-radius: 18px; margin-top: 14px; padding-top: 10px;
                font-size: 14px; font-weight: 700; color: #111827;
            }
            QGroupBox::title {
                subcontrol-origin: margin; left: 16px; padding: 0 7px;
                background: #FFFFFF; color: #111827;
            }
            QGroupBox#nodesColumn, QGroupBox#builderColumn, QGroupBox#queueColumn { background: #FFFFFF; }
            QGroupBox#nodesColumn, QGroupBox#nodesColumn::title { color: #111827; }
            QGroupBox#builderColumn, QGroupBox#builderColumn::title { color: #111827; }
            QGroupBox#queueColumn, QGroupBox#queueColumn::title { color: #111827; }
            QPushButton {
                border: 1px solid #E5E7EB; border-radius: 12px; padding: 8px 12px;
                background: #FFFFFF; color: #374151; font-weight: 600;
            }
            QPushButton:hover { background: #F9FAFB; border-color: #D1D5DB; }
            QPushButton:disabled { background: #F3F4F6; color: #9CA3AF; }
            QTabWidget::pane { border: 0; background: transparent; }
            QTabBar {
                qproperty-drawBase: 0;
                alignment: center;
                background: rgba(255,255,255,210);
                border: 1px solid #FFFFFF;
                border-radius: 26px;
            }
            QTabBar::tab {
                background: transparent; border: 0;
                min-width: 92px; min-height: 42px;
                padding: 8px 14px; margin: 5px 2px;
                border-radius: 21px; color: #6B7280; font-weight: 700;
            }
            QTabBar::tab:selected { background: #CCFBF1; color: #0F766E; }
            QTabBar::tab:hover:!selected { background: #F3F4F6; color: #374151; }
            QListWidget, QPlainTextEdit, QLineEdit, QTableWidget {
                background: #FFFFFF; border: 1px solid #E5E7EB; border-radius: 14px;
                selection-background-color: #CCFBF1; selection-color: #0F172A;
            }
            QLineEdit, QComboBox {
                min-height: 34px;
                padding: 4px 10px;
                background: #F9FAFB;
                border: 1px solid #E5E7EB;
                border-radius: 12px;
            }
            QLineEdit:focus, QPlainTextEdit:focus, QComboBox:focus { border-color: #14B8A6; }
            QListWidget::item { margin: 4px; padding: 8px; border-radius: 12px; }
            QListWidget#nodeCards::item { margin: 7px; padding: 12px; border: 1px solid #F1F3F5; border-radius: 16px; background: #FFFFFF; }
            QListWidget#nodeCards::item:selected { background: #ECFDF5; border-color: #99F6E4; color: #0F172A; }
            QListWidget#queueList::item { margin: 5px; padding: 10px; border: 1px solid #F1F3F5; border-radius: 14px; background: #FFFFFF; }
            QListWidget#queueList::item:selected { background: #ECFDF5; border-color: #99F6E4; }
            QListWidget#notificationList::item { margin: 5px; padding: 10px; border: 1px solid #F1F3F5; border-radius: 14px; background: #FFFFFF; }
            QListWidget#notificationList::item:selected { background: #EEF2FF; border-color: #C7D2FE; }
            QPlainTextEdit#runtimeLog { background: #111827; color: #D1FAE5; border: 1px solid #1F2937; font-family: "JetBrains Mono", "SF Mono", monospace; }
            QPushButton#dispatchPrimary { background: #0D9488; color: #FFFFFF; border-color: #0D9488; font-weight: 800; }
            QPushButton#dispatchPrimary:hover { background: #0F766E; }
            QPushButton#dispatchDryRun { background: #EFF6FF; color: #2563EB; border-color: #DBEAFE; font-weight: 700; }
            QPushButton#dispatchCancel { background: #FEF2F2; color: #DC2626; border-color: #FEE2E2; font-weight: 700; }
            QLabel#statusLeft { color: #374151; font-size: 13px; font-weight: 600; }
            QLabel#statusRight { color: #6B7280; font-size: 12px; }
            QLabel#nodesCount { color: #0D9488; font-weight: 700; }
            QFrame#leftHintPanel { background: #F0FDFA; border: 1px solid #CCFBF1; border-radius: 16px; }
            QLabel#leftHintTitle { color: #0F766E; font-weight: 700; font-size: 14px; }
            QLabel#leftHintBody { color: #475569; }
            QFrame#queueCard { background: #FFFFFF; border: 1px solid #ECEEF2; border-radius: 16px; }
            QLabel#queueTitle { color: #111827; font-size: 16px; font-weight: 700; }
            QLabel#queueBody { color: #6B7280; }
            QLabel#queueHint { color: #6B7280; }
            """
        )
        self.app_icon_label.setObjectName("appIcon")
        self.title_label.setObjectName("title")
        self.subtitle_label.setObjectName("subtitle")
        self.status_left_label.setObjectName("statusLeft")
        self.status_right_label.setObjectName("statusRight")

    def _build_left_panel(self) -> QWidget:
        box = QGroupBox("Nearby Devices")
        box.setObjectName("nodesColumn")
        layout = QVBoxLayout(box)
        self.node_count_label = QLabel("0 active")
        self.node_count_label.setObjectName("nodesCount")
        layout.addWidget(self.node_count_label)
        self.node_search_input = QLineEdit()
        self.node_search_input.setPlaceholderText("Search devices by name or status")
        self.node_search_input.textChanged.connect(self.on_node_search_changed)
        layout.addWidget(self.node_search_input)
        self.node_input = QLineEdit(",".join(self.config.node_candidates))
        self.node_input.setPlaceholderText("manual device/node ids (optional), comma separated")
        layout.addWidget(self.node_input)
        self.required_adapters_input = QLineEdit("echo,latex_mcp")
        self.required_adapters_input.setPlaceholderText("required adapters, comma separated")
        layout.addWidget(self.required_adapters_input)
        row = QHBoxLayout()
        self.connect_btn = QPushButton("Connect")
        self.connect_btn.clicked.connect(self.on_connect_clicked)
        row.addWidget(self.connect_btn)
        self.refresh_btn = QPushButton("Refresh")
        self.refresh_btn.clicked.connect(self.on_refresh_nodes_clicked)
        row.addWidget(self.refresh_btn)
        self.agent_check_btn = QPushButton("Agent Check")
        self.agent_check_btn.clicked.connect(self.on_agent_check_clicked)
        row.addWidget(self.agent_check_btn)
        layout.addLayout(row)
        self.connection_feedback_label = QLabel("Connection status: not connected")
        self.connection_feedback_label.setWordWrap(True)
        self.connection_feedback_label.setStyleSheet(
            "QLabel { background: #EEF2F6; color: #4E6074; border: 1px solid #D3DEE9; border-radius: 8px; padding: 6px 8px; }"
        )
        layout.addWidget(self.connection_feedback_label)
        self.sync_config_btn = QPushButton("Sync Config")
        self.sync_config_btn.clicked.connect(self.on_sync_config_clicked)
        layout.addWidget(self.sync_config_btn)
        self.nodes_list = QListWidget()
        self.nodes_list.setObjectName("nodeCards")
        self.nodes_list.itemClicked.connect(self.on_node_item_clicked)
        layout.addWidget(self.nodes_list, 1)
        hint = QFrame()
        hint.setObjectName("leftHintPanel")
        hint_layout = QVBoxLayout(hint)
        hint_title = QLabel("Quick Device Actions")
        hint_title.setObjectName("leftHintTitle")
        hint_layout.addWidget(hint_title)
        self.node_hint_label = QLabel("- Wake sleeping device\n- Re-check agent capabilities\n- Open remote logs stream")
        self.node_hint_label.setObjectName("leftHintBody")
        hint_layout.addWidget(self.node_hint_label)
        layout.addWidget(hint)
        return box

    def _build_center_panel(self) -> QWidget:
        box = QGroupBox("Send Task or File")
        box.setObjectName("builderColumn")
        layout = QVBoxLayout(box)
        from workflow_desktop.widgets import DropPathListWidget

        self.drop_list = DropPathListWidget()
        layout.addWidget(self.drop_list, 1)
        row = QHBoxLayout()
        add_files = QPushButton("Add Files")
        add_files.clicked.connect(self.on_add_files_clicked)
        row.addWidget(add_files)
        add_dir = QPushButton("Add Folder")
        add_dir.clicked.connect(self.on_add_dir_clicked)
        row.addWidget(add_dir)
        remove_selected = QPushButton("Remove Selected")
        remove_selected.clicked.connect(self.drop_list.remove_selected)
        row.addWidget(remove_selected)
        clear_paths = QPushButton("Clear Paths")
        clear_paths.clicked.connect(self.drop_list.clear)
        row.addWidget(clear_paths)
        layout.addLayout(row)

        self.target_input = QLineEdit(self.config.node_candidates[0] if self.config.node_candidates else "")
        self.target_input.setPlaceholderText("target device/node id")
        self.instruction_input = QPlainTextEdit("process uploaded inputs")
        self.instruction_input.setFixedHeight(100)
        self.skills_input = QLineEdit()
        self.skills_input.setPlaceholderText("optional, comma separated: safe_default,latex_compile")
        base_form = QGridLayout()
        base_form.addWidget(QLabel("Target Node"), 0, 0)
        base_form.addWidget(self.target_input, 0, 1)
        base_form.addWidget(QLabel("Instruction"), 1, 0)
        base_form.addWidget(self.instruction_input, 1, 1)
        base_form.addWidget(QLabel("Skills"), 2, 0)
        base_form.addWidget(self.skills_input, 2, 1)
        layout.addLayout(base_form)

        latex = QGroupBox("LaTeX")
        latex_form = QGridLayout(latex)
        self.latex_workspace = QLineEdit()
        pick_workspace = QPushButton("Browse")
        pick_workspace.clicked.connect(self.on_pick_latex_workspace)
        self.latex_mcp_dir = QLineEdit()
        pick_mcp = QPushButton("Browse")
        pick_mcp.clicked.connect(self.on_pick_latex_mcp_dir)
        self.latex_main_tex = QLineEdit()
        pick_tex = QPushButton("Pick .tex")
        pick_tex.clicked.connect(self.on_pick_latex_main_tex)
        self.latex_engine = QComboBox()
        self.latex_engine.addItems(["pdflatex", "xelatex", "lualatex"])
        self.latex_output = QLineEdit("build_case_desktop")
        self.latex_bin_dir = QLineEdit()
        self.latex_timeout = QLineEdit("360")
        latex_form.addWidget(QLabel("Workspace"), 0, 0)
        latex_form.addWidget(self.latex_workspace, 0, 1)
        latex_form.addWidget(pick_workspace, 0, 2)
        latex_form.addWidget(QLabel("latex-mcp Dir"), 1, 0)
        latex_form.addWidget(self.latex_mcp_dir, 1, 1)
        latex_form.addWidget(pick_mcp, 1, 2)
        latex_form.addWidget(QLabel("Main .tex"), 2, 0)
        latex_form.addWidget(self.latex_main_tex, 2, 1)
        latex_form.addWidget(pick_tex, 2, 2)
        latex_form.addWidget(QLabel("Engine"), 3, 0)
        latex_form.addWidget(self.latex_engine, 3, 1)
        latex_form.addWidget(QLabel("Output Subdir"), 4, 0)
        latex_form.addWidget(self.latex_output, 4, 1)
        latex_form.addWidget(QLabel("LaTeX Bin Dir"), 5, 0)
        latex_form.addWidget(self.latex_bin_dir, 5, 1)
        latex_form.addWidget(QLabel("Compile Timeout"), 6, 0)
        latex_form.addWidget(self.latex_timeout, 6, 1)
        layout.addWidget(latex)

        actions = QHBoxLayout()
        self.upload_btn = QPushButton("Upload Inputs")
        self.upload_btn.setObjectName("dispatchPrimary")
        self.upload_btn.clicked.connect(self.on_upload_clicked)
        actions.addWidget(self.upload_btn)
        self.echo_btn = QPushButton("Dispatch Echo")
        self.echo_btn.setObjectName("dispatchDryRun")
        self.echo_btn.clicked.connect(self.on_send_echo_clicked)
        actions.addWidget(self.echo_btn)
        self.latex_btn = QPushButton("Dispatch LaTeX")
        self.latex_btn.setObjectName("dispatchCancel")
        self.latex_btn.clicked.connect(self.on_send_latex_clicked)
        actions.addWidget(self.latex_btn)
        layout.addLayout(actions)
        return box

    def _build_right_panel(self) -> QWidget:
        box = QGroupBox("Queue / Runtime Log")
        layout = QVBoxLayout(box)
        self.running_card = QFrame()
        self.running_card.setObjectName("queueCard")
        rc_layout = QVBoxLayout(self.running_card)
        self.running_title = QLabel("No running task")
        self.running_title.setObjectName("queueTitle")
        self.running_body = QLabel("Waiting for task dispatch.")
        self.running_body.setObjectName("queueBody")
        self.running_body.setWordWrap(True)
        rc_layout.addWidget(self.running_title)
        rc_layout.addWidget(self.running_body)
        layout.addWidget(self.running_card)

        self.completed_card = QFrame()
        self.completed_card.setObjectName("queueCard")
        cc_layout = QVBoxLayout(self.completed_card)
        self.completed_title = QLabel("No completed task")
        self.completed_title.setObjectName("queueTitle")
        self.completed_body = QLabel("Artifacts will appear after first completed task.")
        self.completed_body.setObjectName("queueBody")
        self.completed_body.setWordWrap(True)
        cc_layout.addWidget(self.completed_title)
        cc_layout.addWidget(self.completed_body)
        layout.addWidget(self.completed_card)
        self.queue_alert_label = QLabel("No failure alerts.")
        self.queue_alert_label.setWordWrap(True)
        self.queue_alert_label.setStyleSheet(
            "QLabel { background: #F4F7FB; color: #55687D; border: 1px solid #D8E2ED; border-radius: 8px; padding: 8px; }"
        )
        layout.addWidget(self.queue_alert_label)
        self.queue_alert_open_btn = QPushButton("Open Failed Task")
        self.queue_alert_open_btn.setEnabled(False)
        self.queue_alert_open_btn.clicked.connect(self.on_open_failed_alert_clicked)
        alert_row = QHBoxLayout()
        alert_row.addWidget(self.queue_alert_open_btn)
        self.queue_alert_copy_btn = QPushButton("Copy Failed Details")
        self.queue_alert_copy_btn.setEnabled(False)
        self.queue_alert_copy_btn.clicked.connect(self.on_copy_failed_alert_clicked)
        alert_row.addWidget(self.queue_alert_copy_btn)
        self.queue_alert_export_btn = QPushButton("Export Failed Context (.json)")
        self.queue_alert_export_btn.setEnabled(False)
        self.queue_alert_export_btn.clicked.connect(self.on_export_failed_context_clicked)
        alert_row.addWidget(self.queue_alert_export_btn)
        self.queue_alert_retry_btn = QPushButton("Retry Failed Task")
        self.queue_alert_retry_btn.setEnabled(False)
        self.queue_alert_retry_btn.clicked.connect(self.on_retry_failed_alert_clicked)
        alert_row.addWidget(self.queue_alert_retry_btn)
        layout.addLayout(alert_row)

        self.tasks_list = QListWidget()
        self.tasks_list.setObjectName("queueList")
        self.tasks_list.itemSelectionChanged.connect(self.on_task_selection_changed)
        layout.addWidget(self.tasks_list, 1)
        self.log_text = QPlainTextEdit()
        self.log_text.setObjectName("runtimeLog")
        self.log_text.setReadOnly(True)
        self.log_text.setMaximumBlockCount(5000)
        layout.addWidget(self.log_text, 2)
        clear_btn = QPushButton("Clear Logs")
        clear_btn.clicked.connect(self.log_text.clear)
        layout.addWidget(clear_btn)
        return box

    def _build_task_detail_tab(self) -> QWidget:
        page = QWidget()
        layout = QVBoxLayout(page)
        self.detail_header = QLabel("Select a task item from Task Center.")
        layout.addWidget(self.detail_header)
        meta_row = QHBoxLayout()
        self.detail_status_badge = QLabel("Status: -")
        self.detail_status_badge.setStyleSheet(
            "QLabel { background: #EAF1FB; color: #1D3F66; border: 1px solid #C7D8F0; border-radius: 10px; padding: 4px 10px; font-weight: 700; }"
        )
        meta_row.addWidget(self.detail_status_badge)
        self.detail_error_badge = QLabel("Error: none")
        self.detail_error_badge.setStyleSheet(
            "QLabel { background: #EEF2F6; color: #4E6074; border: 1px solid #D3DEE9; border-radius: 10px; padding: 4px 10px; font-weight: 700; }"
        )
        meta_row.addWidget(self.detail_error_badge)
        meta_row.addStretch(1)
        layout.addLayout(meta_row)
        self.detail_user_message = QLabel("User message: -")
        self.detail_user_message.setWordWrap(True)
        self.detail_user_message.setStyleSheet(
            "QLabel { background: #FFFFFF; color: #274561; border: 1px solid #D6DEE9; border-radius: 8px; padding: 8px 10px; }"
        )
        layout.addWidget(self.detail_user_message)
        split = QSplitter(Qt.Vertical)
        self.timeline_text = QPlainTextEdit()
        self.timeline_text.setReadOnly(True)
        self.detail_text = QPlainTextEdit()
        self.detail_text.setReadOnly(True)
        split.addWidget(self.timeline_text)
        split.addWidget(self.detail_text)
        split.setSizes([240, 600])
        layout.addWidget(split, 1)
        return page

    def _build_results_tab(self) -> QWidget:
        page = QWidget()
        layout = QVBoxLayout(page)
        row = QHBoxLayout()
        open_path = QPushButton("Open Path")
        open_path.clicked.connect(self.on_open_result_path)
        row.addWidget(open_path)
        open_folder = QPushButton("Open Folder")
        open_folder.clicked.connect(self.on_open_result_folder)
        row.addWidget(open_folder)
        copy_path = QPushButton("Copy Path")
        copy_path.clicked.connect(self.on_copy_result_path)
        row.addWidget(copy_path)
        download_btn = QPushButton("Download Artifact")
        download_btn.clicked.connect(self.on_download_result_clicked)
        row.addWidget(download_btn)
        row.addStretch(1)
        layout.addLayout(row)
        split = QSplitter(Qt.Horizontal)
        layout.addWidget(split, 1)
        self.results_list = QListWidget()
        self.results_list.itemSelectionChanged.connect(self.on_result_selection_changed)
        split.addWidget(self.results_list)
        right = QWidget()
        right_layout = QVBoxLayout(right)
        self.preview_image_label = QLabel("No image selected.")
        self.preview_image_label.setAlignment(Qt.AlignCenter)
        self.preview_image_label.setStyleSheet("QLabel { border: 1px solid #777; }")
        right_layout.addWidget(self.preview_image_label, 2)
        self.preview_meta_text = QPlainTextEdit()
        self.preview_meta_text.setReadOnly(True)
        right_layout.addWidget(self.preview_meta_text, 1)
        split.addWidget(right)
        split.setSizes([420, 900])
        return page

    def _build_history_tab(self) -> QWidget:
        page = QWidget()
        layout = QVBoxLayout(page)
        row = QHBoxLayout()
        self.history_filter_input = QLineEdit()
        self.history_filter_input.setPlaceholderText("filter id/kind/node/status")
        self.history_filter_input.textChanged.connect(self.on_history_filter_changed)
        row.addWidget(self.history_filter_input, 1)
        refresh = QPushButton("Refresh")
        refresh.clicked.connect(self.refresh_history_table)
        row.addWidget(refresh)
        layout.addLayout(row)
        self.history_table = QTableWidget(0, 5)
        self.history_table.setHorizontalHeaderLabels(["Created", "Kind", "Node", "Status", "Record ID"])
        self.history_table.horizontalHeader().setSectionResizeMode(0, QHeaderView.ResizeToContents)
        self.history_table.horizontalHeader().setSectionResizeMode(1, QHeaderView.ResizeToContents)
        self.history_table.horizontalHeader().setSectionResizeMode(2, QHeaderView.ResizeToContents)
        self.history_table.horizontalHeader().setSectionResizeMode(3, QHeaderView.ResizeToContents)
        self.history_table.horizontalHeader().setSectionResizeMode(4, QHeaderView.Stretch)
        self.history_table.itemSelectionChanged.connect(self.on_history_selection_changed)
        layout.addWidget(self.history_table, 1)
        self.history_recovery_text = QPlainTextEdit()
        self.history_recovery_text.setReadOnly(True)
        self.history_recovery_text.setPlaceholderText("Recovery metadata for selected task will appear here.")
        self.history_recovery_text.setMaximumHeight(160)
        layout.addWidget(self.history_recovery_text)
        return page

    def _build_notifications_tab(self) -> QWidget:
        page = QWidget()
        layout = QVBoxLayout(page)
        self.notifications_summary_label = QLabel("0 notifications")
        layout.addWidget(self.notifications_summary_label)
        filter_row = QHBoxLayout()
        self.notifications_level_filter_input = QComboBox()
        self.notifications_level_filter_input.addItem("All Levels", "all")
        self.notifications_level_filter_input.addItem("Error", "error")
        self.notifications_level_filter_input.addItem("Warning", "warning")
        self.notifications_level_filter_input.addItem("Info", "info")
        self.notifications_level_filter_input.currentIndexChanged.connect(self.on_notifications_filter_changed)
        filter_row.addWidget(self.notifications_level_filter_input)
        self.notifications_category_filter_input = QComboBox()
        self.notifications_category_filter_input.addItem("All Categories", "all")
        self.notifications_category_filter_input.currentIndexChanged.connect(self.on_notifications_filter_changed)
        filter_row.addWidget(self.notifications_category_filter_input)
        self.notifications_read_filter_input = QComboBox()
        self.notifications_read_filter_input.addItem("All", "all")
        self.notifications_read_filter_input.addItem("Unread Only", "unread")
        self.notifications_read_filter_input.currentIndexChanged.connect(self.on_notifications_filter_changed)
        filter_row.addWidget(self.notifications_read_filter_input)
        self.notifications_search_input = QLineEdit()
        self.notifications_search_input.setPlaceholderText("Search title/message/category")
        self.notifications_search_input.textChanged.connect(self.on_notifications_filter_changed)
        filter_row.addWidget(self.notifications_search_input, 1)
        layout.addLayout(filter_row)
        row = QHBoxLayout()
        mark_all_read = QPushButton("Mark All Read")
        mark_all_read.clicked.connect(self.on_mark_all_notifications_read)
        row.addWidget(mark_all_read)
        mark_selected_read = QPushButton("Mark Selected Read")
        mark_selected_read.clicked.connect(self.on_mark_selected_notification_read)
        row.addWidget(mark_selected_read)
        copy_selected = QPushButton("Copy Selected")
        copy_selected.clicked.connect(self.on_copy_selected_notification)
        row.addWidget(copy_selected)
        copy_all = QPushButton("Copy All")
        copy_all.clicked.connect(self.on_copy_all_notifications)
        row.addWidget(copy_all)
        clear_btn = QPushButton("Clear")
        clear_btn.clicked.connect(self.on_clear_notifications)
        row.addWidget(clear_btn)
        row.addStretch(1)
        layout.addLayout(row)
        split = QSplitter(Qt.Vertical)
        self.notifications_list = QListWidget()
        self.notifications_list.setObjectName("notificationList")
        self.notifications_list.itemSelectionChanged.connect(self.on_notification_selection_changed)
        split.addWidget(self.notifications_list)
        self.notification_detail_text = QPlainTextEdit()
        self.notification_detail_text.setReadOnly(True)
        split.addWidget(self.notification_detail_text)
        split.setSizes([360, 540])
        layout.addWidget(split, 1)
        return page

    def _build_mcp_tab(self) -> QWidget:
        page = QWidget()
        layout = QVBoxLayout(page)
        cfg_label = QLabel(f"Config path: {self.config.mcp_config_path}")
        layout.addWidget(cfg_label)
        self.mcp_table = QTableWidget(0, 5)
        self.mcp_table.setHorizontalHeaderLabels(["Name", "Mode", "Endpoint/Command", "Version", "Enabled"])
        self.mcp_table.horizontalHeader().setSectionResizeMode(0, QHeaderView.ResizeToContents)
        self.mcp_table.horizontalHeader().setSectionResizeMode(1, QHeaderView.ResizeToContents)
        self.mcp_table.horizontalHeader().setSectionResizeMode(2, QHeaderView.Stretch)
        self.mcp_table.horizontalHeader().setSectionResizeMode(3, QHeaderView.ResizeToContents)
        self.mcp_table.horizontalHeader().setSectionResizeMode(4, QHeaderView.ResizeToContents)
        self.mcp_table.itemSelectionChanged.connect(self.on_mcp_table_selection_changed)
        layout.addWidget(self.mcp_table, 1)

        form_widget = QWidget()
        form_layout = QFormLayout(form_widget)
        self.mcp_name_input = QLineEdit()
        self.mcp_mode_input = QComboBox()
        self.mcp_mode_input.addItems(["endpoint", "command"])
        self.mcp_endpoint_input = QLineEdit()
        self.mcp_version_input = QLineEdit()
        self.mcp_enabled_input = QComboBox()
        self.mcp_enabled_input.addItems(["true", "false"])
        form_layout.addRow("Name", self.mcp_name_input)
        form_layout.addRow("Mode", self.mcp_mode_input)
        form_layout.addRow("Endpoint / Command", self.mcp_endpoint_input)
        form_layout.addRow("Version", self.mcp_version_input)
        form_layout.addRow("Enabled", self.mcp_enabled_input)
        layout.addWidget(form_widget)

        row = QHBoxLayout()
        add_update = QPushButton("Add / Update")
        add_update.clicked.connect(self.on_mcp_add_or_update)
        row.addWidget(add_update)
        delete_btn = QPushButton("Delete")
        delete_btn.clicked.connect(self.on_mcp_delete)
        row.addWidget(delete_btn)
        health = QPushButton("Health Check")
        health.clicked.connect(self.on_mcp_health_check)
        row.addWidget(health)
        save_btn = QPushButton("Save")
        save_btn.clicked.connect(self.on_mcp_save)
        row.addWidget(save_btn)
        reload_btn = QPushButton("Reload")
        reload_btn.clicked.connect(self.on_mcp_reload)
        row.addWidget(reload_btn)
        row.addStretch(1)
        layout.addLayout(row)
        self.mcp_status_label = QLabel("Ready")
        layout.addWidget(self.mcp_status_label)
        return page

    def _build_settings_tab(self) -> QWidget:
        page = QWidget()
        layout = QVBoxLayout(page)
        self.settings_status_label = QLabel("Ready")
        self.settings_status_label.setWordWrap(True)
        layout.addWidget(self.settings_status_label)
        scroll = QScrollArea()
        scroll.setWidgetResizable(True)
        scroll.setFrameShape(QFrame.NoFrame)
        scroll.setHorizontalScrollBarPolicy(Qt.ScrollBarAsNeeded)
        scroll.setVerticalScrollBarPolicy(Qt.ScrollBarAsNeeded)
        form_widget = QWidget()
        scroll.setWidget(form_widget)
        form = QFormLayout(form_widget)
        form.setRowWrapPolicy(QFormLayout.WrapLongRows)
        form.setFieldGrowthPolicy(QFormLayout.AllNonFixedFieldsGrow)
        form.setLabelAlignment(Qt.AlignRight | Qt.AlignVCenter)
        form.setFormAlignment(Qt.AlignTop | Qt.AlignLeft)
        form.setHorizontalSpacing(12)
        form.setVerticalSpacing(10)
        self.settings_nats_url_input = QLineEdit(self.config.nats_url)
        self.settings_nodes_input = QLineEdit(",".join(self.config.node_candidates))
        self.settings_poll_input = QLineEdit(str(self.config.poll_interval_sec))
        self.settings_discovery_enabled_input = QComboBox()
        self.settings_discovery_enabled_input.addItems(["true", "false"])
        self.settings_discovery_enabled_input.setCurrentText("true" if self._discovery_enabled else "false")
        self.settings_discovery_port_input = QLineEdit(str(self._discovery_port))
        self.settings_discovery_max_age_input = QLineEdit(str(self._discovery_max_age_sec))
        self.settings_discovery_auto_switch_input = QComboBox()
        self.settings_discovery_auto_switch_input.addItems(["true", "false"])
        self.settings_discovery_auto_switch_input.setCurrentText("true" if self._discovery_auto_switch_nats else "false")
        self.settings_language_input = QComboBox()
        for code in SUPPORTED_LANGS:
            self.settings_language_input.addItem(LANGUAGE_LABELS.get(code, code), code)
        self.settings_language_input.setCurrentIndex(max(0, self.settings_language_input.findData(self._language)))
        self.settings_config_sync_enabled_input = QComboBox()
        self.settings_config_sync_enabled_input.addItems(["true", "false"])
        self.settings_config_sync_enabled_input.setCurrentText("true" if self._config_sync_enabled else "false")
        self.settings_config_sync_interval_input = QLineEdit(str(self._config_sync_interval_sec))
        self.settings_config_sync_conflict_policy_input = QComboBox()
        self.settings_config_sync_conflict_policy_input.addItems(list(CONFIG_SYNC_CONFLICT_POLICY_OPTIONS))
        self.settings_config_sync_conflict_policy_input.setCurrentText(self._config_sync_conflict_policy)
        self.settings_log_level_input = QComboBox()
        self.settings_log_level_input.addItems(["DEBUG", "INFO", "WARN", "ERROR"])
        self.settings_log_file_input = QLineEdit(os.getenv("WORKFLOW_LOG_FILE", DEFAULT_DESKTOP_LOG_FILE))
        self.settings_mcp_path_input = QLineEdit(self.config.mcp_config_path)
        self.settings_notification_max_items_input = QLineEdit(str(self._notification_max_items))
        self.settings_notification_dedupe_window_input = QLineEdit(str(self._notification_dedupe_window_sec))
        self.settings_notification_auto_read_input = QComboBox()
        self.settings_notification_auto_read_input.addItems(["true", "false"])
        self.settings_retry_batch_max_limit_input = QLineEdit(str(self._retry_batch_max_limit))
        self.settings_retry_batch_interval_input = QLineEdit(str(self._retry_batch_interval_sec))
        self.settings_retry_batch_skip_kinds_input = QLineEdit(",".join(sorted(self._retry_batch_skip_kinds)))
        self.settings_retry_reroute_mode_input = QComboBox()
        self.settings_retry_reroute_mode_input.addItems(list(RETRY_REROUTE_MODE_OPTIONS))
        self.settings_retry_attempts_per_task_input = QLineEdit(str(self._retry_attempts_per_task))
        self.settings_retry_backoff_base_input = QLineEdit(str(self._retry_backoff_base_sec))
        self.settings_update_enabled_input = QComboBox()
        self.settings_update_enabled_input.addItems(["true", "false"])
        self.settings_update_feed_url_input = QLineEdit(self._update_feed_url)
        self.settings_update_asset_pattern_input = QLineEdit(self._update_asset_pattern)
        self.settings_update_check_on_start_input = QComboBox()
        self.settings_update_check_on_start_input.addItems(["true", "false"])
        self.settings_version_label = QLabel(self._current_version)
        self.settings_path_label = QLabel()
        form.addRow(self.settings_path_label)
        form.addRow("Current Version", self.settings_version_label)
        form.addRow("NATS URL", self.settings_nats_url_input)
        form.addRow("Node Candidates", self.settings_nodes_input)
        form.addRow("Poll Interval", self.settings_poll_input)
        form.addRow("LAN Discovery Enabled", self.settings_discovery_enabled_input)
        form.addRow("LAN Discovery Port", self.settings_discovery_port_input)
        form.addRow("LAN Discovery Max Age (sec)", self.settings_discovery_max_age_input)
        form.addRow("LAN Auto Switch NATS", self.settings_discovery_auto_switch_input)
        form.addRow("Language", self.settings_language_input)
        form.addRow("Config Sync Enabled", self.settings_config_sync_enabled_input)
        form.addRow("Config Sync Interval (sec)", self.settings_config_sync_interval_input)
        form.addRow("Config Sync Conflict Policy", self.settings_config_sync_conflict_policy_input)
        form.addRow("Log Level", self.settings_log_level_input)
        form.addRow("Log File", self.settings_log_file_input)
        form.addRow("MCP Config Path", self.settings_mcp_path_input)
        form.addRow("Notification Max Items", self.settings_notification_max_items_input)
        form.addRow("Notification Dedupe Window (sec)", self.settings_notification_dedupe_window_input)
        form.addRow("Notification Auto Mark Read", self.settings_notification_auto_read_input)
        form.addRow("Retry Batch Max Limit", self.settings_retry_batch_max_limit_input)
        form.addRow("Retry Batch Interval (sec)", self.settings_retry_batch_interval_input)
        form.addRow("Retry Batch Skip Kinds", self.settings_retry_batch_skip_kinds_input)
        form.addRow("Retry Reroute Mode", self.settings_retry_reroute_mode_input)
        form.addRow("Retry Attempts Per Task", self.settings_retry_attempts_per_task_input)
        form.addRow("Retry Backoff Base (sec)", self.settings_retry_backoff_base_input)
        form.addRow("Update Enabled", self.settings_update_enabled_input)
        form.addRow("Update Feed URL", self.settings_update_feed_url_input)
        form.addRow("Update Asset Pattern", self.settings_update_asset_pattern_input)
        form.addRow("Update Check On Start", self.settings_update_check_on_start_input)
        layout.addWidget(scroll, 1)
        row = QHBoxLayout()
        apply_btn = QPushButton("Apply Runtime")
        apply_btn.clicked.connect(self.on_settings_apply)
        row.addWidget(apply_btn)
        save_btn = QPushButton("Save Settings")
        save_btn.clicked.connect(self.on_settings_save)
        row.addWidget(save_btn)
        reload_btn = QPushButton("Reload Settings")
        reload_btn.clicked.connect(self.on_settings_reload)
        row.addWidget(reload_btn)
        check_update_btn = QPushButton("Check Updates")
        check_update_btn.clicked.connect(self.on_check_updates_clicked)
        row.addWidget(check_update_btn)
        row.addStretch(1)
        layout.addLayout(row)
        self._update_settings_path_label()
        return page

    async def start(self) -> None:
        if self._running:
            return
        self._running = True
        await self._start_discovery_listener()
        try:
            await asyncio.wait_for(self.service.connect(), timeout=CONNECT_TIMEOUT_SEC)
            self._append_log(f"desktop connected nats={self.config.nats_url}")
            await self.service.start_client_messaging(handler=self._handle_client_event)
            self._append_log(f"client messaging ready id={self.config.client_id}")
            self._set_connection_state(state="connected")
            self._set_connection_feedback("Connected", level="ok")
        except Exception as exc:
            detail = self._format_connect_error(exc)
            self._append_log(f"desktop startup connect failed: {detail}")
            self._set_connection_state(state="disconnected", error=detail)
            self._set_connection_feedback(f"Connect failed: {detail}", level="error")
            self._add_notification(
                level="warning",
                title="Startup Connect Failed",
                message=detail,
                category="network",
                context={"nats_url": self.config.nats_url},
            )
        self._append_log(f"log file: {self.settings_log_file_input.text().strip() or DEFAULT_DESKTOP_LOG_FILE}")
        self._poll_task = asyncio.create_task(self._poll_nodes_loop(), name="desktop-poll-loop")
        if self._update_enabled and self._update_check_on_start:
            asyncio.create_task(self._check_updates(trigger="startup", show_dialog=False), name="desktop-update-check")

    async def shutdown(self) -> None:
        self._running = False
        self._save_conversation_state()
        if self._poll_task is not None:
            self._poll_task.cancel()
            await asyncio.gather(self._poll_task, return_exceptions=True)
            self._poll_task = None
        await self._stop_discovery_listener()
        await self.service.close()
        self._set_connection_state(state="disconnected")

    async def _start_discovery_listener(self) -> None:
        if not self._discovery_enabled:
            self._append_log("lan discovery disabled")
            return
        if self._discovery_listener is not None:
            return
        listener = LanNodeListener(port=self._discovery_port)
        try:
            await listener.start()
        except Exception as exc:
            self._append_log(f"lan discovery start failed: {exc}")
            self._add_notification(
                level="warning",
                title="LAN Discovery Start Failed",
                message=str(exc),
                category="discovery",
                context={"port": self._discovery_port},
            )
            return
        self._discovery_listener = listener
        self._append_log(f"lan discovery listening on udp/{self._discovery_port}")

    async def _stop_discovery_listener(self) -> None:
        listener = self._discovery_listener
        if listener is None:
            return
        self._discovery_listener = None
        try:
            await listener.stop()
        except Exception:
            logger.debug("stop discovery listener failed", exc_info=True)

    async def _refresh_discovered_nodes(self) -> None:
        listener = self._discovery_listener
        if listener is None:
            self._discovered_nodes = {}
            return
        self._discovered_nodes = listener.snapshot(max_age_sec=self._discovery_max_age_sec)
        await self._maybe_auto_switch_nats()

    async def _maybe_auto_switch_nats(self) -> None:
        if not self._discovery_enabled or not self._discovery_auto_switch_nats:
            return
        current = self.config.nats_url.strip()
        if not is_loopback_nats_url(current):
            return
        candidates = [
            item.nats_url
            for _, item in sorted(self._discovered_nodes.items(), key=lambda row: row[0])
            if item.nats_url and (not is_loopback_nats_url(item.nats_url))
        ]
        if not candidates:
            return
        candidate = candidates[0]
        if candidate == current:
            return
        if candidate == self._discovery_auto_switch_last_attempt:
            return
        self._discovery_auto_switch_last_attempt = candidate
        old_url = self.config.nats_url
        self._append_log(f"lan discovery detected nats {candidate}, switching from {old_url}")
        try:
            await self.service.close()
        except Exception:
            logger.debug("close service before switch failed", exc_info=True)
        self.service = DesktopControlService(client_id=self.config.client_id, nats_url=candidate)
        try:
            await self.service.connect()
        except Exception as exc:
            self._append_log(f"auto switch nats failed: {exc}")
            self._set_connection_state(state="disconnected", error=self._format_connect_error(exc))
            self._set_connection_feedback(f"Auto switch failed: {self._format_connect_error(exc)}", level="error")
            self._add_notification(
                level="warning",
                title="Auto Switch NATS Failed",
                message=str(exc),
                category="discovery",
                context={"from_nats_url": old_url, "to_nats_url": candidate},
            )
            self.service = DesktopControlService(client_id=self.config.client_id, nats_url=old_url)
            try:
                await self.service.connect()
                self._set_connection_state(state="connected")
                self._set_connection_feedback("Connected", level="ok")
            except Exception as restore_exc:
                self._append_log(f"restore nats failed: {restore_exc}")
            return
        self.config.nats_url = candidate
        self.settings_nats_url_input.setText(candidate)
        self._set_connection_state(state="connected")
        self._set_connection_feedback("Connected", level="ok")
        self._add_notification(
            level="info",
            title="Auto Switched NATS",
            message=f"{old_url} -> {candidate}",
            category="discovery",
            context={"from_nats_url": old_url, "to_nats_url": candidate},
        )

    def _build_config_sync_payload(self) -> tuple[dict[str, Any], str]:
        payload = {
            "schema": "agswarm.desktop.config-sync.v1",
            "desktop": {
                "client_id": self.config.client_id,
                "language": self._language,
                "app_version": self._current_version,
                "updated_at": datetime.now().isoformat(timespec="seconds"),
            },
            "runtime": {
                "nats_url": self.config.nats_url,
                "required_adapters": self._required_adapters(),
            },
            "mcp_services": [item.to_dict() for item in self._mcp_services],
        }
        normalized = json.dumps(payload, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
        digest = hashlib.sha256(normalized.encode("utf-8")).hexdigest()
        return payload, digest

    async def _sync_node_config_once(
        self,
        *,
        node_id: str,
        payload: dict[str, Any],
        digest: str,
        now: float,
        force: bool = False,
    ) -> bool:
        retry_after = self._config_sync_retry_after.get(node_id, 0.0)
        if (not force) and now < retry_after:
            return False
        try:
            result = await self.service.sync_node_config(node_id=node_id, config_payload=payload, timeout_sec=3.0)
        except Exception as exc:
            self._config_sync_retry_after[node_id] = now + 60.0
            self._append_log(f"config sync failed node={node_id}: {exc}")
            self._add_notification(
                level="warning",
                title=f"Config Sync Failed | {node_id}",
                message=str(exc),
                category="config-sync",
                context={"node_id": node_id},
            )
            return False
        if bool(result.get("ok")):
            self._config_sync_node_digest[node_id] = digest
            self._config_sync_retry_after.pop(node_id, None)
            self._append_log(f"config sync ok node={node_id} revision={result.get('config_sync_revision')}")
            self._add_notification(
                level="info",
                title=f"Config Synced | {node_id}",
                message=f"revision={result.get('config_sync_revision')}",
                category="config-sync",
                context=result if isinstance(result, dict) else {"node_id": node_id},
            )
            return True
        self._config_sync_retry_after[node_id] = now + 60.0
        self._append_log(f"config sync rejected node={node_id}: {result}")
        return False

    async def _maybe_sync_config_to_nodes(self, snapshots: list[tuple[str, dict | None]]) -> None:
        if not self._config_sync_enabled:
            return
        now = monotonic()
        if (now - self._config_sync_last_run_monotonic) < self._config_sync_interval_sec:
            return
        self._config_sync_last_run_monotonic = now
        payload, digest = self._build_config_sync_payload()
        if digest != self._config_sync_last_digest:
            self._config_sync_last_digest = digest
            self._config_sync_node_digest.clear()
            self._config_sync_retry_after.clear()

        for node_id, snap in snapshots:
            if snap is None:
                continue
            if self._config_sync_node_digest.get(node_id) == digest:
                continue
            retry_after = self._config_sync_retry_after.get(node_id, 0.0)
            if now < retry_after:
                continue
            remote_digest = str(snap.get("config_sync_digest", "")).strip() if isinstance(snap, dict) else ""
            action = decide_sync_action(
                policy=self._config_sync_conflict_policy,
                local_digest=digest,
                remote_digest=remote_digest,
                force=False,
            )
            if action == "skip_same":
                self._config_sync_node_digest[node_id] = digest
                continue
            if action == "skip_node_wins":
                self._config_sync_node_digest[node_id] = remote_digest
                self._config_sync_retry_after[node_id] = now + self._config_sync_interval_sec
                self._append_log(f"config sync skipped(node_wins) node={node_id}")
                continue
            if action == "skip_manual":
                self._config_sync_retry_after[node_id] = now + self._config_sync_interval_sec
                self._append_log(f"config sync conflict(manual) node={node_id}")
                self._add_notification(
                    level="warning",
                    title=f"Config Conflict | {node_id}",
                    message="manual sync required (click Sync Config)",
                    category="config-sync",
                    context={"node_id": node_id, "remote_digest": remote_digest, "local_digest": digest},
                )
                continue
            await self._sync_node_config_once(node_id=node_id, payload=payload, digest=digest, now=now, force=False)

    def _conversation_state_payload(self) -> dict[str, Any]:
        return {
            "version": 1,
            "client_id": self.config.client_id,
            "selected_peer_id": self._selected_peer_id,
            "client_peers": self._client_peers,
            "conversation_messages": self._conversation_messages[-500:],
            "peer_read_cursors": self._peer_read_cursors,
            "task_request_records": self._task_request_records,
            "inbound_task_request_records": self._inbound_task_request_records,
            "task_records": self._task_records,
            "task_order": self._task_order[-500:],
            "task_index": self._task_index,
            "latest_task_request_id": (
                str(self._latest_task_request.get("message_id", "")).strip()
                if isinstance(self._latest_task_request, dict)
                else ""
            ),
            "active_task_request_id": (
                str(self._active_task_request.get("message_id", "")).strip()
                if isinstance(self._active_task_request, dict)
                else ""
            ),
        }

    def _load_conversation_state(self) -> None:
        payload = load_conversation_state(self.config.conversation_state_path)
        if not payload:
            return
        peers = payload.get("client_peers")
        if isinstance(peers, dict):
            self._client_peers = {str(k): v for k, v in peers.items() if isinstance(v, dict)}
        messages = payload.get("conversation_messages")
        if isinstance(messages, list):
            self._conversation_messages = [dict(x) for x in messages if isinstance(x, dict)]
            self._conversation_message_ids = {
                str(x.get("message_id", "")).strip()
                for x in self._conversation_messages
                if str(x.get("message_id", "")).strip()
            }
        read_cursors = payload.get("peer_read_cursors")
        if isinstance(read_cursors, dict):
            self._peer_read_cursors = {
                str(k): str(v)
                for k, v in read_cursors.items()
                if str(k).strip() and str(v).strip()
            }
        selected = str(payload.get("selected_peer_id", "")).strip()
        if selected:
            self._selected_peer_id = selected
            self.peer_input.setText(selected)
        task_records = payload.get("task_records")
        if isinstance(task_records, dict):
            self._task_records = {str(k): v for k, v in task_records.items() if isinstance(v, dict)}
        task_order = payload.get("task_order")
        if isinstance(task_order, list):
            self._task_order = [
                str(record_id)
                for record_id in task_order
                if str(record_id) in self._task_records
            ]
        else:
            self._task_order = list(self._task_records)
        task_index = payload.get("task_index")
        if isinstance(task_index, int) and task_index > self._task_index:
            self._task_index = task_index
        self._restore_task_records_to_ui()
        task_records = payload.get("task_request_records")
        if isinstance(task_records, dict):
            self._task_request_records = {
                str(k): str(v)
                for k, v in task_records.items()
                if str(v) in self._task_records
            }
        inbound_records = payload.get("inbound_task_request_records")
        if isinstance(inbound_records, dict):
            self._inbound_task_request_records = {
                str(k): str(v)
                for k, v in inbound_records.items()
                if str(v) in self._task_records
            }
        latest_id = str(payload.get("latest_task_request_id", "")).strip()
        if latest_id:
            for message in reversed(self._conversation_messages):
                if str(message.get("message_id", "")).strip() == latest_id:
                    self._latest_task_request = message
                    break
        active_id = str(payload.get("active_task_request_id", "")).strip()
        if active_id:
            for message in reversed(self._conversation_messages):
                if str(message.get("message_id", "")).strip() == active_id:
                    self._active_task_request = message
                    break
        if self._active_task_request is None and self._latest_task_request is not None:
            self._active_task_request = self._latest_task_request
        self._refresh_peer_list()
        self._refresh_conversation_view()

    def _restore_task_records_to_ui(self) -> None:
        self.tasks_list.clear()
        for record_id in self._task_order:
            record = self._task_records.get(record_id)
            if not record:
                continue
            kind = record.get("kind")
            node_id = record.get("node_id")
            status = record.get("status")
            item = QListWidgetItem(f"{kind} | node={node_id} | status={status} | id={record_id}")
            item.setData(Qt.UserRole, record_id)
            self.tasks_list.addItem(item)
        self._refresh_queue_cards()
        self.refresh_history_table()

    def _save_conversation_state(self) -> None:
        try:
            save_conversation_state(self.config.conversation_state_path, self._conversation_state_payload())
        except Exception as exc:
            logger.warning("save conversation state failed: %s", exc)

    async def _handle_client_event(self, subject: str, payload: dict) -> None:
        msg_type = str(payload.get("type", "")).strip()
        if msg_type == "presence":
            self._handle_client_presence(payload)
            return
        self._handle_client_inbox_message(payload)

    def _handle_client_presence(self, payload: dict[str, Any]) -> None:
        peer_id = str(payload.get("client_id") or payload.get("from_client_id") or "").strip()
        if not peer_id or peer_id == self.config.client_id:
            return
        self._upsert_client_peer(
            peer_id,
            status=str(payload.get("status", "online")),
            last_seen=str(payload.get("ts", datetime.now().isoformat(timespec="seconds"))),
            payload=payload,
        )
        self._refresh_peer_list()
        self._save_conversation_state()

    def _upsert_client_peer(
        self,
        peer_id: str,
        *,
        status: str,
        last_seen: str,
        payload: dict[str, Any],
    ) -> None:
        peer = self._client_peers.setdefault(
            peer_id,
            {
                "client_id": peer_id,
                "status": "manual",
                "last_seen": "-",
                "payload": {},
            },
        )
        peer["client_id"] = peer_id
        peer["status"] = status or str(peer.get("status", "online"))
        peer["last_seen"] = last_seen or str(peer.get("last_seen", "-"))
        peer["payload"] = payload

    def _handle_client_inbox_message(self, payload: dict[str, Any]) -> None:
        sender = str(payload.get("from_client_id", "")).strip()
        if sender and sender != self.config.client_id:
            self._upsert_client_peer(
                sender,
                status="online",
                last_seen=str(payload.get("ts", datetime.now().isoformat(timespec="seconds"))),
                payload=payload,
            )
        was_added = self._append_conversation_message(direction="in", message=payload)
        if not was_added:
            return
        if sender and sender == self._selected_peer_id.strip():
            self._mark_peer_read(sender)
        msg_type = str(payload.get("type"))
        if msg_type == "task.request":
            self._latest_task_request = payload
            if self._should_auto_load_task_request(payload):
                self._load_task_request(payload, overwrite_script=self._can_replace_script_from_request())
            self._register_inbound_task_request(payload)
            request_payload = payload.get("payload") if isinstance(payload.get("payload"), dict) else {}
            instruction = str(request_payload.get("instruction", "")).strip()
            self._add_notification(
                level="info",
                title=f"Task Request | {sender or 'unknown'}",
                message=instruction or "Task request received.",
                category="conversation",
                context=payload,
            )
        elif msg_type == "task.result":
            self._handle_task_result_message(payload)
        if sender:
            self._refresh_peer_list()
            self._refresh_conversation_view()
            self._save_conversation_state()

    def _register_inbound_task_request(self, message: dict[str, Any]) -> None:
        message_id = str(message.get("message_id", "")).strip()
        if not message_id or message_id in self._inbound_task_request_records:
            return
        payload = message.get("payload") if isinstance(message.get("payload"), dict) else {}
        instruction = str(payload.get("instruction", "")).strip()
        sender = str(message.get("from_client_id", "unknown")).strip() or "unknown"
        record_id = self._register_task_record(
            kind="client-task-inbox",
            node_id=sender,
            result={"status": "received", "ok": True, "message": message},
            request={
                "instruction": instruction,
                "source_message_id": message_id,
                "source_client_id": sender,
            },
        )
        self._inbound_task_request_records[message_id] = record_id
        self._save_conversation_state()

    def _load_task_request(self, message: dict[str, Any], *, overwrite_script: bool = True) -> None:
        payload = message.get("payload") if isinstance(message.get("payload"), dict) else {}
        instruction = str(payload.get("instruction", "")).strip()
        suggested_script = str(payload.get("suggested_script", "")).strip()
        message_id = str(message.get("message_id", "")).strip()
        self._latest_task_request = message
        self._active_task_request = message
        self.script_request_label.setText(
            f"Task request from {message.get('from_client_id', 'unknown')}\n"
            f"Message: {message.get('message_id')}\n"
            f"{instruction or 'No instruction text.'}"
        )
        if message_id != self._last_script_result_request_id:
            self._last_script_result = None
            self._last_script_result_request_id = ""
            self.script_result_text.clear()
            self._restore_script_result_for_request(message)
        if suggested_script and overwrite_script:
            self.script_editor.setPlainText(suggested_script)
            self._script_loaded_request_id = message_id
            self._script_loaded_text = suggested_script
        elif overwrite_script and not suggested_script:
            fallback = (
                "print('received task')\n"
                f"print({instruction!r})\n"
            )
            self.script_editor.setPlainText(fallback)
            self._script_loaded_request_id = message_id
            self._script_loaded_text = fallback

    def _restore_script_result_for_request(self, message: dict[str, Any]) -> bool:
        message_id = str(message.get("message_id", "")).strip()
        record_id = self._inbound_task_request_records.get(message_id, "")
        record = self._task_records.get(record_id)
        if not record:
            return False
        status = str(record.get("status", "")).strip()
        if status not in {"ready-to-return", "script-failed", "returned"}:
            return False
        result = record.get("result") if isinstance(record.get("result"), dict) else {}
        script_result = result.get("script_result") if isinstance(result.get("script_result"), dict) else {}
        if not script_result:
            return False
        self._last_script_result = script_result
        self._last_script_result_request_id = message_id
        self.script_result_text.setPlainText(
            json.dumps(
                self._script_result_display_payload(request=message, result=script_result),
                ensure_ascii=False,
                indent=2,
            )
        )
        return True

    def _can_replace_script_from_request(self) -> bool:
        current = self.script_editor.toPlainText()
        return (not current.strip()) or bool(self._script_loaded_request_id and current == self._script_loaded_text)

    def _should_auto_load_task_request(self, message: dict[str, Any]) -> bool:
        sender = str(message.get("from_client_id", "")).strip()
        return (not self._selected_peer_id.strip()) or sender == self._selected_peer_id.strip()

    def _latest_task_request_for_peer(self, peer_id: str) -> dict[str, Any] | None:
        peer = peer_id.strip()
        for message in reversed(self._conversation_messages):
            if str(message.get("type", "")).strip() != "task.request":
                continue
            if str(message.get("target_client_id", "")).strip() != self.config.client_id:
                continue
            if peer and str(message.get("from_client_id", "")).strip() != peer:
                continue
            return message
        return None

    def _load_latest_task_request_for_peer(self, peer_id: str, *, overwrite_script: bool) -> bool:
        request = self._latest_task_request_for_peer(peer_id)
        if not request:
            return False
        self._load_task_request(request, overwrite_script=overwrite_script)
        return True

    def _script_result_display_payload(self, *, request: dict[str, Any], result: dict[str, Any]) -> dict[str, Any]:
        return {
            "request_message_id": str(request.get("message_id", "")).strip(),
            "request_from_client_id": str(request.get("from_client_id", "")).strip(),
            "result": result,
        }

    def _refresh_peer_list(self) -> None:
        selected = self._selected_peer_id
        self._syncing_peer_selection = True
        self.peers_list.clear()
        try:
            for peer_id in sorted(self._client_peers):
                peer = self._client_peers[peer_id]
                stats = self._peer_conversation_stats(peer_id)
                item = QListWidgetItem(
                    f"{peer_id}\n"
                    f"Status: {peer.get('status', 'unknown')}\n"
                    f"Last seen: {peer.get('last_seen', '-')}\n"
                    f"Messages: {stats['messages']} | Unread: {stats['unread']} | Open: in={stats['open_inbound']} out={stats['open_outbound']}"
                )
                item.setData(Qt.UserRole, peer_id)
                item.setSizeHint(QSize(300, 94))
                self.peers_list.addItem(item)
                if peer_id == selected:
                    self.peers_list.setCurrentItem(item)
            if self.peers_list.currentItem() is None and self.peers_list.count() > 0:
                self.peers_list.setCurrentRow(0)
                item = self.peers_list.currentItem()
                peer_id = item.data(Qt.UserRole) if item is not None else None
                if isinstance(peer_id, str):
                    self._selected_peer_id = peer_id
                    self.peer_input.setText(peer_id)
        finally:
            self._syncing_peer_selection = False

    def _conversation_id(self, peer_id: str) -> str:
        pair = sorted([self.config.client_id, peer_id.strip()])
        return ":".join(pair)

    def _append_conversation_message(self, *, direction: str, message: dict[str, Any]) -> bool:
        message_id = str(message.get("message_id", "")).strip()
        if message_id and message_id in self._conversation_message_ids:
            return False
        row = dict(message)
        row["direction"] = direction
        self._conversation_messages.append(row)
        if message_id:
            self._conversation_message_ids.add(message_id)
        self._refresh_conversation_view()
        self._save_conversation_state()
        return True

    def _messages_for_peer(self, peer_id: str) -> list[dict[str, Any]]:
        peer = peer_id.strip()
        if not peer:
            return list(self._conversation_messages)
        rows: list[dict[str, Any]] = []
        for message in self._conversation_messages:
            sender = str(message.get("from_client_id", "")).strip()
            target = str(message.get("target_client_id", "")).strip()
            if peer in {sender, target}:
                rows.append(message)
        return rows

    def _message_peer_id(self, message: dict[str, Any]) -> str:
        sender = str(message.get("from_client_id", "")).strip()
        target = str(message.get("target_client_id", "")).strip()
        if sender and sender != self.config.client_id:
            return sender
        if target and target != self.config.client_id:
            return target
        return sender or target

    def _unread_count_for_peer(self, peer_id: str) -> int:
        cursor = self._peer_read_cursors.get(peer_id, "")
        seen_cursor = not cursor
        unread = 0
        for message in self._messages_for_peer(peer_id):
            message_id = str(message.get("message_id", "")).strip()
            if message_id and message_id == cursor:
                seen_cursor = True
                continue
            if not seen_cursor:
                continue
            direction = str(message.get("direction", "")).strip()
            if direction == "in":
                unread += 1
        return unread

    def _mark_peer_read(self, peer_id: str) -> bool:
        messages = self._messages_for_peer(peer_id)
        for message in reversed(messages):
            message_id = str(message.get("message_id", "")).strip()
            if message_id:
                if self._peer_read_cursors.get(peer_id) == message_id:
                    return False
                self._peer_read_cursors[peer_id] = message_id
                return True
        return False

    def _task_status_for_request_message(self, message: dict[str, Any]) -> str:
        msg_type = str(message.get("type", "")).strip()
        if msg_type != "task.request":
            return ""
        message_id = str(message.get("message_id", "")).strip()
        if not message_id:
            return ""
        target = str(message.get("target_client_id", "")).strip()
        if target == self.config.client_id:
            record_id = self._inbound_task_request_records.get(message_id)
        else:
            record_id = self._task_request_records.get(message_id)
        record = self._task_records.get(record_id or "")
        return str(record.get("status", "")).strip() if record else ""

    def _peer_conversation_stats(self, peer_id: str) -> dict[str, int | str]:
        messages = self._messages_for_peer(peer_id)
        open_inbound = 0
        open_outbound = 0
        for message in messages:
            if str(message.get("type", "")).strip() != "task.request":
                continue
            status = self._task_status_for_request_message(message)
            if str(message.get("target_client_id", "")).strip() == self.config.client_id:
                if status and status != "returned":
                    open_inbound += 1
            elif str(message.get("from_client_id", "")).strip() == self.config.client_id:
                if status and status not in {"completed", "failed"}:
                    open_outbound += 1
        if peer_id:
            unread = self._unread_count_for_peer(peer_id)
        else:
            unread = 0
            peer_ids = {self._message_peer_id(message) for message in messages}
            for message_peer_id in peer_ids:
                if message_peer_id:
                    unread += self._unread_count_for_peer(message_peer_id)
        last_ts = str(messages[-1].get("ts", "")) if messages else ""
        return {
            "messages": len(messages),
            "unread": unread,
            "open_inbound": open_inbound,
            "open_outbound": open_outbound,
            "last_ts": last_ts,
        }

    def _handle_task_result_message(self, message: dict[str, Any]) -> None:
        payload = message.get("payload") if isinstance(message.get("payload"), dict) else {}
        request_message_id = str(payload.get("request_message_id", "")).strip()
        result = payload.get("result") if isinstance(payload.get("result"), dict) else {}
        record_id = self._task_request_records.get(request_message_id)
        if record_id and record_id in self._task_records:
            record = self._task_records[record_id]
            ok = bool(result.get("ok", False))
            record["status"] = "completed" if ok else "failed"
            record["result"] = {
                "status": record["status"],
                "ok": ok,
                "message": message,
                "script_result": result,
            }
            record["artifacts"] = self._extract_artifacts(record["result"])
            record["timeline"].append(
                {
                    "ts": str(message.get("ts", datetime.now().isoformat(timespec="seconds"))),
                    "stage": "task.result",
                    "message": f"result ok={ok} returncode={result.get('returncode')}",
                }
            )
            self._refresh_task_item(record_id)
            self._refresh_queue_cards()
            self.refresh_history_table()
            self._refresh_task_detail_and_results()
            self._refresh_conversation_state_views()
            self._save_conversation_state()
        self._add_notification(
            level="info" if result.get("ok", False) else "warning",
            title=f"Task Result | {message.get('from_client_id', 'unknown')}",
            message=f"request={request_message_id or '-'} ok={result.get('ok')}",
            category="conversation",
            context=message,
        )

    def _refresh_task_item(self, record_id: str) -> None:
        record = self._task_records.get(record_id)
        if not record:
            return
        text = f"{record.get('kind')} | node={record.get('node_id')} | status={record.get('status')} | id={record_id}"
        for i in range(self.tasks_list.count()):
            item = self.tasks_list.item(i)
            if item is not None and item.data(Qt.UserRole) == record_id:
                item.setText(text)
                return

    def _refresh_conversation_state_views(self) -> None:
        self._refresh_peer_list()
        self._refresh_conversation_view()

    def _refresh_conversation_view(self) -> None:
        peer_id = self._selected_peer_id.strip()
        stats = self._peer_conversation_stats(peer_id) if peer_id else {
            **self._peer_conversation_stats(""),
        }
        self.conversation_title.setText(
            f"Conversation with {peer_id}" if peer_id else "Select or add a peer."
        )
        if peer_id:
            last_seen = stats.get("last_ts") or self._client_peers.get(peer_id, {}).get("last_seen", "-")
            self.conversation_summary_label.setText(
                f"Messages: {stats['messages']} | Unread: {stats['unread']} | Open inbound: {stats['open_inbound']} | "
                f"Open outbound: {stats['open_outbound']} | Last activity: {last_seen or '-'}"
            )
        else:
            self.conversation_summary_label.setText(
                f"All stored messages: {stats['messages']} | Unread: {stats['unread']} | "
                f"Open inbound: {stats['open_inbound']} | Open outbound: {stats['open_outbound']}. "
                "Select a peer to scope the conversation."
            )
        self.conversation_list.clear()
        for message in self._messages_for_peer(peer_id):
            sender = str(message.get("from_client_id", "")).strip()
            target = str(message.get("target_client_id", "")).strip()
            msg_type = str(message.get("type", "message"))
            direction = str(message.get("direction", "out"))
            payload = message.get("payload") if isinstance(message.get("payload"), dict) else {}
            if msg_type == "chat.message":
                body = str(payload.get("text", ""))
            elif msg_type == "task.request":
                status = self._task_status_for_request_message(message) or "untracked"
                body = f"TASK REQUEST [{status}]: " + str(payload.get("instruction", ""))
            elif msg_type == "task.result":
                result = payload.get("result") if isinstance(payload.get("result"), dict) else {}
                body = f"TASK RESULT: ok={result.get('ok')} returncode={result.get('returncode')}"
            else:
                body = json.dumps(payload, ensure_ascii=False)
            prefix = "IN" if direction == "in" else "OUT"
            item = QListWidgetItem(f"[{prefix}] {msg_type} | {message.get('ts', '')}\n{body}")
            item.setData(Qt.UserRole, message.get("message_id"))
            item.setData(Qt.UserRole + 1, message)
            self.conversation_list.addItem(item)
        if self.conversation_list.count() > 0:
            self.conversation_list.scrollToBottom()

    def _append_log(self, text: str) -> None:
        ts = datetime.now().strftime("%H:%M:%S")
        try:
            self.log_text.appendPlainText(f"[{ts}] {text}")
        except RuntimeError:
            logger.debug("log_text is no longer available", exc_info=True)
        logger.info("agswarm-ui %s", text)
        try:
            self.statusBar().showMessage(text, 5000)
        except RuntimeError:
            logger.debug("statusBar is no longer available", exc_info=True)

    def _set_connection_state(self, *, state: str, error: str = "") -> None:
        self._connection_state = state
        self._last_connection_error = error.strip()
        self._refresh_header()

    def _format_connect_error(self, exc: Exception) -> str:
        raw = str(exc).strip() or exc.__class__.__name__
        try:
            parsed = urlsplit(self.config.nats_url)
            host = parsed.hostname or "unknown-host"
            port = parsed.port or 0
            return (
                f"{raw}. target={host}:{port}. "
                "Check NATS URL / username / password / firewall / server status."
            )
        except Exception:
            return raw

    def _set_connection_feedback(self, text: str, *, level: str) -> None:
        if not hasattr(self, "connection_feedback_label"):
            return
        self.connection_feedback_label.setText(self._tr(f"Connection status: {text}"))
        if level == "ok":
            self.connection_feedback_label.setStyleSheet(
                "QLabel { background: #E8F8EE; color: #1D6E43; border: 1px solid #BDE7CB; border-radius: 8px; padding: 6px 8px; }"
            )
        elif level == "error":
            self.connection_feedback_label.setStyleSheet(
                "QLabel { background: #FDEDED; color: #A23535; border: 1px solid #F3C5C5; border-radius: 8px; padding: 6px 8px; }"
            )
        else:
            self.connection_feedback_label.setStyleSheet(
                "QLabel { background: #EEF2F6; color: #334A62; border: 1px solid #D3DEE9; border-radius: 8px; padding: 6px 8px; }"
            )

    def _add_notification(
        self,
        *,
        level: str,
        title: str,
        message: str,
        category: str,
        context: dict[str, Any] | None = None,
    ) -> None:
        level_text = self._normalize_notification_level(level)
        title_text = title.strip()
        message_text = message.strip()
        category_text = category.strip() or "general"
        context_payload = context or {}
        now_iso = datetime.now().isoformat(timespec="seconds")
        now_mono = monotonic()
        fingerprint = self._notification_fingerprint(
            level=level_text,
            title=title_text,
            message=message_text,
            category=category_text,
            context=context_payload,
        )
        self._prune_recent_notifications(now_mono=now_mono)
        recent = self._notification_recent.get(fingerprint)
        if recent is not None:
            last_seen_mono, notification_id = recent
            if (now_mono - last_seen_mono) <= self._notification_dedupe_window_sec:
                existing = self._notification_by_id(notification_id)
                if existing is not None:
                    existing["count"] = int(existing.get("count", 1)) + 1
                    existing["last_ts"] = now_iso
                    existing["read"] = False
                    existing["context"] = context_payload
                    self._notification_recent[fingerprint] = (now_mono, notification_id)
                    self._refresh_notifications_view()
                    return

        self._notification_index += 1
        notification_id = f"n-{self._notification_index:06d}"
        payload = {
            "id": notification_id,
            "ts": now_iso,
            "first_ts": now_iso,
            "last_ts": now_iso,
            "count": 1,
            "read": False,
            "level": level_text,
            "title": title_text,
            "message": message_text,
            "category": category_text,
            "context": context_payload,
        }
        self._notifications.append(payload)
        self._notification_recent[fingerprint] = (now_mono, notification_id)
        if len(self._notifications) > self._notification_max_items:
            overflow = len(self._notifications) - self._notification_max_items
            if overflow > 0:
                self._notifications = self._notifications[overflow:]
        self._refresh_notifications_view()

    def _normalize_notification_level(self, level: str) -> str:
        text = level.strip().lower()
        if text in {"error", "warning", "info"}:
            return text
        if text in {"warn"}:
            return "warning"
        return "info"

    def _notification_fingerprint(
        self,
        *,
        level: str,
        title: str,
        message: str,
        category: str,
        context: dict[str, Any],
    ) -> str:
        key_parts = [
            category,
            level,
            title,
            message,
            str(context.get("record_id", "")),
            str(context.get("node_id", "")),
            str(context.get("source_path", "")),
            str(context.get("mode", "")),
            str(context.get("command", "")),
        ]
        return "|".join(part.strip().lower() for part in key_parts)

    def _prune_recent_notifications(self, *, now_mono: float) -> None:
        stale: list[str] = []
        for fingerprint, item in self._notification_recent.items():
            seen_mono, notification_id = item
            if (now_mono - seen_mono) > NOTIFICATION_RECENT_PRUNE_SEC:
                stale.append(fingerprint)
                continue
            if self._notification_by_id(notification_id) is None:
                stale.append(fingerprint)
        for fingerprint in stale:
            self._notification_recent.pop(fingerprint, None)

    def _refresh_notifications_view(self) -> None:
        total = len(self._notifications)
        errors = sum(1 for item in self._notifications if str(item.get("level", "")).lower() == "error")
        warns = sum(1 for item in self._notifications if str(item.get("level", "")).lower() == "warning")
        unread_total = sum(1 for item in self._notifications if not bool(item.get("read", False)))
        self._refresh_notification_category_filter_options()
        level_filter = str(self.notifications_level_filter_input.currentData() or "all").strip().lower()
        category_filter = str(self.notifications_category_filter_input.currentData() or "all").strip().lower()
        read_filter = str(self.notifications_read_filter_input.currentData() or "all").strip().lower()
        search_text = self.notifications_search_input.text().strip().lower()
        selected_id = None
        current = self.notifications_list.currentItem()
        if current is not None:
            selected_id = current.data(Qt.UserRole)
        self._syncing_notification_selection = True
        self.notifications_list.clear()
        visible = 0
        for item in reversed(self._notifications):
            level_value = str(item.get("level", "info")).strip().lower()
            category_value = str(item.get("category", "general")).strip().lower() or "general"
            read_value = bool(item.get("read", False))
            if level_filter != "all" and level_value != level_filter:
                continue
            if category_filter != "all" and category_value != category_filter:
                continue
            if read_filter == "unread" and read_value:
                continue
            if search_text:
                blob = (
                    f"{item.get('title', '')} {item.get('message', '')} "
                    f"{item.get('category', '')} {item.get('id', '')}"
                ).lower()
                if search_text not in blob:
                    continue
            level = str(item.get("level", "info")).upper()
            ts = str(item.get("last_ts", item.get("ts", "")))
            title = str(item.get("title", ""))
            count = int(item.get("count", 1))
            suffix = f" x{count}" if count > 1 else ""
            unread_prefix = "[NEW] " if (not read_value) else ""
            list_text = f"{unread_prefix}[{level}] {title}{suffix} | {ts}"
            row = QListWidgetItem(list_text)
            row.setData(Qt.UserRole, item.get("id"))
            self.notifications_list.addItem(row)
            font = row.font()
            font.setBold(not read_value)
            row.setFont(font)
            if level == "ERROR":
                row.setForeground(QColor("#A23535"))
            elif level == "WARNING":
                row.setForeground(QColor("#8A5A16"))
            visible += 1
        self._syncing_notification_selection = False
        self.notifications_summary_label.setText(
            f"{visible}/{total} notifications | unread={unread_total} | error={errors} warning={warns}"
        )
        if self.notifications_list.count() == 0:
            self.notification_detail_text.setPlainText("")
            return
        if isinstance(selected_id, str) and selected_id:
            for i in range(self.notifications_list.count()):
                row = self.notifications_list.item(i)
                if row is not None and row.data(Qt.UserRole) == selected_id:
                    self.notifications_list.setCurrentRow(i)
                    return
        self.notifications_list.setCurrentRow(0)

    def _refresh_notification_category_filter_options(self) -> None:
        current = str(self.notifications_category_filter_input.currentData() or "all").strip().lower()
        categories = {"all"}
        for item in self._notifications:
            text = str(item.get("category", "general")).strip().lower()
            categories.add(text or "general")
        options = sorted(categories)
        self.notifications_category_filter_input.blockSignals(True)
        self.notifications_category_filter_input.clear()
        for value in options:
            if value == "all":
                self.notifications_category_filter_input.addItem("All Categories", "all")
            else:
                self.notifications_category_filter_input.addItem(value, value)
        target = current if current in options else "all"
        index = self.notifications_category_filter_input.findData(target)
        if index >= 0:
            self.notifications_category_filter_input.setCurrentIndex(index)
        self.notifications_category_filter_input.blockSignals(False)

    def _notification_by_id(self, notification_id: str) -> dict[str, Any] | None:
        for item in self._notifications:
            if item.get("id") == notification_id:
                return item
        return None

    def _iter_manual_node_candidates(self) -> list[str]:
        raw = self.node_input.text().strip()
        if not raw:
            return []
        items: list[str] = []
        seen: set[str] = set()
        for item in raw.split(","):
            text = item.strip()
            if not text or text in seen:
                continue
            items.append(text)
            seen.add(text)
        return items

    def _iter_node_candidates(self) -> list[str]:
        manual = self._iter_manual_node_candidates()
        merged = list(manual)
        seen = set(manual)
        for node_id in sorted(self._discovered_nodes):
            if node_id in seen:
                continue
            merged.append(node_id)
            seen.add(node_id)
        return merged

    def _extract_mcp_services(self, snapshot: dict[str, Any]) -> list[str]:
        payload = snapshot.get("mcp_services")
        if not isinstance(payload, list):
            return []
        values: list[str] = []
        for item in payload:
            if not isinstance(item, dict):
                continue
            service = str(item.get("service") or item.get("adapter") or "").strip()
            if service:
                values.append(service)
        return values

    async def _poll_nodes_loop(self) -> None:
        while self._running:
            try:
                await self._refresh_nodes()
            except Exception as exc:  # pragma: no cover
                logger.exception("poll nodes failed")
                self._append_log(f"poll failed: {exc}")
            await asyncio.sleep(max(0.5, self.config.poll_interval_sec))

    async def _refresh_nodes(self) -> dict[str, Any]:
        await self._refresh_discovered_nodes()
        node_ids = self._iter_node_candidates()
        if not node_ids:
            self._last_snapshots = []
            self.nodes_list.clear()
            self.node_count_label.setText("0 active")
            self._refresh_header()
            return {"node_count": 0, "active_count": 0, "error_count": 0, "sample_error": ""}
        snapshots: list[tuple[str, dict | None]] = []
        errors: list[str] = []
        for node_id in node_ids:
            try:
                snap = await self.service.request_node_snapshot(node_id=node_id, timeout_sec=1.5)
                snapshots.append((node_id, snap))
            except Exception as exc:
                snapshots.append((node_id, None))
                errors.append(str(exc).strip() or exc.__class__.__name__)
        self._last_snapshots = snapshots
        await self._maybe_sync_config_to_nodes(snapshots)
        self.nodes_list.clear()
        active_count = 0
        for node_id, snap in snapshots:
            discovered = self._discovered_nodes.get(node_id)
            if snap is None:
                if discovered is None:
                    text = (
                        f"{node_id}\n"
                        f"OFFLINE\n"
                        f"Capabilities: unknown\n"
                        f"CPU: n/a   Memory: n/a"
                    )
                else:
                    discovered_state = discovered.status.upper() if discovered.status else "DISCOVERED"
                    text = (
                        f"{node_id}\n"
                        f"{discovered_state} (LAN announce)\n"
                        f"Capabilities: announced by host\n"
                        f"Host: {discovered.hostname or discovered.source_ip}  NATS: {discovered.nats_url}"
                    )
            else:
                active_count += 1
                active = int(snap.get("active_tasks", 0))
                queued = int(snap.get("queued_tasks", 0))
                state = "IDLE" if (active == 0 and queued == 0) else f"BUSY {min(99, 22 + active * 28 + queued * 12)}%"
                status = str(snap.get("status", "unknown"))
                adapters = snap.get("adapters")
                mcp_services = self._extract_mcp_services(snap)
                if mcp_services:
                    capabilities = "mcp:" + ",".join(mcp_services[:2])
                elif isinstance(adapters, list) and adapters:
                    capabilities = ",".join(str(x) for x in adapters[:3])
                else:
                    capabilities = "runtime"
                text = (
                    f"{node_id}\n"
                    f"{state}\n"
                    f"Capabilities: {capabilities}\n"
                    f"Status: {status}  Active: {active}  Queued: {queued}"
                )
            item = QListWidgetItem(text)
            item.setSizeHint(QSize(320, 96))
            self.nodes_list.addItem(item)
        self.node_count_label.setText(f"{active_count} active")
        self._apply_node_search_filter()
        if len(errors) == len(node_ids) and errors:
            self._set_connection_state(state="disconnected", error=errors[0])
        elif active_count > 0:
            self._set_connection_state(state="connected")
        self._refresh_header()
        return {
            "node_count": len(node_ids),
            "active_count": active_count,
            "error_count": len(errors),
            "sample_error": errors[0] if errors else "",
        }

    def _apply_node_search_filter(self) -> None:
        pattern = self.node_search_input.text().strip().lower()
        for i in range(self.nodes_list.count()):
            item = self.nodes_list.item(i)
            if item is None:
                continue
            visible = (not pattern) or (pattern in item.text().lower())
            item.setHidden(not visible)

    def _target_node(self) -> str:
        return self.target_input.text().strip()

    def _selected_skills(self) -> list[str]:
        raw = self.skills_input.text().strip()
        if not raw:
            return []
        return [x.strip() for x in raw.split(",") if x.strip()]

    def _required_adapters(self) -> list[str]:
        raw = self.required_adapters_input.text().strip()
        if not raw:
            return []
        return [x.strip() for x in raw.split(",") if x.strip()]

    def _register_task_record(
        self,
        *,
        kind: str,
        node_id: str,
        result: dict[str, Any],
        request: dict[str, Any] | None = None,
    ) -> str:
        self._task_index += 1
        task_id = str(result.get("task_id", "")).strip()
        record_id = task_id or f"{kind}-{self._task_index:04d}"
        created_at = datetime.now().isoformat(timespec="seconds")
        record = {
            "record_id": record_id,
            "kind": kind,
            "node_id": node_id,
            "created_at": created_at,
            "status": result.get("status", "unknown"),
            "result": result,
            "request": request or {},
            "artifacts": self._extract_artifacts(result),
            "timeline": self._build_timeline(kind=kind, created_at=created_at, result=result),
        }
        self._task_records[record_id] = record
        if record_id not in self._task_order:
            self._task_order.append(record_id)
        item = QListWidgetItem(f"{kind} | node={node_id} | status={record['status']} | id={record_id}")
        item.setData(Qt.UserRole, record_id)
        self.tasks_list.addItem(item)
        self.tasks_list.setCurrentItem(item)
        self._refresh_queue_cards()
        self.refresh_history_table()
        self._notify_task_record(record)
        return record_id

    def _notify_task_record(self, record: dict[str, Any]) -> None:
        status = str(record.get("status", "")).strip().lower()
        if status not in {"failed", "error", "cancelled", "canceled"}:
            return
        result = record.get("result")
        if not isinstance(result, dict):
            result = {}
        summary = build_error_summary(result)
        code = str(summary.get("code", "")).strip()
        message = str(summary.get("message", "")).strip()
        if not message:
            user_rows = summary.get("user_messages")
            if isinstance(user_rows, list) and user_rows:
                message = str(user_rows[0]).strip()
        if not message:
            message = "Task failed. See Task Detail."
        title = f"Task Failed | {record.get('record_id')} | {record.get('kind')}"
        if code:
            title += f" | {code}"
        self._add_notification(
            level="error",
            title=title,
            message=message,
            category="task",
            context={
                "record_id": record.get("record_id"),
                "kind": record.get("kind"),
                "node_id": record.get("node_id"),
                "status": record.get("status"),
                "error_summary": summary,
                "request": record.get("request"),
            },
        )

    def _refresh_queue_cards(self) -> None:
        if not self._task_order:
            self._latest_failed_record_id = None
            self._latest_failed_context = None
            self.running_title.setText("No running task")
            self.running_body.setText("Waiting for task dispatch.")
            self.completed_title.setText("No completed task")
            self.completed_body.setText("Artifacts will appear after first completed task.")
            self.queue_alert_label.setText("No failure alerts.")
            self.queue_alert_label.setStyleSheet(
                "QLabel { background: #F4F7FB; color: #55687D; border: 1px solid #D8E2ED; border-radius: 8px; padding: 8px; }"
            )
            self.queue_alert_open_btn.setEnabled(False)
            self.queue_alert_copy_btn.setEnabled(False)
            self.queue_alert_export_btn.setEnabled(False)
            self.queue_alert_retry_btn.setEnabled(False)
            return

        latest = [self._task_records[rid] for rid in self._task_order if rid in self._task_records]
        running = None
        completed = None
        failed = None
        for rec in reversed(latest):
            status = str(rec.get("status", "")).lower()
            if running is None and status in {"running", "accepted"}:
                running = rec
            if completed is None and status in {"succeeded", "completed"}:
                completed = rec
            if failed is None and status in {"failed", "error", "cancelled", "canceled"}:
                failed = rec
            if running is not None and completed is not None and failed is not None:
                break
        if running is None:
            recent = latest[-1]
            self.running_title.setText(f"Latest Task | {recent.get('status', 'unknown')}")
            self.running_title.setStyleSheet("color:#50397A;")
            self.running_body.setText(
                f"Node: {recent.get('node_id')}\nKind: {recent.get('kind')}\nID: {recent.get('record_id')}"
            )
        else:
            self.running_title.setText(f"Running | {running.get('record_id')}")
            self.running_title.setStyleSheet("color:#A65A1F;")
            self.running_body.setText(
                f"Node: {running.get('node_id')}\nKind: {running.get('kind')}\nStatus: {running.get('status')}"
            )

        if completed is None:
            self.completed_title.setText("No completed task")
            self.completed_title.setStyleSheet("color:#3F2D62;")
            self.completed_body.setText("Artifacts will appear after first completed task.")
        else:
            artifacts = completed.get("artifacts", [])
            count = len(artifacts) if isinstance(artifacts, list) else 0
            self.completed_title.setText(f"Completed | {completed.get('record_id')}")
            self.completed_title.setStyleSheet("color:#2C6A3E;")
            self.completed_body.setText(
                f"Node: {completed.get('node_id')}\nKind: {completed.get('kind')}\nArtifacts: {count}"
            )

        if failed is None:
            self._latest_failed_record_id = None
            self._latest_failed_context = None
            self.queue_alert_label.setText("No failure alerts.")
            self.queue_alert_label.setStyleSheet(
                "QLabel { background: #F4F7FB; color: #55687D; border: 1px solid #D8E2ED; border-radius: 8px; padding: 8px; }"
            )
            self.queue_alert_open_btn.setEnabled(False)
            self.queue_alert_copy_btn.setEnabled(False)
            self.queue_alert_export_btn.setEnabled(False)
            return

        failed_record_id = str(failed.get("record_id", "")).strip()
        self._latest_failed_record_id = failed_record_id or None
        failed_result = failed.get("result")
        if not isinstance(failed_result, dict):
            failed_result = {}
        failed_summary = build_error_summary(failed_result)
        self._latest_failed_context = self._build_failed_context(record=failed, summary=failed_summary)
        summary_text = ""
        user_rows = failed_summary.get("user_messages")
        if isinstance(user_rows, list) and user_rows:
            summary_text = str(user_rows[0])
        if not summary_text:
            summary_text = str(failed_summary.get("message", "")).strip()
        if not summary_text:
            summary_text = "See Task Detail for full diagnostics."
        code = str(failed_summary.get("code", "")).strip()
        code_info = f" | {code}" if code else ""
        self.queue_alert_label.setText(
            f"Failure Alert | {failed.get('record_id')}{code_info}\n"
            f"Node: {failed.get('node_id')}  Kind: {failed.get('kind')}\n"
            f"{summary_text}"
        )
        self.queue_alert_label.setStyleSheet(
            "QLabel { background: #FDEDED; color: #A23535; border: 1px solid #F3C5C5; border-radius: 8px; padding: 8px; font-weight: 600; }"
        )
        has_failed = self._latest_failed_record_id is not None and self._latest_failed_context is not None
        self.queue_alert_open_btn.setEnabled(has_failed)
        self.queue_alert_copy_btn.setEnabled(has_failed)
        self.queue_alert_export_btn.setEnabled(has_failed)
        self.queue_alert_retry_btn.setEnabled(has_failed)

    def _build_failed_context(self, *, record: dict[str, Any], summary: dict[str, Any]) -> dict[str, Any]:
        result = record.get("result")
        if not isinstance(result, dict):
            result = {}
        request = record.get("request")
        if not isinstance(request, dict):
            request = {}
        timeline = record.get("timeline")
        if not isinstance(timeline, list):
            timeline = []
        return {
            "record_id": record.get("record_id"),
            "kind": record.get("kind"),
            "node_id": record.get("node_id"),
            "created_at": record.get("created_at"),
            "status": record.get("status"),
            "error_summary": summary,
            "request": request,
            "timeline": timeline,
            "result": result,
        }

    def _extract_artifacts(self, payload: Any) -> list[str]:
        values: list[str] = []

        def _visit(node: Any) -> None:
            if isinstance(node, dict):
                for key, value in node.items():
                    if key in PATH_KEYS and isinstance(value, str) and value.strip():
                        values.append(value.strip())
                    else:
                        _visit(value)
            elif isinstance(node, list):
                for item in node:
                    _visit(item)

        _visit(payload)
        unique: list[str] = []
        seen = set()
        for value in values:
            if value in seen:
                continue
            seen.add(value)
            unique.append(value)
        return unique

    def _build_timeline(self, *, kind: str, created_at: str, result: dict[str, Any]) -> list[dict[str, str]]:
        timeline: list[dict[str, str]] = []
        timeline.append({"ts": created_at, "stage": "created", "message": f"{kind} task created"})
        if kind == "upload":
            for item in result.get("uploaded", []):
                timeline.append(
                    {
                        "ts": created_at,
                        "stage": "uploaded",
                        "message": f"{item.get('source_path')} -> {item.get('saved_rel_path') or item.get('saved_path')}",
                    }
                )
            for item in result.get("failed", []):
                timeline.append(
                    {
                        "ts": created_at,
                        "stage": "upload_failed",
                        "message": f"{item.get('source_path')}: {item.get('error')}",
                    }
                )
            return timeline
        terminal = result.get("terminal_event")
        if isinstance(terminal, dict):
            timeline.append(
                {
                    "ts": str(terminal.get("ts", created_at)),
                    "stage": str(terminal.get("type", "terminal")),
                    "message": str(terminal.get("payload", {})),
                }
            )
        for msg in result.get("user_messages", []):
            if isinstance(msg, dict):
                timeline.append(
                    {
                        "ts": created_at,
                        "stage": str(msg.get("level", "info")),
                        "message": str(msg.get("message", "")),
                    }
                )
        return timeline

    def _current_record(self) -> dict[str, Any] | None:
        item = self.tasks_list.currentItem()
        if item is None:
            return None
        record_id = item.data(Qt.UserRole)
        if not isinstance(record_id, str):
            return None
        return self._task_records.get(record_id)

    def _record_by_id(self, record_id: str) -> dict[str, Any] | None:
        return self._task_records.get(record_id)

    def _is_failed_status(self, status: str) -> bool:
        return status.strip().lower() in {"failed", "error", "cancelled", "canceled"}

    def _record_error_code(self, record: dict[str, Any]) -> str:
        result = record.get("result")
        if not isinstance(result, dict):
            result = {}
        summary = build_error_summary(result)
        code = str(summary.get("code", "")).strip()
        if code:
            return code
        return extract_error_code(result).strip()

    def _build_history_recovery_meta(self, record: dict[str, Any]) -> dict[str, Any]:
        request = record.get("request")
        if not isinstance(request, dict):
            request = {}
        rerun_of = str(request.get("rerun_of", "")).strip()
        rerun_trigger = str(request.get("rerun_trigger", "")).strip()
        rerouted_from = str(request.get("rerouted_from", "")).strip()
        is_rerun = bool(rerun_of)
        source_status = ""
        source_kind = ""
        source_node = ""
        source_error_code = ""
        if rerun_of:
            source = self._task_records.get(rerun_of)
            if isinstance(source, dict):
                source_status = str(source.get("status", "")).strip()
                source_kind = str(source.get("kind", "")).strip()
                source_node = str(source.get("node_id", "")).strip()
                source_error_code = self._record_error_code(source)
        return {
            "record_id": record.get("record_id"),
            "status": record.get("status"),
            "kind": record.get("kind"),
            "node_id": record.get("node_id"),
            "error_code": self._record_error_code(record),
            "is_rerun": is_rerun,
            "rerun_of": rerun_of,
            "rerun_trigger": rerun_trigger,
            "rerouted_from": rerouted_from,
            "source_status": source_status,
            "source_kind": source_kind,
            "source_node": source_node,
            "source_error_code": source_error_code,
        }

    def _parse_retry_batch_skip_kinds(self, raw: str) -> set[str]:
        values: set[str] = set()
        for part in raw.split(","):
            text = part.strip().lower()
            if not text:
                continue
            if text in RETRY_BATCH_SUPPORTED_KINDS:
                values.add(text)
        return values

    def _sync_retry_batch_runtime_inputs(self) -> None:
        limit_text = self.retry_batch_limit_input.text().strip()
        try:
            value = int(limit_text or "3")
        except ValueError:
            value = 3
        value = max(1, min(value, self._retry_batch_max_limit))
        self.retry_batch_limit_input.setText(str(value))

    def _retry_reroute_kinds(self) -> set[str]:
        mode = self._retry_reroute_mode.strip().lower()
        if mode == "echo_only":
            return {"echo"}
        if mode == "echo_upload":
            return {"echo", "upload"}
        if mode == "all_supported":
            return {"echo", "upload", "latex"}
        return set()

    def _as_int(self, value: Any, default: int = 0) -> int:
        try:
            return int(value)
        except Exception:
            return default

    def _select_retry_target_node(self, *, original_node_id: str, kind: str, trigger: str) -> tuple[str, str]:
        if trigger == "selected-task":
            return original_node_id, "reroute-manual-rerun-disabled"
        allowed_kinds = self._retry_reroute_kinds()
        if kind.strip().lower() not in allowed_kinds:
            return original_node_id, "reroute-disabled"
        candidates: list[tuple[int, int, int, str]] = []
        original_score: int | None = None
        for node_id, snap in self._last_snapshots:
            if not isinstance(snap, dict):
                continue
            status = str(snap.get("status", "unknown")).strip().lower()
            active = max(0, self._as_int(snap.get("active_tasks", 0), 0))
            queued = max(0, self._as_int(snap.get("queued_tasks", 0), 0))
            can_accept = bool(snap.get("can_accept_tasks", status != "stopped"))
            agent_ready = bool(snap.get("agent_ready", can_accept))
            if not can_accept or not agent_ready:
                continue
            score = active * 10 + queued * 5
            candidates.append((score, active, queued, node_id))
            if node_id == original_node_id:
                original_score = score
        if not candidates:
            return original_node_id, "reroute-no-candidate"
        candidates.sort(key=lambda item: (item[0], item[1], item[2], item[3]))
        best_score, _best_active, _best_queued, best_node = candidates[0]
        if best_node == original_node_id:
            return original_node_id, "reroute-keep-original"
        if original_score is None:
            return best_node, f"reroute-offline-or-unready:{best_score}"
        if best_score + 1 < original_score:
            return best_node, f"reroute-better-load:{original_score}->{best_score}"
        return original_node_id, f"reroute-keep-original:{original_score}"

    def _resolve_local_path(self, raw: str) -> Path:
        path = Path(raw)
        if path.is_absolute():
            return path
        return Path.cwd() / path

    def _refresh_task_detail_and_results(self) -> None:
        record = self._current_record()
        if record is None:
            self.detail_header.setText("Select a task item from Task Center.")
            self.detail_status_badge.setText("Status: -")
            self.detail_status_badge.setStyleSheet(
                "QLabel { background: #EAF1FB; color: #1D3F66; border: 1px solid #C7D8F0; border-radius: 10px; padding: 4px 10px; font-weight: 700; }"
            )
            self.detail_error_badge.setText("Error: none")
            self.detail_error_badge.setStyleSheet(
                "QLabel { background: #EEF2F6; color: #4E6074; border: 1px solid #D3DEE9; border-radius: 10px; padding: 4px 10px; font-weight: 700; }"
            )
            self.detail_user_message.setText("User message: -")
            self.timeline_text.setPlainText("")
            self.detail_text.setPlainText("")
            self.results_list.clear()
            self.quick_artifact_list.clear()
            self.preview_meta_text.setPlainText("")
            self.preview_image_label.setText("No image selected.")
            self.preview_image_label.setPixmap(QPixmap())
            return
        self.detail_header.setText(
            f"Task: {record['record_id']} | kind={record['kind']} | node={record['node_id']} | status={record['status']}"
        )
        result = record.get("result")
        if not isinstance(result, dict):
            result = {}
        self._refresh_task_detail_meta(record=record, result=result)
        self.detail_text.setPlainText(json.dumps(result, ensure_ascii=False, indent=2))
        timeline = record.get("timeline")
        if not isinstance(timeline, list):
            timeline = []
        timeline_lines = [f"[{row.get('ts')}] {row.get('stage')}: {row.get('message')}" for row in timeline]
        self.timeline_text.setPlainText("\n".join(timeline_lines))
        self.results_list.clear()
        self.quick_artifact_list.clear()
        for raw in record.get("artifacts", []):
            self.results_list.addItem(raw)
            self.quick_artifact_list.addItem(raw)
        if self.results_list.count() > 0:
            self.results_list.setCurrentRow(0)
            self.quick_artifact_list.setCurrentRow(0)
        else:
            self.preview_meta_text.setPlainText("No artifact paths found in task result.")
            self.preview_image_label.setText("No image selected.")
            self.preview_image_label.setPixmap(QPixmap())

    def _refresh_task_detail_meta(self, *, record: dict[str, Any], result: dict[str, Any]) -> None:
        status = str(record.get("status", "unknown")).strip() or "unknown"
        status_lower = status.lower()
        if status_lower in {"succeeded", "completed"}:
            status_style = (
                "QLabel { background: #E8F8EE; color: #1D6E43; border: 1px solid #BDE7CB; border-radius: 10px; "
                "padding: 4px 10px; font-weight: 700; }"
            )
        elif status_lower in {"failed", "error"}:
            status_style = (
                "QLabel { background: #FDEDED; color: #A23535; border: 1px solid #F3C5C5; border-radius: 10px; "
                "padding: 4px 10px; font-weight: 700; }"
            )
        elif status_lower in {"running", "accepted"}:
            status_style = (
                "QLabel { background: #FFF6E8; color: #8A5A16; border: 1px solid #F0D6A9; border-radius: 10px; "
                "padding: 4px 10px; font-weight: 700; }"
            )
        else:
            status_style = (
                "QLabel { background: #EAF1FB; color: #1D3F66; border: 1px solid #C7D8F0; border-radius: 10px; "
                "padding: 4px 10px; font-weight: 700; }"
            )
        self.detail_status_badge.setText(f"Status: {status}")
        self.detail_status_badge.setStyleSheet(status_style)

        error_summary = build_error_summary(result)
        error_code = str(error_summary.get("code", "")).strip()
        error_message = str(error_summary.get("message", "")).strip()
        if error_code:
            mapped = str(error_summary.get("label", "")).strip() or ERROR_CODE_LABELS.get(error_code, "Unknown Error")
            self.detail_error_badge.setText(f"Error: {error_code} ({mapped})")
            self.detail_error_badge.setStyleSheet(
                "QLabel { background: #FDEDED; color: #A23535; border: 1px solid #F3C5C5; border-radius: 10px; "
                "padding: 4px 10px; font-weight: 700; }"
            )
        else:
            self.detail_error_badge.setText("Error: none")
            self.detail_error_badge.setStyleSheet(
                "QLabel { background: #EEF2F6; color: #4E6074; border: 1px solid #D3DEE9; border-radius: 10px; "
                "padding: 4px 10px; font-weight: 700; }"
            )

        user_message_lines = error_summary.get("user_messages")
        if not isinstance(user_message_lines, list):
            user_message_lines = []
        user_message_lines = [str(x) for x in user_message_lines if str(x).strip()]
        if not user_message_lines and error_message:
            user_message_lines = [f"[error] {error_message}"]
        if user_message_lines:
            self.detail_user_message.setText("User message:\n" + "\n".join(user_message_lines[:4]))
        else:
            self.detail_user_message.setText("User message: -")

    def _update_result_preview(self) -> None:
        item = self.results_list.currentItem()
        if item is None:
            self.preview_meta_text.setPlainText("")
            self.preview_image_label.setText("No artifact selected.")
            self.preview_image_label.setPixmap(QPixmap())
            return
        raw_path = item.text()
        resolved = self._resolve_local_path(raw_path)
        exists = resolved.exists()
        meta = {
            "raw_path": raw_path,
            "resolved_path": str(resolved),
            "exists": exists,
            "size_bytes": resolved.stat().st_size if exists and resolved.is_file() else None,
        }
        self.preview_meta_text.setPlainText(json.dumps(meta, ensure_ascii=False, indent=2))
        suffix = resolved.suffix.lower()
        if exists and suffix in {".png", ".jpg", ".jpeg", ".bmp", ".gif", ".webp"}:
            pixmap = QPixmap(str(resolved))
            if not pixmap.isNull():
                scaled = pixmap.scaled(
                    self.preview_image_label.size(),
                    Qt.KeepAspectRatio,
                    Qt.SmoothTransformation,
                )
                self.preview_image_label.setPixmap(scaled)
                self.preview_image_label.setText("")
                return
        self.preview_image_label.setPixmap(QPixmap())
        if exists:
            self.preview_image_label.setText(f"Preview not available for: {resolved.name}")
        else:
            self.preview_image_label.setText("Artifact path not found locally.")

    @asyncSlot()
    async def on_connect_clicked(self) -> None:
        self.connect_btn.setEnabled(False)
        self._set_connection_feedback("Connecting...", level="info")
        try:
            await asyncio.wait_for(self.service.connect(), timeout=CONNECT_TIMEOUT_SEC)
            self._append_log(f"connected to nats: {self.config.nats_url}")
            self._set_connection_state(state="connected")
            self._set_connection_feedback("Connected", level="ok")
            self._add_notification(
                level="info",
                title="Connected",
                message=f"Connected to {self.config.nats_url}",
                category="network",
                context={"nats_url": self.config.nats_url},
            )
        except Exception as exc:
            detail = self._format_connect_error(exc)
            self._append_log(f"connect failed: {detail}")
            self._set_connection_state(state="disconnected", error=detail)
            self._set_connection_feedback(f"Connect failed: {detail}", level="error")
            self._add_notification(
                level="warning",
                title="Connect Failed",
                message=detail,
                category="network",
                context={"nats_url": self.config.nats_url},
            )
        finally:
            self.connect_btn.setEnabled(True)

    @asyncSlot()
    async def on_refresh_nodes_clicked(self) -> None:
        self.refresh_btn.setEnabled(False)
        self._set_connection_feedback("Refreshing nodes...", level="info")
        try:
            await asyncio.wait_for(self.service.connect(), timeout=CONNECT_TIMEOUT_SEC)
            self._set_connection_state(state="connected")
            summary = await self._refresh_nodes()
            online = sum(1 for _, snap in self._last_snapshots if snap is not None)
            total = len(self._iter_node_candidates())
            discovered = len(self._discovered_nodes)
            error_count = int(summary.get("error_count", 0))
            sample_error = str(summary.get("sample_error", "")).strip()
            if total == 0:
                self._add_notification(
                    level="warning",
                    title="No Nodes Configured",
                    message="No manual or discovered nodes available. Check NATS URL and discovery settings.",
                    category="network",
                    context={"nats_url": self.config.nats_url},
                )
                self._set_connection_feedback("No nodes configured/discovered", level="error")
            elif error_count == total and sample_error:
                detail = self._format_connect_error(RuntimeError(sample_error))
                self._set_connection_state(state="disconnected", error=detail)
                self._set_connection_feedback(f"Refresh failed: {detail}", level="error")
            elif online == 0:
                self._set_connection_feedback(
                    f"Connected but no online nodes (0/{total}, discovered={discovered})",
                    level="info",
                )
            else:
                self._set_connection_feedback(
                    f"Refresh ok: online={online}/{total}, discovered={discovered}",
                    level="ok",
                )
            self._append_log(
                f"nodes refreshed: online={online}/{total} lan_discovered={discovered} errors={error_count}"
            )
        except Exception as exc:
            detail = self._format_connect_error(exc)
            self._append_log(f"nodes refresh failed: {detail}")
            self._set_connection_state(state="disconnected", error=detail)
            self._set_connection_feedback(f"Refresh failed: {detail}", level="error")
            self._add_notification(
                level="warning",
                title="Nodes Refresh Failed",
                message=detail,
                category="network",
                context={"nats_url": self.config.nats_url},
            )
        finally:
            self.refresh_btn.setEnabled(True)

    @asyncSlot()
    async def on_sync_config_clicked(self) -> None:
        node_id = self._target_node()
        if not node_id:
            item = self.nodes_list.currentItem()
            if item is not None:
                node_id = item.text().splitlines()[0].strip()
        if not node_id:
            QMessageBox.warning(self, "Missing target", "Please select or input target node id.")
            return
        payload, digest = self._build_config_sync_payload()
        ok = await self._sync_node_config_once(
            node_id=node_id,
            payload=payload,
            digest=digest,
            now=monotonic(),
            force=True,
        )
        if ok:
            QMessageBox.information(self, "Config Sync", f"Config synced to node: {node_id}")
        else:
            QMessageBox.warning(self, "Config Sync Failed", f"Config sync failed for node: {node_id}")

    @asyncSlot()
    async def on_agent_check_clicked(self) -> None:
        node_id = self._target_node()
        if not node_id:
            item = self.nodes_list.currentItem()
            if item is not None:
                node_id = item.text().splitlines()[0].strip()
                if node_id:
                    self.target_input.setText(node_id)
        if not node_id:
            QMessageBox.warning(self, "Missing target", "Please select or input target node id.")
            return

        required = self._required_adapters()
        self._append_log(f"agent-check start node={node_id} required={required}")
        try:
            report = await self.service.agent_check(
                node_id=node_id,
                required_adapters=required,
                timeout_sec=2.0,
            )
        except Exception as exc:
            self._append_log(f"agent-check failed node={node_id} error={exc}")
            self._add_notification(
                level="error",
                title=f"Agent Check Failed | {node_id}",
                message=str(exc),
                category="agent-check",
                context={"node_id": node_id, "required_adapters": required},
            )
            QMessageBox.warning(self, "Agent Check Failed", str(exc))
            return

        checks = report.get("checks", {}) if isinstance(report, dict) else {}
        snapshot = report.get("snapshot", {}) if isinstance(report, dict) else {}
        adapters = snapshot.get("adapters", []) if isinstance(snapshot, dict) else []
        mcp_services = self._extract_mcp_services(snapshot) if isinstance(snapshot, dict) else []
        missing = report.get("missing_adapters", []) if isinstance(report, dict) else []
        hint_lines = [
            "Quick Node Actions",
            f"- Node: {node_id}",
            f"- Can Accept: {checks.get('can_accept_tasks')}",
            f"- Agent Ready: {checks.get('agent_ready')}",
            f"- Skills Loaded: {checks.get('skills_loaded')}",
            f"- Adapters: {', '.join(str(x) for x in adapters) if isinstance(adapters, list) and adapters else 'none'}",
            f"- MCP Services: {', '.join(mcp_services) if mcp_services else 'none'}",
            f"- Missing Required: {', '.join(str(x) for x in missing) if isinstance(missing, list) and missing else 'none'}",
        ]
        self.node_hint_label.setText("\n".join(hint_lines))
        self._append_log(
            f"agent-check done node={node_id} ok={report.get('ok')} missing={missing if isinstance(missing, list) else []}"
        )
        report_ok = bool(report.get("ok"))
        if not report_ok:
            self._add_notification(
                level="warning",
                title=f"Agent Check Not Ready | {node_id}",
                message=(
                    f"can_accept={checks.get('can_accept_tasks')} "
                    f"agent_ready={checks.get('agent_ready')} "
                    f"missing={','.join(str(x) for x in missing) if isinstance(missing, list) else ''}"
                ).strip(),
                category="agent-check",
                context=report,
            )

    def on_node_item_clicked(self, item: QListWidgetItem) -> None:
        node = item.text().splitlines()[0].strip()
        if node:
            self.target_input.setText(node)

    def on_add_peer_clicked(self) -> None:
        peer_id = self.peer_input.text().strip()
        if not peer_id:
            QMessageBox.warning(self, "Missing peer", "Please input target client id.")
            return
        if peer_id == self.config.client_id:
            QMessageBox.information(self, "Same client", "Pick another client id.")
            return
        self._selected_peer_id = peer_id
        self._client_peers.setdefault(
            peer_id,
            {
                "client_id": peer_id,
                "status": "manual",
                "last_seen": "-",
                "payload": {},
            },
        )
        self._refresh_peer_list()
        self._refresh_conversation_view()
        self._save_conversation_state()

    @asyncSlot()
    async def on_announce_presence_clicked(self) -> None:
        await self.service.publish_presence(status="online")
        self._append_log("presence announced")

    def on_peer_selection_changed(self) -> None:
        if self._syncing_peer_selection:
            return
        item = self.peers_list.currentItem()
        if item is None:
            return
        peer_id = item.data(Qt.UserRole)
        if isinstance(peer_id, str):
            self._selected_peer_id = peer_id
            self.peer_input.setText(peer_id)
            changed = self._mark_peer_read(peer_id)
            self._load_latest_task_request_for_peer(
                peer_id,
                overwrite_script=self._can_replace_script_from_request(),
            )
            self._refresh_conversation_view()
            if changed:
                self._refresh_peer_list()
            self._save_conversation_state()

    def on_conversation_selection_changed(self) -> None:
        item = self.conversation_list.currentItem()
        if item is None:
            return
        message = item.data(Qt.UserRole + 1)
        if not isinstance(message, dict):
            return
        msg_type = str(message.get("type", ""))
        if msg_type == "task.request" and str(message.get("target_client_id", "")) == self.config.client_id:
            self._load_task_request(message, overwrite_script=True)

    def _selected_peer(self) -> str:
        peer_id = self._selected_peer_id.strip() or self.peer_input.text().strip()
        if peer_id and peer_id not in self._client_peers and peer_id != self.config.client_id:
            self._client_peers[peer_id] = {
                "client_id": peer_id,
                "status": "manual",
                "last_seen": "-",
                "payload": {},
            }
            self._selected_peer_id = peer_id
            self._refresh_peer_list()
        return peer_id

    @asyncSlot()
    async def on_send_chat_clicked(self) -> None:
        peer_id = self._selected_peer()
        if not peer_id:
            QMessageBox.warning(self, "Missing peer", "Please select or input target client id.")
            return
        text = self.chat_input.toPlainText().strip()
        if not text:
            QMessageBox.warning(self, "Missing message", "Please input a message.")
            return
        msg = await self.service.send_chat_message(
            target_client_id=peer_id,
            text=text,
            conversation_id=self._conversation_id(peer_id),
        )
        self._append_conversation_message(direction="out", message=msg)
        self.chat_input.clear()
        self._refresh_conversation_state_views()
        self._save_conversation_state()
        self._append_log(f"message sent target={peer_id} id={msg.get('message_id')}")

    @asyncSlot()
    async def on_send_task_request_clicked(self) -> None:
        peer_id = self._selected_peer()
        if not peer_id:
            QMessageBox.warning(self, "Missing peer", "Please select or input target client id.")
            return
        instruction = self.chat_input.toPlainText().strip() or self.instruction_input.toPlainText().strip()
        if not instruction:
            QMessageBox.warning(self, "Missing task", "Please input task request text.")
            return
        msg = await self.service.send_task_request(
            target_client_id=peer_id,
            instruction=instruction,
            suggested_script=self.script_editor.toPlainText().strip(),
            conversation_id=self._conversation_id(peer_id),
        )
        record_id = self._register_task_record(
            kind="client-task-request",
            node_id=peer_id,
            result={"status": "sent", "ok": True, "message": msg},
            request={"instruction": instruction, "target_client_id": peer_id},
        )
        message_id = str(msg.get("message_id", "")).strip()
        if message_id:
            self._task_request_records[message_id] = record_id
        self._append_conversation_message(direction="out", message=msg)
        self.chat_input.clear()
        self._refresh_conversation_state_views()
        self._save_conversation_state()
        self._append_log(f"task request sent target={peer_id} id={msg.get('message_id')}")

    def on_use_latest_task_request_clicked(self) -> None:
        request = self._latest_task_request_for_peer(self._selected_peer_id) or self._latest_task_request
        if not request:
            QMessageBox.information(self, "No request", "No task request has been received yet.")
            return
        self._load_task_request(request, overwrite_script=True)

    @asyncSlot()
    async def on_run_local_script_clicked(self) -> None:
        script = self.script_editor.toPlainText().strip()
        if not script:
            QMessageBox.warning(self, "Missing script", "Please write a Python script first.")
            return
        result = await self.service.execute_python_script(script=script, timeout_sec=30.0)
        self._last_script_result = result
        source = self._active_task_request or {}
        source_message_id = str(source.get("message_id", "")).strip()
        self._last_script_result_request_id = source_message_id
        self.script_result_text.setPlainText(
            json.dumps(
                self._script_result_display_payload(request=source, result=result),
                ensure_ascii=False,
                indent=2,
            )
        )
        source_peer = str(source.get("from_client_id", "")).strip() or self._selected_peer()
        self._register_task_record(
            kind="client-script",
            node_id=source_peer or "local",
            result={"status": "succeeded" if result.get("ok") else "failed", **result},
            request={
                "script": script,
                "source_message_id": source.get("message_id"),
                "source_client_id": source_peer,
            },
        )
        inbound_record_id = self._inbound_task_request_records.get(source_message_id)
        if inbound_record_id and inbound_record_id in self._task_records:
            record = self._task_records[inbound_record_id]
            record["status"] = "ready-to-return" if result.get("ok") else "script-failed"
            record["result"] = {
                "status": record["status"],
                "ok": bool(result.get("ok", False)),
                "message": source,
                "script_result": result,
            }
            record["timeline"].append(
                {
                    "ts": datetime.now().isoformat(timespec="seconds"),
                    "stage": "client-script",
                    "message": f"script ok={result.get('ok')} returncode={result.get('returncode')}",
                }
            )
            self._refresh_task_item(inbound_record_id)
            self._refresh_queue_cards()
            self.refresh_history_table()
            self._refresh_conversation_state_views()
            self._save_conversation_state()
        self._append_log(f"local script done ok={result.get('ok')} returncode={result.get('returncode')}")

    @asyncSlot()
    async def on_send_last_script_result_clicked(self) -> None:
        if not self._active_task_request:
            QMessageBox.information(self, "No request", "No task request is selected.")
            return
        source_message_id = str(self._active_task_request.get("message_id", "")).strip()
        if not source_message_id or self._last_script_result_request_id != source_message_id:
            QMessageBox.information(self, "No matching result", "Run the script for the selected request before sending.")
            return
        try:
            result_payload = json.loads(self.script_result_text.toPlainText().strip() or "{}")
        except json.JSONDecodeError as exc:
            QMessageBox.warning(self, "Invalid result", str(exc))
            return
        if isinstance(result_payload, dict) and isinstance(result_payload.get("result"), dict):
            result = result_payload["result"]
        elif isinstance(result_payload, dict):
            result = result_payload
        else:
            result = {}
        target = str(self._active_task_request.get("from_client_id", "")).strip()
        if not target:
            QMessageBox.warning(self, "Missing target", "Cannot determine task requester.")
            return
        msg = await self.service.send_task_result(
            target_client_id=target,
            request_message_id=str(self._active_task_request.get("message_id", "")),
            result=result,
            conversation_id=str(self._active_task_request.get("conversation_id", "")) or self._conversation_id(target),
        )
        self._append_conversation_message(direction="out", message=msg)
        inbound_record_id = self._inbound_task_request_records.get(source_message_id)
        if inbound_record_id and inbound_record_id in self._task_records:
            record = self._task_records[inbound_record_id]
            record["status"] = "returned"
            record["timeline"].append(
                {
                    "ts": str(msg.get("ts", datetime.now().isoformat(timespec="seconds"))),
                    "stage": "task.result.sent",
                    "message": f"sent result to {target}",
                }
            )
            self._refresh_task_item(inbound_record_id)
            self._refresh_queue_cards()
            self.refresh_history_table()
            self._refresh_conversation_state_views()
            self._save_conversation_state()
        self._append_log(f"task result sent target={target} id={msg.get('message_id')}")

    def on_node_search_changed(self, _: str) -> None:
        self._apply_node_search_filter()

    def on_add_files_clicked(self) -> None:
        files, _ = QFileDialog.getOpenFileNames(self, "Select files")
        if files:
            self.drop_list.add_paths(files)

    def on_add_dir_clicked(self) -> None:
        folder = QFileDialog.getExistingDirectory(self, "Select folder")
        if folder:
            self.drop_list.add_paths([folder])

    def on_pick_latex_workspace(self) -> None:
        folder = QFileDialog.getExistingDirectory(self, "Select LaTeX Workspace")
        if folder:
            self.latex_workspace.setText(folder)

    def on_pick_latex_mcp_dir(self) -> None:
        folder = QFileDialog.getExistingDirectory(self, "Select latex-mcp Directory")
        if folder:
            self.latex_mcp_dir.setText(folder)

    def on_pick_latex_main_tex(self) -> None:
        file_path, _ = QFileDialog.getOpenFileName(self, "Select Main TeX", filter="TeX Files (*.tex)")
        if file_path:
            self.latex_main_tex.setText(Path(file_path).name)
            if not self.latex_workspace.text().strip():
                self.latex_workspace.setText(str(Path(file_path).parent))

    @asyncSlot()
    async def on_upload_clicked(self) -> None:
        node_id = self._target_node()
        if not node_id:
            QMessageBox.warning(self, "Missing target", "Please input target node id.")
            return
        paths = self.drop_list.iter_paths()
        if not paths:
            QMessageBox.information(self, "No inputs", "Please drag or add files/folders.")
            return
        self._append_log(f"upload start node={node_id} items={len(paths)}")
        result = await self.service.upload_paths(node_id=node_id, local_paths=paths)
        result["status"] = "succeeded" if result.get("ok") else "failed"
        self._register_task_record(
            kind="upload",
            node_id=node_id,
            result=result,
            request={"local_paths": list(paths)},
        )
        self._append_log(
            f"upload done ok={result.get('ok')} uploaded={len(result.get('uploaded', []))} failed={len(result.get('failed', []))}"
        )

    @asyncSlot()
    async def on_send_echo_clicked(self) -> None:
        node_id = self._target_node()
        if not node_id:
            QMessageBox.warning(self, "Missing target", "Please input target node id.")
            return
        instruction = self.instruction_input.toPlainText().strip()
        skills = self._selected_skills()
        if not instruction:
            QMessageBox.warning(self, "Missing instruction", "Please input task instruction.")
            return
        self._append_log(f"submit echo node={node_id} skills={skills}")
        result = await self.service.submit_echo(node_id=node_id, instruction=instruction, skills=skills)
        self._register_task_record(
            kind="echo",
            node_id=node_id,
            result=result,
            request={"instruction": instruction, "skills": list(skills)},
        )
        self._append_log(
            f"echo done task_id={result.get('task_id')} status={result.get('status')} user_messages={result.get('user_messages')}"
        )

    @asyncSlot()
    async def on_send_latex_clicked(self) -> None:
        node_id = self._target_node()
        if not node_id:
            QMessageBox.warning(self, "Missing target", "Please input target node id.")
            return
        workspace = self.latex_workspace.text().strip()
        latex_mcp_dir = self.latex_mcp_dir.text().strip()
        main_tex = self.latex_main_tex.text().strip()
        if not workspace or not latex_mcp_dir or not main_tex:
            QMessageBox.warning(self, "Missing LaTeX fields", "Workspace / latex-mcp dir / main tex are required.")
            return
        try:
            compile_timeout = int(self.latex_timeout.text().strip() or "360")
        except ValueError:
            QMessageBox.warning(self, "Invalid timeout", "Compile timeout must be an integer.")
            return
        skills = self._selected_skills()
        instruction = self.instruction_input.toPlainText().strip() or f"Compile LaTeX file: {main_tex}"
        self._append_log(f"submit latex node={node_id} tex={main_tex} skills={skills}")
        request_payload = {
            "workspace": workspace,
            "latex_mcp_dir": latex_mcp_dir,
            "main_tex": main_tex,
            "instruction": instruction,
            "engine": self.latex_engine.currentText(),
            "output_subdir": self.latex_output.text().strip() or "build_case_desktop",
            "latex_bin_dir": self.latex_bin_dir.text().strip() or None,
            "compile_timeout_sec": compile_timeout,
            "skills": list(skills),
        }
        result = await self.service.submit_latex(
            node_id=node_id,
            workspace=workspace,
            latex_mcp_dir=latex_mcp_dir,
            main_tex=main_tex,
            instruction=instruction,
            engine=request_payload["engine"],
            output_subdir=str(request_payload["output_subdir"]),
            latex_bin_dir=request_payload["latex_bin_dir"],
            compile_timeout_sec=compile_timeout,
            skills=skills,
        )
        self._register_task_record(kind="latex", node_id=node_id, result=result, request=request_payload)
        self._append_log(
            f"latex done task_id={result.get('task_id')} status={result.get('status')} user_messages={result.get('user_messages')}"
        )

    def on_task_selection_changed(self) -> None:
        self._refresh_task_detail_and_results()

    def on_open_failed_alert_clicked(self) -> None:
        record_id = self._latest_failed_record_id
        if not record_id:
            return
        for i in range(self.tasks_list.count()):
            task_item = self.tasks_list.item(i)
            if task_item is None:
                continue
            if task_item.data(Qt.UserRole) == record_id:
                self.tasks_list.setCurrentRow(i)
                self.tabs.setCurrentIndex(1)
                self._append_log(f"jump to failed task: {record_id}")
                return
        self._append_log(f"failed task not found in list: {record_id}")

    def on_copy_failed_alert_clicked(self) -> None:
        payload = self._latest_failed_context
        if payload is None:
            return
        text = json.dumps(payload, ensure_ascii=False, indent=2)
        QGuiApplication.clipboard().setText(text)
        record_id = str(payload.get("record_id", "failed-task"))
        self._append_log(f"copied failed details: {record_id}")

    def on_export_failed_context_clicked(self) -> None:
        payload = self._latest_failed_context
        if payload is None:
            return
        record_id = str(payload.get("record_id", "failed-task")).strip() or "failed-task"
        default_dir = Path.cwd() / "tmp" / "exports"
        default_dir.mkdir(parents=True, exist_ok=True)
        default_file = default_dir / f"{record_id}-failed-context.json"
        output_path, _ = QFileDialog.getSaveFileName(
            self,
            "Export Failed Context",
            str(default_file),
            "JSON Files (*.json);;All Files (*.*)",
        )
        if not output_path:
            return
        Path(output_path).write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
        self._append_log(f"failed context exported: {output_path}")
        self._add_notification(
            level="info",
            title=f"Failed Context Exported | {record_id}",
            message=str(output_path),
            category="export",
            context={"record_id": record_id, "output_path": output_path},
        )

    def on_result_selection_changed(self) -> None:
        if not self._syncing_artifact_selection:
            item = self.results_list.currentItem()
            if item is not None:
                self._syncing_artifact_selection = True
                try:
                    self._select_quick_artifact(item.text())
                finally:
                    self._syncing_artifact_selection = False
        self._update_result_preview()

    def on_quick_artifact_selection_changed(self) -> None:
        if self._syncing_artifact_selection:
            return
        item = self.quick_artifact_list.currentItem()
        if item is not None:
            self._syncing_artifact_selection = True
            try:
                self._select_result_artifact(item.text())
            finally:
                self._syncing_artifact_selection = False

    def _select_result_artifact(self, text: str) -> None:
        for i in range(self.results_list.count()):
            row = self.results_list.item(i)
            if row is not None and row.text() == text:
                self.results_list.setCurrentRow(i)
                break

    def _select_quick_artifact(self, text: str) -> None:
        for i in range(self.quick_artifact_list.count()):
            row = self.quick_artifact_list.item(i)
            if row is not None and row.text() == text:
                self.quick_artifact_list.setCurrentRow(i)
                break

    def _selected_result_item(self) -> QListWidgetItem | None:
        item = self.quick_artifact_list.currentItem()
        if item is not None:
            return item
        item = self.results_list.currentItem()
        if item is not None:
            return item
        return None

    def _selected_result_path(self) -> Path | None:
        item = self._selected_result_item()
        if item is None:
            return None
        return self._resolve_local_path(item.text())

    def _selected_result_raw_path(self) -> str | None:
        item = self._selected_result_item()
        if item is None:
            return None
        return item.text()

    def on_open_result_path(self) -> None:
        path = self._selected_result_path()
        if path is None:
            return
        QDesktopServices.openUrl(QUrl.fromLocalFile(str(path)))

    def on_open_result_folder(self) -> None:
        path = self._selected_result_path()
        if path is None:
            return
        folder = path if path.is_dir() else path.parent
        QDesktopServices.openUrl(QUrl.fromLocalFile(str(folder)))

    def on_copy_result_path(self) -> None:
        path = self._selected_result_path()
        if path is None:
            return
        QGuiApplication.clipboard().setText(str(path))
        self._append_log(f"copied path: {path}")

    @asyncSlot()
    async def on_download_result_clicked(self) -> None:
        record = self._current_record()
        if record is None:
            QMessageBox.information(self, "No task", "Please select a task first.")
            return
        node_id = str(record.get("node_id", "")).strip()
        if not node_id:
            QMessageBox.warning(self, "Missing node", "Cannot determine source node for this artifact.")
            return
        source_raw = self._selected_result_raw_path()
        if not source_raw:
            QMessageBox.information(self, "No artifact", "Please select an artifact path first.")
            return
        default_download_root = Path.cwd() / "tmp" / "downloads"
        default_download_root.mkdir(parents=True, exist_ok=True)
        target_dir = QFileDialog.getExistingDirectory(
            self,
            "Select Download Folder",
            str(default_download_root),
        )
        if not target_dir:
            return
        self._append_log(f"download artifact start node={node_id} source={source_raw}")
        artifact_name = Path(source_raw.replace("\\", "/")).name or "artifact"
        file_output = str(Path(target_dir) / artifact_name)
        try:
            result = await self.service.download_file(
                node_id=node_id,
                source_path=source_raw,
                output_path=file_output,
            )
            output_path = str(result.get("output_path", file_output))
            self._append_log(f"download artifact done(file): {output_path}")
            artifacts = record.setdefault("artifacts", [])
            if isinstance(artifacts, list) and output_path not in artifacts:
                artifacts.append(output_path)
                self.results_list.addItem(output_path)
                self.quick_artifact_list.addItem(output_path)
            self._register_task_record(
                kind="download_file",
                node_id=node_id,
                result={
                    "ok": True,
                    "status": "succeeded",
                    "mode": "file",
                    "source_path": source_raw,
                    "output_path": output_path,
                    "transfer": result,
                },
                request={
                    "source_path": source_raw,
                    "output_path": file_output,
                    "mode": "file",
                },
            )
            return
        except Exception as exc:
            text = str(exc)
            if "source_not_file" not in text:
                QMessageBox.warning(self, "Download failed", text)
                self._append_log(f"download artifact failed: {text}")
                self._add_notification(
                    level="error",
                    title=f"Download Failed | {node_id}",
                    message=text,
                    category="download",
                    context={"node_id": node_id, "source_path": source_raw, "mode": "file"},
                )
                return

        try:
            dir_output = str(Path(target_dir) / artifact_name)
            result = await self.service.download_directory(
                node_id=node_id,
                source_dir=source_raw,
                output_dir=dir_output,
                continue_on_error=False,
            )
        except Exception as exc:
            QMessageBox.warning(self, "Download failed", str(exc))
            self._append_log(f"download artifact failed(directory): {exc}")
            self._add_notification(
                level="error",
                title=f"Download Failed | {node_id}",
                message=str(exc),
                category="download",
                context={"node_id": node_id, "source_path": source_raw, "mode": "directory"},
            )
            return
        output_dir = str(result.get("output_dir", dir_output))
        self._append_log(
            f"download artifact done(directory): {output_dir} files={result.get('files_downloaded')}/{result.get('files_total')}"
        )
        artifacts = record.setdefault("artifacts", [])
        if isinstance(artifacts, list):
            if output_dir not in artifacts:
                artifacts.append(output_dir)
                self.results_list.addItem(output_dir)
                self.quick_artifact_list.addItem(output_dir)
            for item in result.get("downloaded", []):
                if not isinstance(item, dict):
                    continue
                output_path = item.get("output_path")
                if isinstance(output_path, str) and output_path not in artifacts:
                    artifacts.append(output_path)
                    self.results_list.addItem(output_path)
                    self.quick_artifact_list.addItem(output_path)
        self._register_task_record(
            kind="download_dir",
            node_id=node_id,
            result={
                "ok": bool(result.get("ok", False)),
                "status": "succeeded" if bool(result.get("ok", False)) else "failed",
                "mode": "directory",
                "source_path": source_raw,
                "output_dir": output_dir,
                "transfer": result,
            },
            request={
                "source_path": source_raw,
                "output_dir": dir_output,
                "mode": "directory",
            },
        )

    @asyncSlot()
    async def on_rerun_selected_task_clicked(self) -> None:
        record = self._current_record()
        if record is None:
            QMessageBox.information(self, "No task", "Please select a task first.")
            return
        await self._rerun_record(record, trigger="selected-task")

    @asyncSlot()
    async def on_retry_failed_alert_clicked(self) -> None:
        record_id = self._latest_failed_record_id
        if not record_id:
            QMessageBox.information(self, "No failed task", "No failed task is available for retry.")
            return
        record = self._record_by_id(record_id)
        if record is None:
            QMessageBox.warning(self, "Retry failed", f"Failed task record not found: {record_id}")
            return
        await self._rerun_record(
            record,
            trigger="failed-alert",
            max_attempts=self._retry_attempts_per_task,
            backoff_base_sec=self._retry_backoff_base_sec,
        )

    async def _rerun_record(
        self,
        record: dict[str, Any],
        *,
        trigger: str,
        show_dialog: bool = True,
        max_attempts: int = 1,
        backoff_base_sec: float = 0.0,
    ) -> bool:
        node_id = str(record.get("node_id", "")).strip()
        kind = str(record.get("kind", "")).strip()
        request = record.get("request")
        if not node_id or not isinstance(request, dict):
            if show_dialog:
                QMessageBox.warning(self, "Cannot re-run", "Missing task request context.")
            return False

        max_attempts = max(1, int(max_attempts))
        backoff_base_sec = max(0.0, float(backoff_base_sec))
        if kind in {"download_file", "download_dir"}:
            # Download rerun requires local folder picker; keep it single-attempt to avoid repeated dialogs.
            max_attempts = 1

        source_record_id = str(record.get("record_id", "")).strip()
        rerun_request = dict(request)
        rerun_request["rerun_of"] = source_record_id
        rerun_request["rerun_trigger"] = trigger
        target_node_id, route_reason = self._select_retry_target_node(
            original_node_id=node_id,
            kind=kind,
            trigger=trigger,
        )
        if target_node_id != node_id:
            rerun_request["rerouted_from"] = node_id
        self._append_log(
            f"rerun start kind={kind} node={target_node_id} from={source_record_id} "
            f"trigger={trigger} attempts={max_attempts} route={route_reason}"
        )
        last_error: Exception | None = None
        for attempt in range(1, max_attempts + 1):
            attempt_request = dict(rerun_request)
            attempt_request["rerun_attempt"] = attempt
            attempt_request["rerun_max_attempts"] = max_attempts
            try:
                if kind == "echo":
                    instruction = str(request.get("instruction", "")).strip()
                    if not instruction:
                        raise RuntimeError("echo request missing instruction")
                    skills = request.get("skills")
                    skills_list = [str(x) for x in skills] if isinstance(skills, list) else []
                    result = await self.service.submit_echo(
                        node_id=target_node_id, instruction=instruction, skills=skills_list
                    )
                    self._register_task_record(kind="echo", node_id=target_node_id, result=result, request=attempt_request)
                elif kind == "latex":
                    result = await self.service.submit_latex(
                        node_id=target_node_id,
                        workspace=str(request.get("workspace", "")),
                        latex_mcp_dir=str(request.get("latex_mcp_dir", "")),
                        main_tex=str(request.get("main_tex", "")),
                        instruction=str(request.get("instruction", "")),
                        engine=str(request.get("engine", "pdflatex")),
                        output_subdir=str(request.get("output_subdir", "build_case_desktop")),
                        latex_bin_dir=request.get("latex_bin_dir"),
                        compile_timeout_sec=int(request.get("compile_timeout_sec", 360)),
                        skills=[str(x) for x in request.get("skills", [])]
                        if isinstance(request.get("skills"), list)
                        else [],
                    )
                    self._register_task_record(
                        kind="latex", node_id=target_node_id, result=result, request=attempt_request
                    )
                elif kind == "upload":
                    raw_paths = request.get("local_paths")
                    if not isinstance(raw_paths, list):
                        raise RuntimeError("upload request missing local_paths")
                    paths = [str(p) for p in raw_paths if isinstance(p, str) and Path(p).exists()]
                    if not paths:
                        raise RuntimeError("no local paths exist for upload rerun")
                    result = await self.service.upload_paths(node_id=target_node_id, local_paths=paths)
                    result["status"] = "succeeded" if result.get("ok") else "failed"
                    self._register_task_record(
                        kind="upload", node_id=target_node_id, result=result, request=attempt_request
                    )
                elif kind in {"download_file", "download_dir"}:
                    source_path = str(request.get("source_path", "")).strip()
                    if not source_path:
                        raise RuntimeError("download request missing source_path")
                    default_download_root = Path.cwd() / "tmp" / "downloads"
                    default_download_root.mkdir(parents=True, exist_ok=True)
                    target_dir = QFileDialog.getExistingDirectory(
                        self,
                        "Select Download Folder for Re-run",
                        str(default_download_root),
                    )
                    if not target_dir:
                        self._append_log("rerun canceled: no download target selected")
                        return False
                    source_name = Path(source_path.replace("\\", "/")).name or "artifact"
                    if kind == "download_file":
                        output_path = str(Path(target_dir) / source_name)
                        transfer = await self.service.download_file(
                            node_id=target_node_id,
                            source_path=source_path,
                            output_path=output_path,
                        )
                        result = {
                            "ok": bool(transfer.get("ok", True)),
                            "status": "succeeded",
                            "mode": "file",
                            "source_path": source_path,
                            "output_path": transfer.get("output_path", output_path),
                            "transfer": transfer,
                        }
                        attempt_request["output_path"] = output_path
                        self._register_task_record(
                            kind="download_file",
                            node_id=target_node_id,
                            result=result,
                            request=attempt_request,
                        )
                    else:
                        output_dir = str(Path(target_dir) / source_name)
                        transfer = await self.service.download_directory(
                            node_id=target_node_id,
                            source_dir=source_path,
                            output_dir=output_dir,
                            continue_on_error=False,
                        )
                        ok = bool(transfer.get("ok", False))
                        result = {
                            "ok": ok,
                            "status": "succeeded" if ok else "failed",
                            "mode": "directory",
                            "source_path": source_path,
                            "output_dir": transfer.get("output_dir", output_dir),
                            "transfer": transfer,
                        }
                        attempt_request["output_dir"] = output_dir
                        self._register_task_record(
                            kind="download_dir",
                            node_id=target_node_id,
                            result=result,
                            request=attempt_request,
                        )
                else:
                    if show_dialog:
                        QMessageBox.information(self, "Cannot re-run", f"Task kind is not supported for rerun: {kind}")
                    return False
                self._append_log(
                    f"rerun done kind={kind} node={target_node_id} from={source_record_id} attempt={attempt}/{max_attempts}"
                )
                self._add_notification(
                    level="info",
                    title=f"Task Re-run Submitted | {source_record_id}",
                    message=(
                        f"kind={kind} node={target_node_id} trigger={trigger} "
                        f"attempt={attempt}/{max_attempts} route={route_reason}"
                    ),
                    category="retry",
                    context={
                        "record_id": source_record_id,
                        "kind": kind,
                        "node_id": target_node_id,
                        "trigger": trigger,
                        "attempt": attempt,
                        "max_attempts": max_attempts,
                        "route_reason": route_reason,
                    },
                )
                return True
            except Exception as exc:
                last_error = exc
                self._append_log(
                    f"rerun attempt failed kind={kind} node={target_node_id} "
                    f"from={source_record_id} attempt={attempt}/{max_attempts}: {exc}"
                )
                if attempt < max_attempts:
                    delay = backoff_base_sec * (2 ** (attempt - 1)) if backoff_base_sec > 0 else 0.0
                    if delay > 0:
                        await asyncio.sleep(delay)
                else:
                    break

        final_error = str(last_error) if last_error is not None else "unknown rerun error"
        if show_dialog:
            QMessageBox.warning(self, "Re-run failed", final_error)
        self._add_notification(
            level="error",
            title=f"Task Re-run Failed | {source_record_id}",
            message=final_error,
            category="retry",
            context={
                "record_id": source_record_id,
                "kind": kind,
                "node_id": target_node_id,
                "trigger": trigger,
                "attempts": max_attempts,
                "route_reason": route_reason,
            },
        )
        return False

    @asyncSlot()
    async def on_retry_failed_batch_clicked(self) -> None:
        try:
            await self._refresh_nodes()
        except Exception:
            # Keep batch retry working even if snapshot refresh fails.
            pass
        try:
            limit = int(self.retry_batch_limit_input.text().strip() or "3")
        except ValueError:
            QMessageBox.warning(self, "Invalid retry limit", "Retry limit must be an integer.")
            return
        if limit <= 0:
            QMessageBox.warning(self, "Invalid retry limit", "Retry limit must be greater than zero.")
            return
        limit = min(limit, self._retry_batch_max_limit)
        kind_filter = self.retry_batch_kind_filter.currentText().strip().lower() or "all"
        error_code_filter = self.retry_batch_error_code_input.text().strip().upper()

        candidates: list[dict[str, Any]] = []
        for record_id in reversed(self._task_order):
            record = self._task_records.get(record_id)
            if not isinstance(record, dict):
                continue
            status = str(record.get("status", "")).strip()
            if not self._is_failed_status(status):
                continue
            kind = str(record.get("kind", "")).strip().lower()
            if kind_filter != "all" and kind != kind_filter:
                continue
            request = record.get("request")
            if isinstance(request, dict) and str(request.get("rerun_of", "")).strip():
                continue
            if error_code_filter:
                code = self._record_error_code(record).strip().upper()
                if code != error_code_filter:
                    continue
            candidates.append(record)
            if len(candidates) >= limit:
                break

        if not candidates:
            QMessageBox.information(self, "No failed tasks", "No failed task matches current batch retry filters.")
            return

        succeeded = 0
        failed = 0
        skipped = 0
        skipped_kinds = set(self._retry_batch_skip_kinds)
        attempted = 0
        for idx, record in enumerate(candidates):
            kind = str(record.get("kind", "")).strip().lower()
            if kind in skipped_kinds:
                skipped += 1
                continue
            ok = await self._rerun_record(
                record,
                trigger="batch-retry",
                show_dialog=False,
                max_attempts=self._retry_attempts_per_task,
                backoff_base_sec=self._retry_backoff_base_sec,
            )
            attempted += 1
            if ok:
                succeeded += 1
            else:
                failed += 1
            if self._retry_batch_interval_sec > 0 and idx < (len(candidates) - 1):
                await asyncio.sleep(self._retry_batch_interval_sec)

        summary = (
            f"batch retry done total={len(candidates)} attempted={attempted} success={succeeded} "
            f"failed={failed} skipped={skipped} kind_filter={kind_filter} "
            f"error_code={error_code_filter or 'all'} interval={self._retry_batch_interval_sec}s "
            f"skip_kinds={','.join(sorted(skipped_kinds)) if skipped_kinds else 'none'} "
            f"attempts_per_task={self._retry_attempts_per_task} "
            f"backoff_base={self._retry_backoff_base_sec}s reroute={self._retry_reroute_mode}"
        )
        self._append_log(summary)
        level = "info" if failed == 0 else "warning"
        self._add_notification(
            level=level,
            title="Batch Retry Finished",
            message=summary,
            category="retry",
            context={
                "total": len(candidates),
                "success": succeeded,
                "failed": failed,
                "skipped": skipped,
                "attempted": attempted,
                "kind_filter": kind_filter,
                "error_code_filter": error_code_filter,
                "interval_sec": self._retry_batch_interval_sec,
                "skip_kinds": sorted(skipped_kinds),
                "attempts_per_task": self._retry_attempts_per_task,
                "backoff_base_sec": self._retry_backoff_base_sec,
                "reroute_mode": self._retry_reroute_mode,
            },
        )
        QMessageBox.information(
            self,
            "Batch retry finished",
            f"Selected: {len(candidates)}\nAttempted: {attempted}\nSuccess: {succeeded}\nFailed: {failed}\nSkipped: {skipped}",
        )

    def on_export_event_stream_clicked(self) -> None:
        record = self._current_record()
        if record is None:
            QMessageBox.information(self, "No task", "Please select a task first.")
            return
        default_dir = Path.cwd() / "tmp" / "exports"
        default_dir.mkdir(parents=True, exist_ok=True)
        default_file = default_dir / f"{record.get('record_id', 'task')}-events.ndjson"
        output_path, _ = QFileDialog.getSaveFileName(
            self,
            "Export Event Stream",
            str(default_file),
            "NDJSON Files (*.ndjson);;All Files (*.*)",
        )
        if not output_path:
            return
        timeline = record.get("timeline")
        if not isinstance(timeline, list):
            timeline = []
        result = record.get("result")
        if not isinstance(result, dict):
            result = {}
        request = record.get("request")
        if not isinstance(request, dict):
            request = {}
        error_summary = build_error_summary(result)
        error_code = str(error_summary.get("code", "")).strip() or extract_error_code(result)
        error_message = str(error_summary.get("message", "")).strip() or extract_error_message(result)
        with Path(output_path).open("w", encoding="utf-8") as f:
            meta = {
                "type": "task.meta",
                "record_id": record.get("record_id"),
                "kind": record.get("kind"),
                "node_id": record.get("node_id"),
                "created_at": record.get("created_at"),
                "status": result.get("status"),
                "task_id": result.get("task_id"),
                "error_code": error_code,
                "error_message": error_message,
                "request": request,
            }
            f.write(json.dumps(meta, ensure_ascii=False) + "\n")
            for idx, row in enumerate(timeline):
                if not isinstance(row, dict):
                    continue
                event = {
                    "type": "task.event",
                    "index": idx,
                    "record_id": record.get("record_id"),
                    "kind": record.get("kind"),
                    "node_id": record.get("node_id"),
                    "ts": row.get("ts"),
                    "stage": row.get("stage"),
                    "message": row.get("message"),
                    "status": result.get("status"),
                    "error_code": error_code,
                }
                f.write(json.dumps(event, ensure_ascii=False) + "\n")
        self._append_log(f"event stream exported: {output_path}")
        self._add_notification(
            level="info",
            title=f"Event Stream Exported | {record.get('record_id')}",
            message=str(output_path),
            category="export",
            context={"record_id": record.get("record_id"), "output_path": output_path},
        )

    def refresh_history_table(self) -> None:
        rows: list[dict[str, Any]] = []
        for record_id in self._task_order:
            record = self._task_records.get(record_id)
            if record is None:
                continue
            text = f"{record.get('record_id')} {record.get('kind')} {record.get('node_id')} {record.get('status')}".lower()
            if self._history_filter and self._history_filter not in text:
                continue
            rows.append(record)
        self.history_table.setRowCount(len(rows))
        for r, record in enumerate(rows):
            self.history_table.setItem(r, 0, QTableWidgetItem(str(record.get("created_at", ""))))
            self.history_table.setItem(r, 1, QTableWidgetItem(str(record.get("kind", ""))))
            self.history_table.setItem(r, 2, QTableWidgetItem(str(record.get("node_id", ""))))
            self.history_table.setItem(r, 3, QTableWidgetItem(str(record.get("status", ""))))
            item = QTableWidgetItem(str(record.get("record_id", "")))
            item.setData(Qt.UserRole, str(record.get("record_id", "")))
            self.history_table.setItem(r, 4, item)
        if not rows:
            self.history_recovery_text.setPlainText("")

    def on_history_filter_changed(self, value: str) -> None:
        self._history_filter = value.strip().lower()
        self.refresh_history_table()

    def on_history_selection_changed(self) -> None:
        row = self.history_table.currentRow()
        if row < 0:
            self.history_recovery_text.setPlainText("")
            return
        item = self.history_table.item(row, 4)
        if item is None:
            self.history_recovery_text.setPlainText("")
            return
        record_id = item.data(Qt.UserRole)
        if not isinstance(record_id, str):
            self.history_recovery_text.setPlainText("")
            return
        record = self._record_by_id(record_id)
        if record is not None:
            self.history_recovery_text.setPlainText(
                json.dumps(self._build_history_recovery_meta(record), ensure_ascii=False, indent=2)
            )
        else:
            self.history_recovery_text.setPlainText("")
        for i in range(self.tasks_list.count()):
            task_item = self.tasks_list.item(i)
            if task_item is None:
                continue
            if task_item.data(Qt.UserRole) == record_id:
                self.tasks_list.setCurrentRow(i)
                break

    def on_notification_selection_changed(self) -> None:
        if self._syncing_notification_selection:
            return
        item = self.notifications_list.currentItem()
        if item is None:
            self.notification_detail_text.setPlainText("")
            return
        notification_id = item.data(Qt.UserRole)
        if not isinstance(notification_id, str):
            self.notification_detail_text.setPlainText("")
            return
        payload = self._notification_by_id(notification_id)
        if payload is None:
            self.notification_detail_text.setPlainText("")
            return
        if self._notification_auto_mark_read and (not bool(payload.get("read", False))):
            payload["read"] = True
            self.notification_detail_text.setPlainText(json.dumps(payload, ensure_ascii=False, indent=2))
            self._refresh_notifications_view()
            return
        self.notification_detail_text.setPlainText(json.dumps(payload, ensure_ascii=False, indent=2))

    def on_notifications_filter_changed(self, *_args: Any) -> None:
        self._refresh_notifications_view()

    def on_mark_selected_notification_read(self) -> None:
        item = self.notifications_list.currentItem()
        if item is None:
            return
        notification_id = item.data(Qt.UserRole)
        if not isinstance(notification_id, str):
            return
        payload = self._notification_by_id(notification_id)
        if payload is None:
            return
        if not bool(payload.get("read", False)):
            payload["read"] = True
            self._refresh_notifications_view()
            self._append_log(f"notification marked as read: {notification_id}")

    def on_mark_all_notifications_read(self) -> None:
        changed = False
        for item in self._notifications:
            if not bool(item.get("read", False)):
                item["read"] = True
                changed = True
        if changed:
            self._refresh_notifications_view()
            self._append_log("all notifications marked as read")

    def on_copy_selected_notification(self) -> None:
        item = self.notifications_list.currentItem()
        if item is None:
            return
        notification_id = item.data(Qt.UserRole)
        if not isinstance(notification_id, str):
            return
        payload = self._notification_by_id(notification_id)
        if payload is None:
            return
        QGuiApplication.clipboard().setText(json.dumps(payload, ensure_ascii=False, indent=2))
        self._append_log(f"copied notification: {notification_id}")

    def on_copy_all_notifications(self) -> None:
        QGuiApplication.clipboard().setText(json.dumps(self._notifications, ensure_ascii=False, indent=2))
        self._append_log(f"copied notifications: total={len(self._notifications)}")

    def on_clear_notifications(self) -> None:
        self._notifications.clear()
        self._notification_recent.clear()
        self._refresh_notifications_view()
        self._append_log("notifications cleared")

    def _load_mcp_services(self) -> None:
        self._mcp_services = load_mcp_services(self.config.mcp_config_path)
        self._refresh_mcp_table()
        self.mcp_status_label.setText(f"Loaded {len(self._mcp_services)} MCP services.")

    def _refresh_mcp_table(self) -> None:
        self.mcp_table.setRowCount(len(self._mcp_services))
        for row, item in enumerate(self._mcp_services):
            self.mcp_table.setItem(row, 0, QTableWidgetItem(item.name))
            self.mcp_table.setItem(row, 1, QTableWidgetItem(item.mode))
            self.mcp_table.setItem(row, 2, QTableWidgetItem(item.endpoint_or_command))
            self.mcp_table.setItem(row, 3, QTableWidgetItem(item.version))
            self.mcp_table.setItem(row, 4, QTableWidgetItem("true" if item.enabled else "false"))

    def on_mcp_table_selection_changed(self) -> None:
        row = self.mcp_table.currentRow()
        if row < 0 or row >= len(self._mcp_services):
            return
        item = self._mcp_services[row]
        self.mcp_name_input.setText(item.name)
        self.mcp_mode_input.setCurrentText(item.mode)
        self.mcp_endpoint_input.setText(item.endpoint_or_command)
        self.mcp_version_input.setText(item.version)
        self.mcp_enabled_input.setCurrentText("true" if item.enabled else "false")

    def _build_mcp_item(self) -> McpServiceConfig | None:
        name = self.mcp_name_input.text().strip()
        mode = self.mcp_mode_input.currentText().strip()
        endpoint_or_command = self.mcp_endpoint_input.text().strip()
        version = self.mcp_version_input.text().strip()
        enabled = self.mcp_enabled_input.currentText() == "true"
        if not name or not endpoint_or_command:
            self.mcp_status_label.setText("Name and endpoint/command are required.")
            return None
        return McpServiceConfig(
            name=name,
            mode=mode,
            endpoint_or_command=endpoint_or_command,
            version=version,
            enabled=enabled,
        )

    def on_mcp_add_or_update(self) -> None:
        item = self._build_mcp_item()
        if item is None:
            return
        row = self.mcp_table.currentRow()
        if 0 <= row < len(self._mcp_services):
            self._mcp_services[row] = item
            self.mcp_status_label.setText(f"Updated MCP service: {item.name}")
        else:
            self._mcp_services.append(item)
            self.mcp_status_label.setText(f"Added MCP service: {item.name}")
        self._refresh_mcp_table()

    def on_mcp_delete(self) -> None:
        row = self.mcp_table.currentRow()
        if row < 0 or row >= len(self._mcp_services):
            self.mcp_status_label.setText("Select a service row first.")
            return
        removed = self._mcp_services.pop(row)
        self._refresh_mcp_table()
        self.mcp_status_label.setText(f"Deleted MCP service: {removed.name}")

    def on_mcp_save(self) -> None:
        save_mcp_services(self.config.mcp_config_path, self._mcp_services)
        self.mcp_status_label.setText(f"Saved {len(self._mcp_services)} services.")

    def on_mcp_reload(self) -> None:
        self._load_mcp_services()

    def on_mcp_health_check(self) -> None:
        row = self.mcp_table.currentRow()
        if row < 0 or row >= len(self._mcp_services):
            self.mcp_status_label.setText("Select a service row first.")
            return
        item = self._mcp_services[row]
        ok, msg = self._check_mcp_item(item)
        self.mcp_status_label.setText(("OK: " if ok else "FAIL: ") + msg)

    def _check_mcp_item(self, item: McpServiceConfig) -> tuple[bool, str]:
        if item.mode == "endpoint":
            value = item.endpoint_or_command.lower()
            if value.startswith(("http://", "https://", "ws://", "wss://")):
                return True, f"{item.name} endpoint format valid."
            return False, f"{item.name} endpoint should start with http(s)/ws(s)."
        parts = shlex.split(item.endpoint_or_command, posix=(os.name != "nt"))
        if not parts:
            return False, f"{item.name} command is empty."
        exe = parts[0]
        if Path(exe).exists() or shutil.which(exe):
            return True, f"{item.name} command executable found."
        return False, f"{item.name} command executable not found locally."

    def _load_settings_into_ui(self) -> None:
        payload = load_settings(self.config.settings_path)
        if not payload:
            return
        self.settings_nats_url_input.setText(str(payload.get("nats_url", self.config.nats_url)))
        self.settings_nodes_input.setText(str(payload.get("node_candidates", ",".join(self.config.node_candidates))))
        self.settings_poll_input.setText(str(payload.get("poll_interval_sec", self.config.poll_interval_sec)))
        discovery_enabled = bool(payload.get("discovery_enabled", self._discovery_enabled))
        self.settings_discovery_enabled_input.setCurrentText("true" if discovery_enabled else "false")
        self.settings_discovery_port_input.setText(str(payload.get("discovery_port", self._discovery_port)))
        self.settings_discovery_max_age_input.setText(str(payload.get("discovery_max_age_sec", self._discovery_max_age_sec)))
        auto_switch = bool(payload.get("discovery_auto_switch_nats", self._discovery_auto_switch_nats))
        self.settings_discovery_auto_switch_input.setCurrentText("true" if auto_switch else "false")
        language = normalize_language(str(payload.get("language", self._language)))
        idx = self.settings_language_input.findData(language)
        self.settings_language_input.setCurrentIndex(max(0, idx))
        config_sync_enabled = bool(payload.get("config_sync_enabled", self._config_sync_enabled))
        self.settings_config_sync_enabled_input.setCurrentText("true" if config_sync_enabled else "false")
        self.settings_config_sync_interval_input.setText(
            str(payload.get("config_sync_interval_sec", self._config_sync_interval_sec))
        )
        conflict_policy = str(payload.get("config_sync_conflict_policy", self._config_sync_conflict_policy)).strip().lower()
        if conflict_policy not in CONFIG_SYNC_CONFLICT_POLICY_OPTIONS:
            conflict_policy = CONFIG_SYNC_CONFLICT_POLICY_DEFAULT
        self.settings_config_sync_conflict_policy_input.setCurrentText(conflict_policy)
        self.settings_log_level_input.setCurrentText(str(payload.get("log_level", "INFO")).upper())
        self.settings_log_file_input.setText(str(payload.get("log_file", self.settings_log_file_input.text())))
        self.settings_mcp_path_input.setText(str(payload.get("mcp_config_path", self.config.mcp_config_path)))
        self.settings_notification_max_items_input.setText(
            str(payload.get("notification_max_items", self._notification_max_items))
        )
        self.settings_notification_dedupe_window_input.setText(
            str(payload.get("notification_dedupe_window_sec", self._notification_dedupe_window_sec))
        )
        auto_read = bool(payload.get("notification_auto_mark_read", self._notification_auto_mark_read))
        self.settings_notification_auto_read_input.setCurrentText("true" if auto_read else "false")
        self.settings_retry_batch_max_limit_input.setText(
            str(payload.get("retry_batch_max_limit", self._retry_batch_max_limit))
        )
        self.settings_retry_batch_interval_input.setText(
            str(payload.get("retry_batch_interval_sec", self._retry_batch_interval_sec))
        )
        skip_kinds = payload.get("retry_batch_skip_kinds")
        if isinstance(skip_kinds, list):
            skip_text = ",".join(str(x).strip().lower() for x in skip_kinds if str(x).strip())
        else:
            skip_text = str(payload.get("retry_batch_skip_kinds_text", ",".join(sorted(self._retry_batch_skip_kinds))))
        self.settings_retry_batch_skip_kinds_input.setText(skip_text)
        reroute_mode = str(payload.get("retry_reroute_mode", self._retry_reroute_mode)).strip().lower()
        if reroute_mode not in RETRY_REROUTE_MODE_OPTIONS:
            reroute_mode = RETRY_REROUTE_MODE_DEFAULT
        self.settings_retry_reroute_mode_input.setCurrentText(reroute_mode)
        self.settings_retry_attempts_per_task_input.setText(
            str(payload.get("retry_attempts_per_task", self._retry_attempts_per_task))
        )
        self.settings_retry_backoff_base_input.setText(
            str(payload.get("retry_backoff_base_sec", self._retry_backoff_base_sec))
        )
        update_enabled = bool(payload.get("update_enabled", self._update_enabled))
        self.settings_update_enabled_input.setCurrentText("true" if update_enabled else "false")
        self.settings_update_feed_url_input.setText(str(payload.get("update_feed_url", self._update_feed_url)))
        self.settings_update_asset_pattern_input.setText(
            str(payload.get("update_asset_pattern", self._update_asset_pattern))
        )
        update_on_start = bool(payload.get("update_check_on_start", self._update_check_on_start))
        self.settings_update_check_on_start_input.setCurrentText("true" if update_on_start else "false")
        self.node_input.setText(self.settings_nodes_input.text())
        self.config.node_candidates = self._iter_manual_node_candidates()
        self.config.nats_url = self.settings_nats_url_input.text().strip() or self.config.nats_url
        try:
            self.config.poll_interval_sec = max(0.5, float(self.settings_poll_input.text().strip()))
        except ValueError:
            pass
        self._discovery_enabled = self.settings_discovery_enabled_input.currentText().strip().lower() == "true"
        try:
            self._discovery_port = max(1, int(self.settings_discovery_port_input.text().strip()))
        except ValueError:
            pass
        try:
            self._discovery_max_age_sec = max(2.0, float(self.settings_discovery_max_age_input.text().strip()))
        except ValueError:
            pass
        self._discovery_auto_switch_nats = (
            self.settings_discovery_auto_switch_input.currentText().strip().lower() == "true"
        )
        self._language = normalize_language(str(self.settings_language_input.currentData() or self._language))
        self._config_sync_enabled = self.settings_config_sync_enabled_input.currentText().strip().lower() == "true"
        try:
            self._config_sync_interval_sec = max(5.0, float(self.settings_config_sync_interval_input.text().strip()))
        except ValueError:
            pass
        conflict_policy = self.settings_config_sync_conflict_policy_input.currentText().strip().lower()
        if conflict_policy in CONFIG_SYNC_CONFLICT_POLICY_OPTIONS:
            self._config_sync_conflict_policy = conflict_policy
        else:
            self._config_sync_conflict_policy = CONFIG_SYNC_CONFLICT_POLICY_DEFAULT
        self.config.language = self._language
        self.config.config_sync_enabled = self._config_sync_enabled
        self.config.config_sync_interval_sec = self._config_sync_interval_sec
        self.config.config_sync_conflict_policy = self._config_sync_conflict_policy
        self.config.discovery_enabled = self._discovery_enabled
        self.config.discovery_port = self._discovery_port
        self.config.discovery_max_age_sec = self._discovery_max_age_sec
        self.config.discovery_auto_switch_nats = self._discovery_auto_switch_nats
        mcp_path = self.settings_mcp_path_input.text().strip()
        if mcp_path:
            self.config.mcp_config_path = mcp_path
        try:
            max_items = int(self.settings_notification_max_items_input.text().strip())
            self._notification_max_items = min(MAX_NOTIFICATION_CAPACITY, max(MIN_NOTIFICATION_CAPACITY, max_items))
        except ValueError:
            pass
        try:
            dedupe_window = float(self.settings_notification_dedupe_window_input.text().strip())
            self._notification_dedupe_window_sec = max(0.0, dedupe_window)
        except ValueError:
            pass
        self._notification_auto_mark_read = (
            self.settings_notification_auto_read_input.currentText().strip().lower() == "true"
        )
        try:
            retry_max = int(self.settings_retry_batch_max_limit_input.text().strip())
            self._retry_batch_max_limit = max(1, min(100, retry_max))
        except ValueError:
            pass
        try:
            retry_interval = float(self.settings_retry_batch_interval_input.text().strip())
            self._retry_batch_interval_sec = max(0.0, min(30.0, retry_interval))
        except ValueError:
            pass
        self._retry_batch_skip_kinds = self._parse_retry_batch_skip_kinds(
            self.settings_retry_batch_skip_kinds_input.text().strip()
        )
        reroute_mode = self.settings_retry_reroute_mode_input.currentText().strip().lower()
        if reroute_mode in RETRY_REROUTE_MODE_OPTIONS:
            self._retry_reroute_mode = reroute_mode
        try:
            attempts = int(self.settings_retry_attempts_per_task_input.text().strip())
            self._retry_attempts_per_task = max(1, min(5, attempts))
        except ValueError:
            pass
        try:
            backoff_base = float(self.settings_retry_backoff_base_input.text().strip())
            self._retry_backoff_base_sec = max(0.0, min(30.0, backoff_base))
        except ValueError:
            pass
        self._update_enabled = self.settings_update_enabled_input.currentText().strip().lower() == "true"
        self._update_feed_url = self.settings_update_feed_url_input.text().strip()
        self._update_asset_pattern = self.settings_update_asset_pattern_input.text().strip() or UPDATE_ASSET_PATTERN_DEFAULT
        self._update_check_on_start = self.settings_update_check_on_start_input.currentText().strip().lower() == "true"
        self._sync_retry_batch_runtime_inputs()
        self._apply_language()
        self._refresh_header()

    def _build_settings_payload(self) -> dict[str, Any] | None:
        nats_url = self.settings_nats_url_input.text().strip()
        if not nats_url:
            self.settings_status_label.setText("NATS URL is required.")
            return None
        try:
            poll_interval = max(0.5, float(self.settings_poll_input.text().strip()))
        except ValueError:
            self.settings_status_label.setText("Poll interval must be a number.")
            return None
        discovery_enabled = self.settings_discovery_enabled_input.currentText().strip().lower() == "true"
        try:
            discovery_port = max(1, int(self.settings_discovery_port_input.text().strip()))
        except ValueError:
            self.settings_status_label.setText("LAN discovery port must be an integer.")
            return None
        try:
            discovery_max_age_sec = max(2.0, float(self.settings_discovery_max_age_input.text().strip()))
        except ValueError:
            self.settings_status_label.setText("LAN discovery max age must be a number.")
            return None
        discovery_auto_switch_nats = self.settings_discovery_auto_switch_input.currentText().strip().lower() == "true"
        language = normalize_language(str(self.settings_language_input.currentData() or self._language))
        config_sync_enabled = self.settings_config_sync_enabled_input.currentText().strip().lower() == "true"
        try:
            config_sync_interval_sec = max(5.0, float(self.settings_config_sync_interval_input.text().strip()))
        except ValueError:
            self.settings_status_label.setText("Config sync interval must be a number.")
            return None
        config_sync_conflict_policy = self.settings_config_sync_conflict_policy_input.currentText().strip().lower()
        if config_sync_conflict_policy not in CONFIG_SYNC_CONFLICT_POLICY_OPTIONS:
            self.settings_status_label.setText("Config sync conflict policy is invalid.")
            return None
        try:
            notification_max_items = int(self.settings_notification_max_items_input.text().strip())
        except ValueError:
            self.settings_status_label.setText("Notification max items must be an integer.")
            return None
        notification_max_items = min(MAX_NOTIFICATION_CAPACITY, max(MIN_NOTIFICATION_CAPACITY, notification_max_items))
        try:
            notification_dedupe_window_sec = max(
                0.0, float(self.settings_notification_dedupe_window_input.text().strip())
            )
        except ValueError:
            self.settings_status_label.setText("Notification dedupe window must be a number.")
            return None
        notification_auto_mark_read = self.settings_notification_auto_read_input.currentText().strip().lower() == "true"
        try:
            retry_batch_max_limit = int(self.settings_retry_batch_max_limit_input.text().strip())
        except ValueError:
            self.settings_status_label.setText("Retry batch max limit must be an integer.")
            return None
        retry_batch_max_limit = max(1, min(100, retry_batch_max_limit))
        try:
            retry_batch_interval_sec = float(self.settings_retry_batch_interval_input.text().strip())
        except ValueError:
            self.settings_status_label.setText("Retry batch interval must be a number.")
            return None
        retry_batch_interval_sec = max(0.0, min(30.0, retry_batch_interval_sec))
        retry_batch_skip_kinds = sorted(
            self._parse_retry_batch_skip_kinds(self.settings_retry_batch_skip_kinds_input.text().strip())
        )
        retry_reroute_mode = self.settings_retry_reroute_mode_input.currentText().strip().lower()
        if retry_reroute_mode not in RETRY_REROUTE_MODE_OPTIONS:
            self.settings_status_label.setText("Retry reroute mode is invalid.")
            return None
        try:
            retry_attempts_per_task = int(self.settings_retry_attempts_per_task_input.text().strip())
        except ValueError:
            self.settings_status_label.setText("Retry attempts per task must be an integer.")
            return None
        retry_attempts_per_task = max(1, min(5, retry_attempts_per_task))
        try:
            retry_backoff_base_sec = float(self.settings_retry_backoff_base_input.text().strip())
        except ValueError:
            self.settings_status_label.setText("Retry backoff base must be a number.")
            return None
        retry_backoff_base_sec = max(0.0, min(30.0, retry_backoff_base_sec))
        update_enabled = self.settings_update_enabled_input.currentText().strip().lower() == "true"
        update_feed_url = self.settings_update_feed_url_input.text().strip()
        update_asset_pattern = self.settings_update_asset_pattern_input.text().strip() or UPDATE_ASSET_PATTERN_DEFAULT
        update_check_on_start = self.settings_update_check_on_start_input.currentText().strip().lower() == "true"
        return {
            "nats_url": nats_url,
            "node_candidates": self.settings_nodes_input.text().strip(),
            "poll_interval_sec": poll_interval,
            "discovery_enabled": discovery_enabled,
            "discovery_port": discovery_port,
            "discovery_max_age_sec": discovery_max_age_sec,
            "discovery_auto_switch_nats": discovery_auto_switch_nats,
            "language": language,
            "config_sync_enabled": config_sync_enabled,
            "config_sync_interval_sec": config_sync_interval_sec,
            "config_sync_conflict_policy": config_sync_conflict_policy,
            "log_level": self.settings_log_level_input.currentText().strip(),
            "log_file": self.settings_log_file_input.text().strip(),
            "mcp_config_path": self.settings_mcp_path_input.text().strip(),
            "notification_max_items": notification_max_items,
            "notification_dedupe_window_sec": notification_dedupe_window_sec,
            "notification_auto_mark_read": notification_auto_mark_read,
            "retry_batch_max_limit": retry_batch_max_limit,
            "retry_batch_interval_sec": retry_batch_interval_sec,
            "retry_batch_skip_kinds": retry_batch_skip_kinds,
            "retry_batch_skip_kinds_text": self.settings_retry_batch_skip_kinds_input.text().strip(),
            "retry_reroute_mode": retry_reroute_mode,
            "retry_attempts_per_task": retry_attempts_per_task,
            "retry_backoff_base_sec": retry_backoff_base_sec,
            "update_enabled": update_enabled,
            "update_feed_url": update_feed_url,
            "update_asset_pattern": update_asset_pattern,
            "update_check_on_start": update_check_on_start,
        }

    @asyncSlot()
    async def on_settings_apply(self) -> None:
        payload = self._build_settings_payload()
        if payload is None:
            return
        old_nats = self.config.nats_url
        old_discovery_enabled = self._discovery_enabled
        old_discovery_port = self._discovery_port
        self.config.nats_url = str(payload["nats_url"])
        self.config.node_candidates = [x.strip() for x in str(payload["node_candidates"]).split(",") if x.strip()]
        self.config.poll_interval_sec = float(payload["poll_interval_sec"])
        self._discovery_enabled = bool(payload["discovery_enabled"])
        self._discovery_port = int(payload["discovery_port"])
        self._discovery_max_age_sec = float(payload["discovery_max_age_sec"])
        self._discovery_auto_switch_nats = bool(payload["discovery_auto_switch_nats"])
        self._language = normalize_language(str(payload["language"]))
        self._config_sync_enabled = bool(payload["config_sync_enabled"])
        self._config_sync_interval_sec = float(payload["config_sync_interval_sec"])
        policy = str(payload["config_sync_conflict_policy"]).strip().lower()
        self._config_sync_conflict_policy = (
            policy if policy in CONFIG_SYNC_CONFLICT_POLICY_OPTIONS else CONFIG_SYNC_CONFLICT_POLICY_DEFAULT
        )
        self._discovery_auto_switch_last_attempt = None
        self.config.discovery_enabled = self._discovery_enabled
        self.config.discovery_port = self._discovery_port
        self.config.discovery_max_age_sec = self._discovery_max_age_sec
        self.config.discovery_auto_switch_nats = self._discovery_auto_switch_nats
        self.config.language = self._language
        self.config.config_sync_enabled = self._config_sync_enabled
        self.config.config_sync_interval_sec = self._config_sync_interval_sec
        self.config.config_sync_conflict_policy = self._config_sync_conflict_policy
        self._config_sync_last_run_monotonic = 0.0
        self._config_sync_last_digest = ""
        self._config_sync_node_digest.clear()
        self._config_sync_retry_after.clear()
        mcp_path = str(payload["mcp_config_path"]).strip()
        if mcp_path:
            self.config.mcp_config_path = mcp_path
        self._notification_max_items = int(payload["notification_max_items"])
        self._notification_dedupe_window_sec = float(payload["notification_dedupe_window_sec"])
        self._notification_auto_mark_read = bool(payload["notification_auto_mark_read"])
        self._retry_batch_max_limit = int(payload["retry_batch_max_limit"])
        self._retry_batch_interval_sec = float(payload["retry_batch_interval_sec"])
        self._retry_batch_skip_kinds = set(str(x).strip().lower() for x in payload["retry_batch_skip_kinds"])
        self._retry_reroute_mode = str(payload["retry_reroute_mode"]).strip().lower()
        self._retry_attempts_per_task = int(payload["retry_attempts_per_task"])
        self._retry_backoff_base_sec = float(payload["retry_backoff_base_sec"])
        self._update_enabled = bool(payload["update_enabled"])
        self._update_feed_url = str(payload["update_feed_url"]).strip()
        self._update_asset_pattern = str(payload["update_asset_pattern"]).strip() or UPDATE_ASSET_PATTERN_DEFAULT
        self._update_check_on_start = bool(payload["update_check_on_start"])
        self._sync_retry_batch_runtime_inputs()
        self._append_log(
            "retry policy applied: "
            f"max={self._retry_batch_max_limit} "
            f"interval={self._retry_batch_interval_sec}s "
            f"skip={','.join(sorted(self._retry_batch_skip_kinds)) if self._retry_batch_skip_kinds else 'none'} "
            f"reroute={self._retry_reroute_mode} "
            f"attempts={self._retry_attempts_per_task} "
            f"backoff_base={self._retry_backoff_base_sec}s"
        )
        self._append_log(
            "update policy applied: "
            f"enabled={self._update_enabled} "
            f"on_start={self._update_check_on_start} "
            f"asset_pattern={self._update_asset_pattern}"
        )
        if len(self._notifications) > self._notification_max_items:
            overflow = len(self._notifications) - self._notification_max_items
            if overflow > 0:
                self._notifications = self._notifications[overflow:]
        self._refresh_notifications_view()
        self.node_input.setText(",".join(self.config.node_candidates))
        self._apply_language()
        self._refresh_header()
        if old_discovery_enabled != self._discovery_enabled or old_discovery_port != self._discovery_port:
            await self._stop_discovery_listener()
            await self._start_discovery_listener()
        if self.config.nats_url != old_nats:
            try:
                await self.service.close()
            except Exception:
                pass
            self.service = DesktopControlService(client_id=self.config.client_id, nats_url=self.config.nats_url)
            try:
                await asyncio.wait_for(self.service.connect(), timeout=CONNECT_TIMEOUT_SEC)
                self._set_connection_state(state="connected")
                self._set_connection_feedback("Connected", level="ok")
                self._append_log(f"reconnected nats: {self.config.nats_url}")
            except Exception as exc:
                detail = self._format_connect_error(exc)
                self._set_connection_state(state="disconnected", error=detail)
                self._set_connection_feedback(f"Connect failed: {detail}", level="error")
                self._append_log(f"reconnect failed: {detail}")
        self._load_mcp_services()
        self.settings_status_label.setText("Runtime settings applied.")

    def on_settings_save(self) -> None:
        payload = self._build_settings_payload()
        if payload is None:
            return
        save_settings(self.config.settings_path, payload)
        self.settings_status_label.setText(f"Saved settings to {self.config.settings_path}")

    def on_settings_reload(self) -> None:
        self._load_settings_into_ui()
        self.settings_status_label.setText("Settings reloaded from file.")

    @asyncSlot()
    async def on_check_updates_clicked(self) -> None:
        await self._check_updates(trigger="manual", show_dialog=True)

    async def _check_updates(self, *, trigger: str, show_dialog: bool) -> None:
        if not self._update_enabled:
            if show_dialog:
                QMessageBox.information(self, "Update", "Auto update is disabled in Settings.")
            return
        if not self._update_feed_url.strip():
            if show_dialog:
                QMessageBox.information(self, "Update", "Update feed URL is empty.")
            return
        try:
            info = await asyncio.to_thread(
                check_for_update,
                feed_url=self._update_feed_url,
                current_version_text=self._current_version,
                asset_pattern=self._update_asset_pattern,
                timeout_sec=6.0,
            )
        except Exception as exc:
            self._append_log(f"update check failed trigger={trigger}: {exc}")
            self._add_notification(
                level="warning",
                title="Update Check Failed",
                message=str(exc),
                category="update",
                context={"trigger": trigger, "feed_url": self._update_feed_url},
            )
            if show_dialog:
                QMessageBox.warning(self, "Update Check Failed", str(exc))
            return
        self._handle_update_info(info=info, trigger=trigger, show_dialog=show_dialog)

    def _handle_update_info(self, *, info: UpdateInfo, trigger: str, show_dialog: bool) -> None:
        if info.available:
            message = (
                f"New version available: {info.latest_version} (current {info.current_version})\n"
                f"Asset: {info.asset_name or 'n/a'}"
            )
            self._append_log(f"update available trigger={trigger} current={info.current_version} latest={info.latest_version}")
            self._add_notification(
                level="info",
                title=f"Update Available | v{info.latest_version}",
                message=message,
                category="update",
                context={
                    "trigger": trigger,
                    "current_version": info.current_version,
                    "latest_version": info.latest_version,
                    "asset_name": info.asset_name,
                    "download_url": info.download_url,
                    "release_url": info.release_url,
                },
            )
            if show_dialog:
                detail = message
                if info.download_url:
                    detail += f"\n\nOpen download page now?\n{info.download_url}"
                elif info.release_url:
                    detail += f"\n\nOpen release page now?\n{info.release_url}"
                answer = QMessageBox.question(self, "Update Available", detail)
                if answer == QMessageBox.Yes:
                    target = info.download_url or info.release_url
                    if target:
                        QDesktopServices.openUrl(QUrl(target))
            return

        self._append_log(f"update up-to-date trigger={trigger} version={info.current_version}")
        if show_dialog:
            QMessageBox.information(self, "Update", f"Already up-to-date: {info.current_version}")

    def enable_tray(self, enabled: bool) -> None:
        self._tray_enabled = enabled

    def show_from_tray(self) -> None:
        if self.isMinimized():
            self.showNormal()
        else:
            self.show()
        self.raise_()
        self.activateWindow()

    def request_exit_from_tray(self) -> None:
        self._tray_force_close = True
        self.close()

    def resizeEvent(self, event) -> None:  # type: ignore[override]
        super().resizeEvent(event)
        self._update_result_preview()

    def closeEvent(self, event) -> None:  # type: ignore[override]
        if self._tray_enabled and not self._tray_force_close:
            event.ignore()
            self.hide()
            if not self._tray_hide_hint_shown:
                self._tray_hide_hint_shown = True
                self._append_log("window hidden to system tray; use tray icon menu to restore or exit")
            return
        self._running = False
        super().closeEvent(event)
