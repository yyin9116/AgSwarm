from __future__ import annotations

import tempfile
import unittest
from pathlib import Path

from scripts import launch_two_desktop_clients


class TwoDesktopLauncherTests(unittest.TestCase):
    def test_client_command_uses_distinct_identity_and_state_paths(self) -> None:
        command = launch_two_desktop_clients._client_command(
            python_bin="python",
            client_id="desktop-a",
            display_name="Desktop A",
            nats_url="nats://127.0.0.1:4222",
            nodes="node-pi",
            poll_interval_sec=2.0,
            log_level="DEBUG",
            state_root=Path("/tmp/workflow-desktop-state"),
        )

        self.assertIn("--client-id", command)
        self.assertIn("desktop-a", command)
        self.assertIn("--display-name", command)
        self.assertIn("Desktop A", command)
        self.assertIn("--settings-path", command)
        self.assertTrue(any("/tmp/workflow-desktop-state/desktop-a/settings.json" in item for item in command))
        self.assertTrue(any("/tmp/workflow-desktop-state/desktop-a/conversations.json" in item for item in command))
        self.assertTrue(any("/tmp/workflow-desktop-state/desktop-a/mcp-services.json" in item for item in command))
        self.assertTrue(any("desktop-a.app.log" in item for item in command))

    def test_parser_supports_dry_run_without_starting_processes(self) -> None:
        args = launch_two_desktop_clients.build_parser().parse_args(["--dry-run"])

        self.assertTrue(args.dry_run)
        self.assertEqual(args.client_a, "desktop-a")
        self.assertEqual(args.client_b, "desktop-b")
        self.assertIn("desktop-clients", args.state_dir)
        self.assertFalse(args.reset_state)

    def test_reset_client_state_removes_only_client_state_files(self) -> None:
        with tempfile.TemporaryDirectory() as tmp_dir:
            root = Path(tmp_dir)
            state_dir = root / "desktop-a"
            state_dir.mkdir(parents=True)
            for name in ("settings.json", "conversations.json", "mcp-services.json", "keep.log"):
                (state_dir / name).write_text("x", encoding="utf-8")

            launch_two_desktop_clients._reset_client_state(
                state_root=root,
                client_ids=("desktop-a", "desktop-b"),
            )

            self.assertFalse((state_dir / "settings.json").exists())
            self.assertFalse((state_dir / "conversations.json").exists())
            self.assertFalse((state_dir / "mcp-services.json").exists())
            self.assertTrue((state_dir / "keep.log").exists())


if __name__ == "__main__":
    unittest.main()
