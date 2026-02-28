from __future__ import annotations

import inspect
from typing import Any

from workflow_runtime.adapters.base import Adapter
from workflow_runtime.event_sink import EventSink
from workflow_runtime.protocol import TaskEnvelope


async def maybe_await(value: Any) -> Any:
    if inspect.isawaitable(value):
        return await value
    return value


class OpenAIAgentsAdapter(Adapter):
    name = "openai_agents"

    def __init__(self, default_model: str = "gpt-4.1-mini") -> None:
        self.default_model = default_model

    async def run(self, task: TaskEnvelope, sink: EventSink) -> None:
        await sink.emit(
            "adapter.started",
            {
                "adapter": self.name,
                "model": task.adapter.model or self.default_model,
            },
        )

        try:
            from agents import Agent, Runner
        except ImportError as exc:
            await sink.emit(
                "adapter.error",
                {
                    "code": "missing_dependency",
                    "message": "openai-agents is not installed",
                    "detail": str(exc),
                },
            )
            return

        model = task.adapter.model or self.default_model
        instructions = task.adapter.options.get("instructions", "You are a helpful assistant.")
        agent = Agent(name="WorkflowAgent", instructions=instructions, model=model)

        try:
            result = await maybe_await(Runner.run(agent, task.input_text))
        except Exception as exc:  # pragma: no cover
            await sink.emit(
                "adapter.error",
                {
                    "code": "adapter_run_failed",
                    "message": str(exc),
                },
            )
            return

        final_output = getattr(result, "final_output", result)
        output_text = str(final_output).strip()

        if output_text:
            await sink.emit("adapter.token", {"text": output_text})

        await sink.emit("adapter.completed", {"output": output_text})
