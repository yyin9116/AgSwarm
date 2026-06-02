from __future__ import annotations

import tempfile
import unittest
from pathlib import Path

from scripts import smoke_two_desktop_clients


class TwoDesktopSmokeScriptTests(unittest.TestCase):
    def test_parser_defaults_are_local_multi_client_flow(self) -> None:
        parser = smoke_two_desktop_clients.build_parser()
        args = parser.parse_args([])

        self.assertIn("background peer", parser.description or "")
        self.assertEqual(args.nats_url, "nats://127.0.0.1:4222")
        self.assertEqual(args.client_a, "desktop-a")
        self.assertEqual(args.client_b, "desktop-b")
        self.assertEqual(args.expected_stdout, "TWO_DESKTOP_CLIENTS_OK")
        self.assertFalse(args.no_start_nats)
        self.assertFalse(args.keep_state)
        self.assertIn("desktop-smoke-state", args.state_dir)
        self.assertEqual(args.settle_sec, 0.6)

    def test_reset_smoke_state_removes_background_client_state(self) -> None:
        with tempfile.TemporaryDirectory() as tmp_dir:
            root = Path(tmp_dir)
            for client_id in ("desktop-a", "desktop-b", "desktop-b-background"):
                path = smoke_two_desktop_clients._smoke_state_path(state_root=root, client_id=client_id)
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_text("{}", encoding="utf-8")

            smoke_two_desktop_clients._reset_smoke_state(
                state_root=root,
                client_ids=("desktop-a", "desktop-b", "desktop-b-background"),
            )

            for client_id in ("desktop-a", "desktop-b", "desktop-b-background"):
                path = smoke_two_desktop_clients._smoke_state_path(state_root=root, client_id=client_id)
                self.assertFalse(path.exists())


if __name__ == "__main__":
    unittest.main()
