from __future__ import annotations

from workflow_runtime.adapters.base import Adapter
from workflow_runtime.async_utils import maybe_await
from workflow_runtime.event_sink import EventSink
from workflow_runtime.protocol import TaskEnvelope


def extract_output(result: object) -> str:
    for attr in ("output", "data", "final_output"):
        value = getattr(result, attr, None)
        if value is not None:
            return str(value).strip()
    return str(result).strip()


class PydanticAIAdapter(Adapter):
    name = "pydantic_ai"

    def __init__(self, default_model: str = "openai:gpt-4.1-mini") -> None:
        self.default_model = default_model

    async def run(self, task: TaskEnvelope, sink: EventSink) -> None:
        model = task.adapter.model or self.default_model
        instructions = task.adapter.options.get("instructions", "You are a helpful assistant.")

        await sink.emit(
            "adapter.started",
            {
                "adapter": self.name,
                "model": model,
            },
        )

        try:
            from pydantic_ai import Agent
        except ImportError as exc:
            await sink.emit(
                "adapter.error",
                {
                    "code": "missing_dependency",
                    "message": "pydantic-ai is not installed",
                    "detail": str(exc),
                },
            )
            return

        agent = Agent(model, system_prompt=instructions)

        try:
            result = await maybe_await(agent.run(task.input_text))
        except Exception as exc:  # pragma: no cover
            await sink.emit(
                "adapter.error",
                {
                    "code": "adapter_run_failed",
                    "message": str(exc),
                },
            )
            return

        output_text = extract_output(result)

        if output_text:
            await sink.emit("adapter.token", {"text": output_text})

        await sink.emit("adapter.completed", {"output": output_text})
