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

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> "AdapterConfig":
        return cls(
            name=str(data["name"]),
            model=data.get("model"),
            options=dict(data.get("options", {})),
        )


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

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> "TaskEnvelope":
        return cls(
            adapter=AdapterConfig.from_dict(dict(data["adapter"])),
            input_text=str(data["input_text"]),
            task_id=str(data.get("task_id", str(uuid4()))),
            version=str(data.get("version", "1.0")),
            created_at=str(data.get("created_at", utc_now_iso())),
            controls=dict(data.get("controls", {})),
            context=dict(data.get("context", {})),
            metadata=dict(data.get("metadata", {})),
        )


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

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> "Event":
        return cls(
            type=str(data["type"]),
            task_id=str(data["task_id"]),
            sequence=int(data["sequence"]),
            payload=dict(data.get("payload", {})),
            version=str(data.get("version", "1.0")),
            event_id=str(data.get("event_id", str(uuid4()))),
            ts=str(data.get("ts", utc_now_iso())),
        )
