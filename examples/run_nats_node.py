from __future__ import annotations

import asyncio
import os

from workflow_node_daemon import NatsDaemonBridge, WorkflowNodeDaemon
from workflow_runtime.adapters import LatexMcpAdapter
from workflow_runtime.adapters.base import Adapter
from workflow_runtime.event_sink import EventSink
from workflow_runtime.protocol import TaskEnvelope
from workflow_runtime.runtime import Runtime
from workflow_transport import NatsTransportProvider


class EchoAdapter(Adapter):
    name = "echo"

    async def run(self, task: TaskEnvelope, sink: EventSink) -> None:
        await sink.emit("adapter.started", {"adapter": self.name})
        await sink.emit("adapter.token", {"text": task.input_text, "progress": 80, "step": "echo"})
        await sink.emit("adapter.completed", {"output": task.input_text, "progress": 100})


async def main() -> None:
    node_id = os.getenv("WORKFLOW_NODE_ID", "node-a")
    nats_url = os.getenv("WORKFLOW_NATS_URL", "nats://127.0.0.1:4222")
    latex_workspace = os.getenv("WORKFLOW_LATEX_WORKSPACE")
    latex_server_cwd = os.getenv("WORKFLOW_LATEX_SERVER_CWD")

    runtime = Runtime(
        adapters=[
            EchoAdapter(),
            LatexMcpAdapter(
                default_workspace=latex_workspace,
                default_server_cwd=latex_server_cwd,
            ),
        ]
    )
    daemon = WorkflowNodeDaemon(runtime, max_concurrency=2, default_retries=1)
    transport = NatsTransportProvider(server_url=nats_url)
    bridge = NatsDaemonBridge(node_id=node_id, daemon=daemon, transport=transport)

    await daemon.start()
    await bridge.start()
    print(f"node started: node_id={node_id}, nats={nats_url}")
    print(f"latex workspace default: {latex_workspace}")
    print(f"latex server cwd default: {latex_server_cwd}")
    print("press Ctrl+C to stop")
    try:
        while True:
            await asyncio.sleep(60)
    finally:
        await bridge.stop()
        await daemon.stop()


if __name__ == "__main__":
    asyncio.run(main())
