from __future__ import annotations

import asyncio
import json

from workflow_runtime.adapters import OpenAIAgentsAdapter
from workflow_runtime.protocol import AdapterConfig, TaskEnvelope
from workflow_runtime.runtime import InMemoryEventSink, Runtime


async def main() -> None:
    task = TaskEnvelope(
        adapter=AdapterConfig(
            name="openai_agents",
            model="gpt-4.1-mini",
            options={"instructions": "You are a concise engineering assistant."},
        ),
        input_text="用三条 bullet 总结把 MCP 从 SSE 迁移到 Streamable HTTP 的收益。",
    )

    sink = InMemoryEventSink(task_id=task.task_id)
    runtime = Runtime(adapters=[OpenAIAgentsAdapter()])
    await runtime.run(task, sink)

    for event in sink.events:
        print(json.dumps(event.to_dict(), ensure_ascii=False))


if __name__ == "__main__":
    asyncio.run(main())
