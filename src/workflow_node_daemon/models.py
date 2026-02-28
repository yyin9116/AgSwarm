from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime, timezone
from enum import Enum

from workflow_runtime.protocol import Event, TaskEnvelope


def utc_now_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


class TaskStatus(str, Enum):
    PENDING = "pending"
    RUNNING = "running"
    RETRYING = "retrying"
    SUCCEEDED = "succeeded"
    FAILED = "failed"
    CANCELED = "canceled"


TERMINAL_STATUSES = {
    TaskStatus.SUCCEEDED,
    TaskStatus.FAILED,
    TaskStatus.CANCELED,
}


@dataclass(slots=True)
class TaskRecord:
    envelope: TaskEnvelope
    max_retries: int
    status: TaskStatus = TaskStatus.PENDING
    attempts: int = 0
    cancel_requested: bool = False
    error: str | None = None
    created_at: str = field(default_factory=utc_now_iso)
    started_at: str | None = None
    finished_at: str | None = None
    events: list[Event] = field(default_factory=list)

    @property
    def task_id(self) -> str:
        return self.envelope.task_id

    def is_terminal(self) -> bool:
        return self.status in TERMINAL_STATUSES


@dataclass(slots=True)
class TaskSnapshot:
    task_id: str
    status: str
    attempts: int
    max_retries: int
    created_at: str
    started_at: str | None
    finished_at: str | None
    error: str | None
    cancel_requested: bool
