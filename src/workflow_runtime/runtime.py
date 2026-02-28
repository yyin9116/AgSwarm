from __future__ import annotations

from collections.abc import Iterable

from workflow_runtime.adapters.base import Adapter
from workflow_runtime.event_sink import EventSink
from workflow_runtime.protocol import Event, TaskEnvelope


class InMemoryEventSink(EventSink):
    def __init__(self, task_id: str) -> None:
        self.task_id = task_id
        self.sequence = 0
        self.events: list[Event] = []

    async def emit(self, event_type: str, payload: dict) -> None:
        self.sequence += 1
        self.events.append(
            Event(
                type=event_type,
                task_id=self.task_id,
                sequence=self.sequence,
                payload=payload,
            )
        )


class Runtime:
    def __init__(self, adapters: Iterable[Adapter]) -> None:
        self._adapters = {adapter.name: adapter for adapter in adapters}

    async def run(self, task: TaskEnvelope, sink: EventSink) -> None:
        adapter = self._adapters.get(task.adapter.name)
        if adapter is None:
            await sink.emit(
                "adapter.error",
                {
                    "code": "adapter_not_found",
                    "message": f"Unknown adapter: {task.adapter.name}",
                },
            )
            return

        await sink.emit("task.accepted", {"adapter": task.adapter.name})
        await adapter.run(task, sink)
