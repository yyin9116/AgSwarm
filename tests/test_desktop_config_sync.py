from __future__ import annotations

import unittest

from workflow_desktop.config_sync import decide_sync_action


class DesktopConfigSyncPolicyTests(unittest.TestCase):
    def test_force_push(self) -> None:
        self.assertEqual(
            decide_sync_action(policy="manual", local_digest="abc", remote_digest="xyz", force=True),
            "push",
        )

    def test_skip_same_digest(self) -> None:
        self.assertEqual(
            decide_sync_action(policy="desktop_wins", local_digest="abc", remote_digest="abc"),
            "skip_same",
        )

    def test_policy_desktop_wins(self) -> None:
        self.assertEqual(
            decide_sync_action(policy="desktop_wins", local_digest="abc", remote_digest="xyz"),
            "push",
        )

    def test_policy_node_wins(self) -> None:
        self.assertEqual(
            decide_sync_action(policy="node_wins", local_digest="abc", remote_digest="xyz"),
            "skip_node_wins",
        )

    def test_policy_manual(self) -> None:
        self.assertEqual(
            decide_sync_action(policy="manual", local_digest="abc", remote_digest="xyz"),
            "skip_manual",
        )


if __name__ == "__main__":
    unittest.main()
