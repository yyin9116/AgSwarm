from __future__ import annotations

import importlib.util
import sys
import unittest
from pathlib import Path


def _load_regression_module():
    root = Path(__file__).resolve().parent.parent
    script_path = root / "scripts" / "regression_mac_win.py"
    spec = importlib.util.spec_from_file_location("regression_mac_win", script_path)
    if spec is None or spec.loader is None:
        raise RuntimeError("failed to load regression_mac_win.py")
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


class RegressionReportTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.mod = _load_regression_module()

    def test_aggregate_runs_computes_pass_rate(self) -> None:
        runs = [
            {
                "ok": True,
                "started_at": "2026-03-01T00:00:01+00:00",
                "finished_at": "2026-03-01T00:00:05+00:00",
                "results": [
                    {"name": "echo", "ok": True, "status": "succeeded", "duration_sec": 0.2},
                    {"name": "latex", "ok": True, "status": "succeeded", "duration_sec": 3.2},
                ],
            },
            {
                "ok": False,
                "started_at": "2026-03-01T00:00:06+00:00",
                "finished_at": "2026-03-01T00:00:09+00:00",
                "results": [
                    {"name": "echo", "ok": False, "status": "failed", "duration_sec": 0.4},
                    {"name": "latex", "ok": True, "status": "skipped", "duration_sec": 0.0},
                ],
            },
        ]
        report = self.mod._aggregate_runs(
            runs=runs,
            nats_url="nats://127.0.0.1:4222",
            node_id="node-a",
            client_id="test-client",
            pass_rate_threshold=0.5,
        )
        self.assertTrue(report["ok"])
        self.assertEqual(report["mode"], "repeated")
        self.assertEqual(report["repeat"], 2)
        summary = report["summary"]
        self.assertEqual(summary["run_ok"], 1)
        self.assertEqual(summary["run_failed"], 1)
        self.assertEqual(summary["run_pass_rate"], 0.5)
        echo = summary["scenario"]["echo"]
        self.assertEqual(echo["ok"], 1)
        self.assertEqual(echo["failed"], 1)
        self.assertEqual(echo["skipped"], 0)
        self.assertEqual(echo["pass_rate"], 0.5)
        latex = summary["scenario"]["latex"]
        self.assertEqual(latex["ok"], 1)
        self.assertEqual(latex["failed"], 0)
        self.assertEqual(latex["skipped"], 1)
        self.assertEqual(latex["pass_rate"], 1.0)

    def test_aggregate_respects_threshold(self) -> None:
        runs = [
            {
                "ok": True,
                "started_at": "2026-03-01T00:00:01+00:00",
                "finished_at": "2026-03-01T00:00:02+00:00",
                "results": [{"name": "echo", "ok": True, "status": "succeeded", "duration_sec": 0.1}],
            },
            {
                "ok": False,
                "started_at": "2026-03-01T00:00:03+00:00",
                "finished_at": "2026-03-01T00:00:04+00:00",
                "results": [{"name": "echo", "ok": False, "status": "failed", "duration_sec": 0.2}],
            },
        ]
        report = self.mod._aggregate_runs(
            runs=runs,
            nats_url="nats://127.0.0.1:4222",
            node_id="node-a",
            client_id="test-client",
            pass_rate_threshold=0.8,
        )
        self.assertFalse(report["ok"])
        self.assertEqual(report["summary"]["run_pass_rate"], 0.5)


if __name__ == "__main__":
    unittest.main()
