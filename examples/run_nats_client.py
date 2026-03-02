from __future__ import annotations

import asyncio
import json
import os

from workflow_control_client import WorkflowControlClient
from workflow_runtime import AdapterConfig, TaskEnvelope
from workflow_transport import NatsTransportProvider


async def main() -> None:
    nats_url = os.getenv("WORKFLOW_NATS_URL", "nats://127.0.0.1:4222")
    target_node = os.getenv("WORKFLOW_TARGET_NODE", "node-a")

    transport = NatsTransportProvider(server_url=nats_url)
    client = WorkflowControlClient(client_id="client-local", transport=transport)
    await client.connect()

    done = asyncio.Event()

    async def on_event(event) -> None:
        print("event:", json.dumps(event.to_dict(), ensure_ascii=False))
        if event.task_id == task.task_id and event.type in {"adapter.completed", "adapter.error"}:
            done.set()

    async def on_status(subject: str, payload: dict) -> None:
        print("status:", subject, json.dumps(payload, ensure_ascii=False))

    await client.subscribe_task_events(node_id=target_node, handler=on_event)
    await client.subscribe_node_status(node_id=target_node, handler=on_status)

    task = TaskEnvelope(
        adapter=AdapterConfig(name="echo"),
        input_text="hello from control client",
    )
    await client.submit_task(target_node_id=target_node, task=task)
    print(f"submitted task_id={task.task_id} to node={target_node}")

    snapshot = await client.request_node_snapshot(node_id=target_node, timeout_sec=3)
    print("snapshot:", json.dumps(snapshot, ensure_ascii=False))

    try:
        await asyncio.wait_for(done.wait(), timeout=20)
    except TimeoutError:
        print("no terminal event received in 20s")
    finally:
        await client.close()


if __name__ == "__main__":
    asyncio.run(main())
