from __future__ import annotations

import asyncio
import os
import tempfile
import unittest

try:
    from PySide6.QtWidgets import QApplication
except Exception:  # pragma: no cover
    QApplication = None  # type: ignore[assignment]

from workflow_desktop.models import DesktopConfig


@unittest.skipIf(QApplication is None, "PySide6 is not installed")
class DesktopConversationStateTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        os.environ.setdefault("QT_QPA_PLATFORM", "offscreen")
        cls._app = QApplication.instance() or QApplication([])

    def test_conversation_dedupes_messages_and_updates_task_result_record(self) -> None:
        from workflow_desktop.main_window import MainWindow

        with tempfile.TemporaryDirectory() as tmp_dir:
            window = MainWindow(
                DesktopConfig(
                    nats_url="nats://127.0.0.1:4222",
                    client_id="desktop-a",
                    node_candidates=[],
                    conversation_state_path=os.path.join(tmp_dir, "state.json"),
                )
            )

            request = {
                "type": "task.request",
                "message_id": "req-1",
                "conversation_id": "desktop-a:desktop-b",
                "from_client_id": "desktop-a",
                "target_client_id": "desktop-b",
                "payload": {"instruction": "write script"},
                "ts": "2026-06-02T00:00:00",
            }
            added = window._append_conversation_message(direction="out", message=request)
            duplicate_added = window._append_conversation_message(direction="out", message=request)
            record_id = window._register_task_record(
                kind="client-task-request",
                node_id="desktop-b",
                result={"status": "sent", "ok": True, "message": request},
                request={"instruction": "write script", "target_client_id": "desktop-b"},
            )
            window._task_request_records["req-1"] = record_id

            window._handle_client_inbox_message(
                {
                    "type": "task.result",
                    "message_id": "res-1",
                    "conversation_id": "desktop-a:desktop-b",
                    "from_client_id": "desktop-b",
                    "target_client_id": "desktop-a",
                    "payload": {
                        "request_message_id": "req-1",
                        "result": {"ok": True, "returncode": 0, "stdout": "done\n"},
                    },
                    "ts": "2026-06-02T00:00:03",
                }
            )

            self.assertTrue(added)
            self.assertFalse(duplicate_added)
            self.assertEqual(len(window._conversation_messages), 2)
            self.assertEqual(window._task_records[record_id]["status"], "completed")
            self.assertEqual(window._task_records[record_id]["result"]["script_result"]["stdout"], "done\n")
            rows = [window.conversation_list.item(i).text() for i in range(window.conversation_list.count())]
            self.assertTrue(any("TASK REQUEST [completed]" in row for row in rows))

    def test_inbound_task_request_can_be_selected_and_tracked(self) -> None:
        from workflow_desktop.main_window import MainWindow

        with tempfile.TemporaryDirectory() as tmp_dir:
            window = MainWindow(
                DesktopConfig(
                    nats_url="nats://127.0.0.1:4222",
                    client_id="desktop-b",
                    node_candidates=[],
                    conversation_state_path=os.path.join(tmp_dir, "state.json"),
                )
            )

            first = {
                "type": "task.request",
                "message_id": "req-old",
                "conversation_id": "desktop-a:desktop-b",
                "from_client_id": "desktop-a",
                "target_client_id": "desktop-b",
                "payload": {"instruction": "old request", "suggested_script": "print('old')"},
                "ts": "2026-06-02T00:00:00",
            }
            second = {
                "type": "task.request",
                "message_id": "req-new",
                "conversation_id": "desktop-a:desktop-b",
                "from_client_id": "desktop-a",
                "target_client_id": "desktop-b",
                "payload": {"instruction": "new request", "suggested_script": "print('new')"},
                "ts": "2026-06-02T00:00:01",
            }

            window._handle_client_inbox_message(first)
            window._handle_client_inbox_message(second)

            self.assertEqual(len(window._inbound_task_request_records), 2)
            self.assertEqual(window._task_records[window._inbound_task_request_records["req-old"]]["status"], "received")
            self.assertEqual(window._peer_conversation_stats("desktop-a")["open_inbound"], 2)
            self.assertIn("Open inbound: 2", window.conversation_summary_label.text())
            self.assertIn("new request", window.script_request_label.text())
            self.assertIn("print('new')", window.script_editor.toPlainText())

            for row in range(window.conversation_list.count()):
                item = window.conversation_list.item(row)
                if item is not None and item.data(256) == "req-old":
                    window.conversation_list.setCurrentRow(row)
                    break

            self.assertIn("old request", window.script_request_label.text())
            self.assertIn("print('old')", window.script_editor.toPlainText())

            record_id = window._inbound_task_request_records["req-old"]
            window._task_records[record_id]["status"] = "ready-to-return"
            window._refresh_task_item(record_id)
            window._refresh_conversation_state_views()
            rows = [window.conversation_list.item(i).text() for i in range(window.conversation_list.count())]
            self.assertTrue(any("TASK REQUEST [ready-to-return]" in row for row in rows))
            self.assertIn("Open inbound: 2", window.conversation_summary_label.text())

    def test_sent_task_request_renders_tracked_state_immediately(self) -> None:
        from workflow_desktop.main_window import MainWindow

        class FakeService:
            async def send_task_request(
                self,
                *,
                target_client_id: str,
                instruction: str,
                suggested_script: str,
                conversation_id: str,
            ) -> dict:
                return {
                    "type": "task.request",
                    "message_id": "req-1",
                    "conversation_id": conversation_id,
                    "from_client_id": "desktop-a",
                    "target_client_id": target_client_id,
                    "payload": {"instruction": instruction, "suggested_script": suggested_script},
                    "ts": "2026-06-02T00:00:00",
                }

        with tempfile.TemporaryDirectory() as tmp_dir:
            window = MainWindow(
                DesktopConfig(
                    nats_url="nats://127.0.0.1:4222",
                    client_id="desktop-a",
                    node_candidates=[],
                    conversation_state_path=os.path.join(tmp_dir, "state.json"),
                )
            )
            window.service = FakeService()  # type: ignore[assignment]
            window.peer_input.setText("desktop-b")
            window.on_add_peer_clicked()
            window.chat_input.setPlainText("write a script")
            window.script_editor.setPlainText("print('ok')")

            loop = asyncio.new_event_loop()
            try:
                asyncio.set_event_loop(loop)
                task = window.on_send_task_request_clicked()
                loop.run_until_complete(task)
            finally:
                asyncio.set_event_loop(None)
                loop.close()

            rows = [window.conversation_list.item(i).text() for i in range(window.conversation_list.count())]
            peer_rows = [window.peers_list.item(i).text() for i in range(window.peers_list.count())]

        self.assertTrue(any("TASK REQUEST [sent]" in row for row in rows))
        self.assertFalse(any("TASK REQUEST [untracked]" in row for row in rows))
        self.assertIn("Open outbound: 1", window.conversation_summary_label.text())
        self.assertTrue(any("Open: in=0 out=1" in row for row in peer_rows))

    def test_sent_chat_message_refreshes_peer_summary_immediately(self) -> None:
        from workflow_desktop.main_window import MainWindow

        class FakeService:
            async def send_chat_message(
                self,
                *,
                target_client_id: str,
                text: str,
                conversation_id: str,
            ) -> dict:
                return {
                    "type": "chat.message",
                    "message_id": "msg-1",
                    "conversation_id": conversation_id,
                    "from_client_id": "desktop-a",
                    "target_client_id": target_client_id,
                    "payload": {"text": text},
                    "ts": "2026-06-02T00:00:00",
                }

        with tempfile.TemporaryDirectory() as tmp_dir:
            window = MainWindow(
                DesktopConfig(
                    nats_url="nats://127.0.0.1:4222",
                    client_id="desktop-a",
                    node_candidates=[],
                    conversation_state_path=os.path.join(tmp_dir, "state.json"),
                )
            )
            window.service = FakeService()  # type: ignore[assignment]
            window.peer_input.setText("desktop-b")
            window.on_add_peer_clicked()
            window.chat_input.setPlainText("hello")

            loop = asyncio.new_event_loop()
            try:
                asyncio.set_event_loop(loop)
                task = window.on_send_chat_clicked()
                loop.run_until_complete(task)
            finally:
                asyncio.set_event_loop(None)
                loop.close()

            peer_rows = [window.peers_list.item(i).text() for i in range(window.peers_list.count())]

        self.assertEqual(window.conversation_list.count(), 1)
        self.assertIn("hello", window.conversation_list.item(0).text())
        self.assertIn("Messages: 1", window.conversation_summary_label.text())
        self.assertTrue(any("Messages: 1" in row for row in peer_rows))

    def test_conversation_state_persists_across_windows(self) -> None:
        from workflow_desktop.main_window import MainWindow

        with tempfile.TemporaryDirectory() as tmp_dir:
            state_path = os.path.join(tmp_dir, "desktop-a-conversations.json")
            first = MainWindow(
                DesktopConfig(
                    nats_url="nats://127.0.0.1:4222",
                    client_id="desktop-a",
                    node_candidates=[],
                    conversation_state_path=state_path,
                )
            )
            first._client_peers["desktop-b"] = {
                "client_id": "desktop-b",
                "status": "manual",
                "last_seen": "-",
                "payload": {},
            }
            first._selected_peer_id = "desktop-b"
            first._append_conversation_message(
                direction="out",
                message={
                    "type": "chat.message",
                    "message_id": "msg-1",
                    "conversation_id": "desktop-a:desktop-b",
                    "from_client_id": "desktop-a",
                    "target_client_id": "desktop-b",
                    "payload": {"text": "hello persisted"},
                    "ts": "2026-06-02T00:00:00",
                },
            )
            first._task_request_records["req-1"] = "client-task-request-0001"
            first._task_records["client-task-request-0001"] = {
                "record_id": "client-task-request-0001",
                "kind": "client-task-request",
                "node_id": "desktop-b",
                "created_at": "2026-06-02T00:00:00",
                "status": "sent",
                "result": {},
                "request": {},
                "artifacts": [],
                "timeline": [],
            }
            first._task_order.append("client-task-request-0001")
            first._save_conversation_state()

            second = MainWindow(
                DesktopConfig(
                    nats_url="nats://127.0.0.1:4222",
                    client_id="desktop-a",
                    node_candidates=[],
                    conversation_state_path=state_path,
                )
            )

        self.assertIn("desktop-b", second._client_peers)
        self.assertEqual(second._selected_peer_id, "desktop-b")
        self.assertEqual(len(second._conversation_messages), 1)
        self.assertEqual(second._conversation_messages[0]["payload"]["text"], "hello persisted")
        self.assertEqual(second._task_request_records["req-1"], "client-task-request-0001")
        self.assertIn("client-task-request-0001", second._task_records)
        self.assertEqual(second._peer_conversation_stats("desktop-b")["messages"], 1)
        self.assertIn("Messages: 1", second.conversation_summary_label.text())

    def test_peer_unread_count_is_cleared_when_selected_and_persisted(self) -> None:
        from workflow_desktop.main_window import MainWindow

        with tempfile.TemporaryDirectory() as tmp_dir:
            state_path = os.path.join(tmp_dir, "desktop-b-conversations.json")
            first = MainWindow(
                DesktopConfig(
                    nats_url="nats://127.0.0.1:4222",
                    client_id="desktop-b",
                    node_candidates=[],
                    conversation_state_path=state_path,
                )
            )
            first._handle_client_inbox_message(
                {
                    "type": "chat.message",
                    "message_id": "msg-1",
                    "conversation_id": "desktop-a:desktop-b",
                    "from_client_id": "desktop-a",
                    "target_client_id": "desktop-b",
                    "payload": {"text": "hello unread"},
                    "ts": "2026-06-02T00:00:00",
                }
            )

            self.assertEqual(first._peer_conversation_stats("desktop-a")["unread"], 1)
            first._selected_peer_id = "desktop-a"
            first._refresh_peer_list()
            first.on_peer_selection_changed()

            self.assertEqual(first._peer_conversation_stats("desktop-a")["unread"], 0)
            self.assertIn("Unread: 0", first.conversation_summary_label.text())

            second = MainWindow(
                DesktopConfig(
                    nats_url="nats://127.0.0.1:4222",
                    client_id="desktop-b",
                    node_candidates=[],
                    conversation_state_path=state_path,
                )
            )

        self.assertEqual(second._peer_conversation_stats("desktop-a")["unread"], 0)
        self.assertEqual(second._peer_read_cursors["desktop-a"], "msg-1")

    def test_selected_peer_incoming_message_is_marked_read_immediately(self) -> None:
        from workflow_desktop.main_window import MainWindow

        with tempfile.TemporaryDirectory() as tmp_dir:
            window = MainWindow(
                DesktopConfig(
                    nats_url="nats://127.0.0.1:4222",
                    client_id="desktop-b",
                    node_candidates=[],
                    conversation_state_path=os.path.join(tmp_dir, "state.json"),
                )
            )
            window.peer_input.setText("desktop-a")
            window.on_add_peer_clicked()

            window._handle_client_inbox_message(
                {
                    "type": "chat.message",
                    "message_id": "msg-1",
                    "conversation_id": "desktop-a:desktop-b",
                    "from_client_id": "desktop-a",
                    "target_client_id": "desktop-b",
                    "payload": {"text": "visible message"},
                    "ts": "2026-06-02T00:00:00",
                }
            )

        self.assertEqual(window._peer_conversation_stats("desktop-a")["unread"], 0)
        self.assertEqual(window._peer_read_cursors["desktop-a"], "msg-1")
        self.assertIn("Unread: 0", window.conversation_summary_label.text())

    def test_auto_selected_first_peer_updates_conversation_scope(self) -> None:
        from workflow_desktop.main_window import MainWindow

        with tempfile.TemporaryDirectory() as tmp_dir:
            window = MainWindow(
                DesktopConfig(
                    nats_url="nats://127.0.0.1:4222",
                    client_id="desktop-b",
                    node_candidates=[],
                    conversation_state_path=os.path.join(tmp_dir, "state.json"),
                )
            )
            window._client_peers["desktop-a"] = {
                "client_id": "desktop-a",
                "status": "manual",
                "last_seen": "-",
                "payload": {},
            }
            window._append_conversation_message(
                direction="in",
                message={
                    "type": "chat.message",
                    "message_id": "msg-a",
                    "conversation_id": "desktop-a:desktop-b",
                    "from_client_id": "desktop-a",
                    "target_client_id": "desktop-b",
                    "payload": {"text": "from A"},
                    "ts": "2026-06-02T00:00:00",
                },
            )
            window._append_conversation_message(
                direction="in",
                message={
                    "type": "chat.message",
                    "message_id": "msg-c",
                    "conversation_id": "desktop-b:desktop-c",
                    "from_client_id": "desktop-c",
                    "target_client_id": "desktop-b",
                    "payload": {"text": "from C"},
                    "ts": "2026-06-02T00:00:01",
                },
            )
            window._refresh_peer_list()
            window._refresh_conversation_view()

        self.assertEqual(window._selected_peer_id, "desktop-a")
        self.assertEqual(window.peer_input.text(), "desktop-a")
        self.assertIn("Conversation with desktop-a", window.conversation_title.text())
        self.assertEqual(window.conversation_list.count(), 1)
        self.assertIn("from A", window.conversation_list.item(0).text())

    def test_inbox_message_refreshes_existing_manual_peer_metadata(self) -> None:
        from workflow_desktop.main_window import MainWindow

        with tempfile.TemporaryDirectory() as tmp_dir:
            window = MainWindow(
                DesktopConfig(
                    nats_url="nats://127.0.0.1:4222",
                    client_id="desktop-b",
                    node_candidates=[],
                    conversation_state_path=os.path.join(tmp_dir, "state.json"),
                )
            )
            window.peer_input.setText("desktop-a")
            window.on_add_peer_clicked()
            self.assertEqual(window._client_peers["desktop-a"]["status"], "manual")

            window._handle_client_inbox_message(
                {
                    "type": "chat.message",
                    "message_id": "msg-1",
                    "conversation_id": "desktop-a:desktop-b",
                    "from_client_id": "desktop-a",
                    "target_client_id": "desktop-b",
                    "payload": {"text": "hello"},
                    "ts": "2026-06-02T00:00:00",
                }
            )

            self.assertEqual(window._client_peers["desktop-a"]["status"], "online")
            self.assertEqual(window._client_peers["desktop-a"]["last_seen"], "2026-06-02T00:00:00")
            self.assertEqual(window._client_peers["desktop-a"]["payload"]["message_id"], "msg-1")

    def test_task_request_from_other_peer_does_not_steal_script_runner(self) -> None:
        from workflow_desktop.main_window import MainWindow

        with tempfile.TemporaryDirectory() as tmp_dir:
            window = MainWindow(
                DesktopConfig(
                    nats_url="nats://127.0.0.1:4222",
                    client_id="desktop-b",
                    node_candidates=[],
                    conversation_state_path=os.path.join(tmp_dir, "state.json"),
                )
            )
            window.peer_input.setText("desktop-a")
            window.on_add_peer_clicked()

            from_a = {
                "type": "task.request",
                "message_id": "req-a",
                "conversation_id": "desktop-a:desktop-b",
                "from_client_id": "desktop-a",
                "target_client_id": "desktop-b",
                "payload": {"instruction": "request from A", "suggested_script": "print('A')"},
                "ts": "2026-06-02T00:00:00",
            }
            from_c = {
                "type": "task.request",
                "message_id": "req-c",
                "conversation_id": "desktop-b:desktop-c",
                "from_client_id": "desktop-c",
                "target_client_id": "desktop-b",
                "payload": {"instruction": "request from C", "suggested_script": "print('C')"},
                "ts": "2026-06-02T00:00:01",
            }

            window._handle_client_inbox_message(from_a)
            self.assertIn("request from A", window.script_request_label.text())
            self.assertIn("print('A')", window.script_editor.toPlainText())

            window.script_editor.setPlainText("print('custom work in progress')")
            window._handle_client_inbox_message(from_c)

            self.assertIn("request from A", window.script_request_label.text())
            self.assertIn("custom work in progress", window.script_editor.toPlainText())
            self.assertEqual(window._peer_conversation_stats("desktop-c")["unread"], 1)

            window.on_use_latest_task_request_clicked()
            self.assertIn("request from A", window.script_request_label.text())
            self.assertIn("print('A')", window.script_editor.toPlainText())

    def test_background_request_does_not_steal_script_result_binding(self) -> None:
        from workflow_desktop.main_window import MainWindow

        with tempfile.TemporaryDirectory() as tmp_dir:
            window = MainWindow(
                DesktopConfig(
                    nats_url="nats://127.0.0.1:4222",
                    client_id="desktop-b",
                    node_candidates=[],
                    conversation_state_path=os.path.join(tmp_dir, "state.json"),
                )
            )
            window.peer_input.setText("desktop-a")
            window.on_add_peer_clicked()

            from_a = {
                "type": "task.request",
                "message_id": "req-a",
                "conversation_id": "desktop-a:desktop-b",
                "from_client_id": "desktop-a",
                "target_client_id": "desktop-b",
                "payload": {"instruction": "request from A", "suggested_script": "print('A')"},
                "ts": "2026-06-02T00:00:00",
            }
            from_c = {
                "type": "task.request",
                "message_id": "req-c",
                "conversation_id": "desktop-b:desktop-c",
                "from_client_id": "desktop-c",
                "target_client_id": "desktop-b",
                "payload": {"instruction": "request from C", "suggested_script": "print('C')"},
                "ts": "2026-06-02T00:00:01",
            }

            window._handle_client_inbox_message(from_a)
            window._handle_client_inbox_message(from_c)
            window._last_script_result = {"ok": True, "returncode": 0, "stdout": "A\n"}
            source = window._active_task_request or {}
            window._last_script_result_request_id = str(source.get("message_id", "")).strip()
            window.script_result_text.setPlainText(
                '{"request_message_id": "req-a", "result": {"ok": true, "stdout": "A\\n"}}'
            )

            self.assertEqual(window._latest_task_request["message_id"], "req-c")
            self.assertEqual(window._active_task_request["message_id"], "req-a")
            self.assertEqual(window._last_script_result_request_id, "req-a")

    def test_active_task_request_persists_across_windows(self) -> None:
        from workflow_desktop.main_window import MainWindow

        with tempfile.TemporaryDirectory() as tmp_dir:
            state_path = os.path.join(tmp_dir, "desktop-b-conversations.json")
            first = MainWindow(
                DesktopConfig(
                    nats_url="nats://127.0.0.1:4222",
                    client_id="desktop-b",
                    node_candidates=[],
                    conversation_state_path=state_path,
                )
            )
            first.peer_input.setText("desktop-a")
            first.on_add_peer_clicked()
            first._handle_client_inbox_message(
                {
                    "type": "task.request",
                    "message_id": "req-a",
                    "conversation_id": "desktop-a:desktop-b",
                    "from_client_id": "desktop-a",
                    "target_client_id": "desktop-b",
                    "payload": {"instruction": "request from A", "suggested_script": "print('A')"},
                    "ts": "2026-06-02T00:00:00",
                }
            )
            first._handle_client_inbox_message(
                {
                    "type": "task.request",
                    "message_id": "req-c",
                    "conversation_id": "desktop-b:desktop-c",
                    "from_client_id": "desktop-c",
                    "target_client_id": "desktop-b",
                    "payload": {"instruction": "request from C", "suggested_script": "print('C')"},
                    "ts": "2026-06-02T00:00:01",
                }
            )
            first._save_conversation_state()

            second = MainWindow(
                DesktopConfig(
                    nats_url="nats://127.0.0.1:4222",
                    client_id="desktop-b",
                    node_candidates=[],
                    conversation_state_path=state_path,
                )
            )

        self.assertEqual(second._latest_task_request["message_id"], "req-c")
        self.assertEqual(second._active_task_request["message_id"], "req-a")

    def test_switching_peer_loads_latest_request_without_overwriting_manual_script(self) -> None:
        from workflow_desktop.main_window import MainWindow

        with tempfile.TemporaryDirectory() as tmp_dir:
            window = MainWindow(
                DesktopConfig(
                    nats_url="nats://127.0.0.1:4222",
                    client_id="desktop-b",
                    node_candidates=[],
                    conversation_state_path=os.path.join(tmp_dir, "state.json"),
                )
            )
            window._handle_client_inbox_message(
                {
                    "type": "task.request",
                    "message_id": "req-a",
                    "conversation_id": "desktop-a:desktop-b",
                    "from_client_id": "desktop-a",
                    "target_client_id": "desktop-b",
                    "payload": {"instruction": "request from A", "suggested_script": "print('A')"},
                    "ts": "2026-06-02T00:00:00",
                }
            )
            window._handle_client_inbox_message(
                {
                    "type": "task.request",
                    "message_id": "req-c",
                    "conversation_id": "desktop-b:desktop-c",
                    "from_client_id": "desktop-c",
                    "target_client_id": "desktop-b",
                    "payload": {"instruction": "request from C", "suggested_script": "print('C')"},
                    "ts": "2026-06-02T00:00:01",
                }
            )

            window._selected_peer_id = "desktop-a"
            window._refresh_peer_list()
            window.on_peer_selection_changed()
            self.assertIn("request from A", window.script_request_label.text())
            self.assertIn("print('A')", window.script_editor.toPlainText())

            window.script_editor.setPlainText("print('manual edit')")
            window._selected_peer_id = "desktop-c"
            window._refresh_peer_list()
            window.on_peer_selection_changed()
            self.assertIn("request from C", window.script_request_label.text())
            self.assertIn("manual edit", window.script_editor.toPlainText())

    def test_loading_different_request_clears_stale_script_result_binding(self) -> None:
        from workflow_desktop.main_window import MainWindow

        with tempfile.TemporaryDirectory() as tmp_dir:
            window = MainWindow(
                DesktopConfig(
                    nats_url="nats://127.0.0.1:4222",
                    client_id="desktop-b",
                    node_candidates=[],
                    conversation_state_path=os.path.join(tmp_dir, "state.json"),
                )
            )
            first = {
                "type": "task.request",
                "message_id": "req-a",
                "conversation_id": "desktop-a:desktop-b",
                "from_client_id": "desktop-a",
                "target_client_id": "desktop-b",
                "payload": {"instruction": "request from A", "suggested_script": "print('A')"},
                "ts": "2026-06-02T00:00:00",
            }
            second = {
                "type": "task.request",
                "message_id": "req-c",
                "conversation_id": "desktop-b:desktop-c",
                "from_client_id": "desktop-c",
                "target_client_id": "desktop-b",
                "payload": {"instruction": "request from C", "suggested_script": "print('C')"},
                "ts": "2026-06-02T00:00:01",
            }

            window._load_task_request(first, overwrite_script=True)
            window._last_script_result = {"ok": True, "stdout": "A\n"}
            window._last_script_result_request_id = "req-a"
            window.script_result_text.setPlainText('{"ok": true, "stdout": "A\\n"}')

            window._load_task_request(second, overwrite_script=True)

            self.assertEqual(window._last_script_result_request_id, "")
            self.assertIsNone(window._last_script_result)
            self.assertEqual(window.script_result_text.toPlainText(), "")

    def test_script_result_display_includes_bound_request(self) -> None:
        from workflow_desktop.main_window import MainWindow

        with tempfile.TemporaryDirectory() as tmp_dir:
            window = MainWindow(
                DesktopConfig(
                    nats_url="nats://127.0.0.1:4222",
                    client_id="desktop-b",
                    node_candidates=[],
                    conversation_state_path=os.path.join(tmp_dir, "state.json"),
                )
            )
            request = {
                "type": "task.request",
                "message_id": "req-a",
                "conversation_id": "desktop-a:desktop-b",
                "from_client_id": "desktop-a",
                "target_client_id": "desktop-b",
                "payload": {"instruction": "request from A"},
                "ts": "2026-06-02T00:00:00",
            }

            payload = window._script_result_display_payload(
                request=request,
                result={"ok": True, "stdout": "A\n"},
            )

        self.assertEqual(payload["request_message_id"], "req-a")
        self.assertEqual(payload["request_from_client_id"], "desktop-a")
        self.assertEqual(payload["result"]["stdout"], "A\n")

    def test_ready_to_return_result_restores_after_restart(self) -> None:
        from workflow_desktop.main_window import MainWindow

        request = {
            "type": "task.request",
            "message_id": "req-a",
            "conversation_id": "desktop-a:desktop-b",
            "from_client_id": "desktop-a",
            "target_client_id": "desktop-b",
            "payload": {"instruction": "request from A", "suggested_script": "print('A')"},
            "ts": "2026-06-02T00:00:00",
        }
        with tempfile.TemporaryDirectory() as tmp_dir:
            state_path = os.path.join(tmp_dir, "desktop-b-conversations.json")
            first = MainWindow(
                DesktopConfig(
                    nats_url="nats://127.0.0.1:4222",
                    client_id="desktop-b",
                    node_candidates=[],
                    conversation_state_path=state_path,
                )
            )
            first._handle_client_inbox_message(request)
            record_id = first._inbound_task_request_records["req-a"]
            first._task_records[record_id]["status"] = "ready-to-return"
            first._task_records[record_id]["result"] = {
                "status": "ready-to-return",
                "ok": True,
                "message": request,
                "script_result": {"ok": True, "returncode": 0, "stdout": "A\n"},
            }
            first._save_conversation_state()

            second = MainWindow(
                DesktopConfig(
                    nats_url="nats://127.0.0.1:4222",
                    client_id="desktop-b",
                    node_candidates=[],
                    conversation_state_path=state_path,
                )
            )
            second._load_task_request(request, overwrite_script=True)

        self.assertEqual(second._last_script_result_request_id, "req-a")
        self.assertIn('"request_message_id": "req-a"', second.script_result_text.toPlainText())
        self.assertIn('"stdout": "A\\n"', second.script_result_text.toPlainText())


if __name__ == "__main__":
    unittest.main()
