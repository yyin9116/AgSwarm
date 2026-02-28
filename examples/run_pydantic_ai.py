from __future__ import annotations

import asyncio
import json

from workflow_runtime.adapters import PydanticAIAdapter
from workflow_runtime.protocol import AdapterConfig, TaskEnvelope
from workflow_runtime.runtime import InMemoryEventSink, Runtime


async def main() -> None:
    task = TaskEnvelope(
        adapter=AdapterConfig(
            name="pydantic_ai",
            model="openai:gpt-4.1-mini",
            options={"instructions": "You are a concise engineering assistant."},
        ),
        input_text="给出两条将 Agent Runtime 设计成薄层的核心收益。",
    )

    sink = InMemoryEventSink(task_id=task.task_id)
    runtime = Runtime(adapters=[PydanticAIAdapter()])
    await runtime.run(task, sink)

    for event in sink.events:
        print(json.dumps(event.to_dict(), ensure_ascii=False))


if __name__ == "__main__":
    asyncio.run(main())
