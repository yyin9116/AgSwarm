from __future__ import annotations

import io
import json
import unittest
from contextlib import redirect_stdout

from workflow_cli.__main__ import _attach_error_summary, _print_error_and_exit


class CliErrorSummaryTests(unittest.TestCase):
    def test_attach_error_summary_for_failure(self) -> None:
        payload = {
            "ok": False,
            "status": "failed",
            "command": "download-file",
            "error": "source_not_found",
        }
        enriched = _attach_error_summary(payload)
        self.assertIn("error_summary", enriched)
        self.assertEqual(enriched["error_summary"]["code"], "transfer.failed")

    def test_print_error_and_exit_outputs_json(self) -> None:
        buf = io.StringIO()
        with self.assertRaises(SystemExit) as ctx:
            with redirect_stdout(buf):
                _print_error_and_exit(
                    RuntimeError("download failed"),
                    context={"command": "download-dir", "node_id": "node-a"},
                )
        self.assertEqual(ctx.exception.code, 2)
        body = buf.getvalue().strip()
        data = json.loads(body)
        self.assertFalse(data["ok"])
        self.assertEqual(data["command"], "download-dir")
        self.assertIn("error_summary", data)
        self.assertEqual(data["error_summary"]["code"], "transfer.failed")


if __name__ == "__main__":
    unittest.main()
