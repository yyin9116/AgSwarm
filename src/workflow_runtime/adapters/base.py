from __future__ import annotations

from abc import ABC, abstractmethod

from workflow_runtime.event_sink import EventSink
from workflow_runtime.protocol import TaskEnvelope


class Adapter(ABC):
    name: str

    @abstractmethod
    async def run(self, task: TaskEnvelope, sink: EventSink) -> None:
        raise NotImplementedError
