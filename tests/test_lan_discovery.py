from __future__ import annotations

import json
import time
import unittest

import workflow_discovery.lan as lan


class LanDiscoveryTests(unittest.TestCase):
    def test_is_loopback_nats_url(self) -> None:
        self.assertTrue(lan.is_loopback_nats_url("nats://127.0.0.1:4222"))
        self.assertTrue(lan.is_loopback_nats_url("nats://localhost:4222"))
        self.assertFalse(lan.is_loopback_nats_url("nats://192.168.1.8:4222"))

    def test_resolve_advertise_nats_url_explicit(self) -> None:
        value = lan.resolve_advertise_nats_url(
            "nats://127.0.0.1:4222",
            explicit_advertise_url="nats://10.0.0.9:4222",
        )
        self.assertEqual(value, "nats://10.0.0.9:4222")

    def test_resolve_advertise_nats_url_rewrite_loopback(self) -> None:
        original = lan._detect_lan_ipv4
        lan._detect_lan_ipv4 = lambda: "10.11.12.13"
        try:
            value = lan.resolve_advertise_nats_url("nats://127.0.0.1:4222")
        finally:
            lan._detect_lan_ipv4 = original
        self.assertEqual(value, "nats://10.11.12.13:4222")

    def test_listener_snapshot_and_prune(self) -> None:
        listener = lan.LanNodeListener(port=48666)
        payload = {
            "kind": lan.DISCOVERY_KIND,
            "node_id": "node-a",
            "nats_url": "nats://10.1.1.2:4222",
            "hostname": "host-a",
            "status": "idle",
            "active_tasks": 0,
            "queued_tasks": 0,
        }
        listener._on_datagram(json.dumps(payload).encode("utf-8"), ("10.1.1.2", 48666))
        snap = listener.snapshot(max_age_sec=10.0)
        self.assertIn("node-a", snap)
        self.assertEqual(snap["node-a"].hostname, "host-a")
        listener._nodes["node-a"].last_seen_monotonic = time.monotonic() - 99.0
        pruned = listener.snapshot(max_age_sec=1.0)
        self.assertNotIn("node-a", pruned)


if __name__ == "__main__":
    unittest.main()
