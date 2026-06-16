from __future__ import annotations

import asyncio
import unittest

from workflow_node_daemon.daemon import WorkflowNodeDaemon
from workflow_runtime.adapters.base import Adapter
from workflow_runtime.event_sink import EventSink
from workflow_runtime.protocol import AdapterConfig, TaskEnvelope
from workflow_runtime.runtime import Runtime


class _EchoAdapter(Adapter):
    name = "echo"

    async def run(self, task: TaskEnvelope, sink: EventSink) -> None:
        await sink.emit("adapter.completed", {"output": task.input_text})


class _MockMcpAdapter(Adapter):
    name = "latex_mcp"

    def capability_summary(self) -> dict[str, object]:
        return {
            "name": self.name,
            "kind": "mcp",
            "service": "latex_mcp",
            "transport": "stdio",
            "tools": ["latex_env_check", "compile_and_preview"],
        }

    async def run(self, task: TaskEnvelope, sink: EventSink) -> None:
        await sink.emit("adapter.completed", {"output": task.input_text})


class NodeSnapshotCapabilityTests(unittest.TestCase):
    def test_runtime_extracts_mcp_services(self) -> None:
        runtime = Runtime(adapters=[_EchoAdapter(), _MockMcpAdapter()])
        services = runtime.mcp_services()
        self.assertEqual(len(services), 1)
        self.assertEqual(services[0]["service"], "latex_mcp")
        self.assertIn("compile_and_preview", services[0]["tools"])

    def test_node_snapshot_contains_capability_summary(self) -> None:
        runtime = Runtime(adapters=[_EchoAdapter(), _MockMcpAdapter()])
        daemon = WorkflowNodeDaemon(runtime, max_concurrency=1, default_retries=0)
        snapshot = daemon.get_node_snapshot()
        self.assertEqual(snapshot.can_accept_tasks, False)
        self.assertGreaterEqual(len(snapshot.capability_summary), 2)
        self.assertEqual(len(snapshot.mcp_services), 1)
        self.assertEqual(snapshot.mcp_services[0]["service"], "latex_mcp")

    def test_node_snapshot_contains_recent_task_summaries(self) -> None:
        asyncio.run(self._assert_node_snapshot_contains_recent_task_summaries())

    async def _assert_node_snapshot_contains_recent_task_summaries(self) -> None:
        runtime = Runtime(adapters=[_EchoAdapter()])
        daemon = WorkflowNodeDaemon(runtime, max_concurrency=1, default_retries=0)
        await daemon.start()
        try:
            await daemon.submit(
                TaskEnvelope(
                    adapter=AdapterConfig(name="echo"),
                    input_text="hello peer",
                    task_id="task-1",
                )
            )
            await daemon.wait_for_task("task-1", timeout=1)
            snapshot = daemon.get_node_snapshot()
        finally:
            await daemon.stop()

        self.assertEqual(len(snapshot.recent_tasks), 1)
        self.assertEqual(snapshot.recent_tasks[0]["task_id"], "task-1")
        self.assertEqual(snapshot.recent_tasks[0]["adapter"], "echo")
        self.assertEqual(snapshot.recent_tasks[0]["input_text"], "hello peer")
        self.assertEqual(snapshot.recent_tasks[0]["status"], "succeeded")


if __name__ == "__main__":
    unittest.main()
