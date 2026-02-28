from __future__ import annotations

import asyncio
import json
from dataclasses import asdict

from workflow_node_daemon import WorkflowNodeDaemon
from workflow_runtime.adapters.base import Adapter
from workflow_runtime.event_sink import EventSink
from workflow_runtime.protocol import AdapterConfig, TaskEnvelope
from workflow_runtime.runtime import Runtime


class EchoAdapter(Adapter):
    name = "echo"

    async def run(self, task: TaskEnvelope, sink: EventSink) -> None:
        await sink.emit("adapter.started", {"adapter": self.name})
        await sink.emit("adapter.token", {"text": task.input_text})
        await sink.emit("adapter.completed", {"output": task.input_text})


async def main() -> None:
    runtime = Runtime(adapters=[EchoAdapter()])
    daemon = WorkflowNodeDaemon(runtime, max_concurrency=1, default_retries=1)
    await daemon.start()

    task = TaskEnvelope(
        adapter=AdapterConfig(name="echo"),
        input_text="hello workflow daemon",
    )
    task_id = await daemon.submit(task)
    snapshot = await daemon.wait_for_task(task_id, timeout=5)

    print(json.dumps(asdict(snapshot), ensure_ascii=False))
    for event in daemon.get_task_events(task_id):
        print(json.dumps(event, ensure_ascii=False))

    await daemon.stop()


if __name__ == "__main__":
    asyncio.run(main())
