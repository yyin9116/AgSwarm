from __future__ import annotations

import unittest

from workflow_runtime.error_codes import build_error_summary, extract_error_code, extract_error_message


class ErrorCodesTests(unittest.TestCase):
    def test_extract_error_code_from_user_message_code(self) -> None:
        payload = {
            "status": "failed",
            "user_messages": [
                {"level": "error", "message": "compile failed", "code": "latex_compile_failed"},
            ],
        }
        self.assertEqual(extract_error_code(payload), "latex_compile_failed")

    def test_extract_error_code_from_transfer_command_context(self) -> None:
        payload = {
            "ok": False,
            "status": "failed",
            "command": "download-dir",
            "error": "source_not_found",
        }
        self.assertEqual(extract_error_code(payload), "transfer.failed")

    def test_extract_error_message_from_failures_list(self) -> None:
        payload = {
            "ok": False,
            "failures": [
                {"source_path": "a.txt", "error": "chunk timeout"},
            ],
        }
        self.assertEqual(extract_error_message(payload), "chunk timeout")

    def test_build_error_summary_with_fallback_user_message(self) -> None:
        payload = {
            "ok": False,
            "status": "failed",
            "command": "upload-file",
            "error": "commit failed",
        }
        summary = build_error_summary(payload)
        self.assertEqual(summary["code"], "transfer.failed")
        self.assertEqual(summary["message"], "commit failed")
        self.assertTrue(summary["user_messages"])
        self.assertIn("commit failed", summary["user_messages"][0])


if __name__ == "__main__":
    unittest.main()
