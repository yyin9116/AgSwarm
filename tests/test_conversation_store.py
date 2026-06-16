from __future__ import annotations

import tempfile
import unittest
from pathlib import Path

from workflow_desktop.conversation_store import load_conversation_state, save_conversation_state


class ConversationStoreTests(unittest.TestCase):
    def test_save_and_load_conversation_state(self) -> None:
        with tempfile.TemporaryDirectory() as tmp_dir:
            path = Path(tmp_dir) / "nested" / "conversations.json"

            save_conversation_state(
                str(path),
                {
                    "version": 1,
                    "client_id": "desktop-a",
                    "conversation_messages": [{"message_id": "msg-1", "payload": {"text": "hello"}}],
                },
            )

            payload = load_conversation_state(str(path))

        self.assertEqual(payload["client_id"], "desktop-a")
        self.assertEqual(payload["conversation_messages"][0]["payload"]["text"], "hello")

    def test_load_bad_conversation_state_returns_empty_dict(self) -> None:
        with tempfile.TemporaryDirectory() as tmp_dir:
            path = Path(tmp_dir) / "conversations.json"
            path.write_text("{not json", encoding="utf-8")

            payload = load_conversation_state(str(path))

        self.assertEqual(payload, {})

    def test_save_conversation_state_does_not_leave_temp_file(self) -> None:
        with tempfile.TemporaryDirectory() as tmp_dir:
            path = Path(tmp_dir) / "conversations.json"

            save_conversation_state(str(path), {"version": 1})
            leftovers = list(Path(tmp_dir).glob(".conversations.json.*.tmp"))

        self.assertEqual(leftovers, [])


if __name__ == "__main__":
    unittest.main()
