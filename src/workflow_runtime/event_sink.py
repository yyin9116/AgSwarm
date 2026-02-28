from __future__ import annotations

from abc import ABC, abstractmethod


class EventSink(ABC):
    @abstractmethod
    async def emit(self, event_type: str, payload: dict) -> None:
        raise NotImplementedError
