from __future__ import annotations

from dataclasses import asdict, dataclass, field
from datetime import datetime, timezone
from typing import Any
from uuid import uuid4


def utc_now_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


@dataclass(slots=True)
class AdapterConfig:
    name: str
    model: str | None = None
    options: dict[str, Any] = field(default_factory=dict)


@dataclass(slots=True)
class TaskEnvelope:
    adapter: AdapterConfig
    input_text: str
    task_id: str = field(default_factory=lambda: str(uuid4()))
    version: str = "1.0"
    created_at: str = field(default_factory=utc_now_iso)
    controls: dict[str, Any] = field(
        default_factory=lambda: {"stream": True, "timeout_ms": 120000, "max_steps": 24}
    )
    context: dict[str, Any] = field(default_factory=dict)
    metadata: dict[str, Any] = field(default_factory=dict)

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


@dataclass(slots=True)
class Event:
    type: str
    task_id: str
    sequence: int
    payload: dict[str, Any]
    version: str = "1.0"
    event_id: str = field(default_factory=lambda: str(uuid4()))
    ts: str = field(default_factory=utc_now_iso)

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)
