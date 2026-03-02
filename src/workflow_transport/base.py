from __future__ import annotations

from abc import ABC, abstractmethod
from collections.abc import Awaitable, Callable
from typing import Any

MessageHandler = Callable[[str, dict[str, Any], str | None], Awaitable[None]]


class Subscription(ABC):
    @abstractmethod
    async def unsubscribe(self) -> None:
        raise NotImplementedError


class TransportProvider(ABC):
    @abstractmethod
    async def connect(self) -> None:
        raise NotImplementedError

    @abstractmethod
    async def close(self) -> None:
        raise NotImplementedError

    @abstractmethod
    async def publish(self, subject: str, payload: dict[str, Any]) -> None:
        raise NotImplementedError

    @abstractmethod
    async def subscribe(self, subject: str, handler: MessageHandler) -> Subscription:
        raise NotImplementedError

    @abstractmethod
    async def request(
        self,
        subject: str,
        payload: dict[str, Any],
        timeout_sec: float = 2.0,
    ) -> dict[str, Any]:
        raise NotImplementedError
