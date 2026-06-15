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
    progress: int | None
    current_step: str | None
    last_event_type: str | None
    last_error_code: str | None
    last_error_message: str | None
    user_message: str | None


@dataclass(slots=True)
class NodeSnapshot:
    status: str
    max_concurrency: int
    active_tasks: int
    queued_tasks: int
    total_tasks: int
    can_accept_tasks: bool
    agent_ready: bool
    adapters: list[str] = field(default_factory=list)
    skills_loaded: bool = False
    skills_source_path: str | None = None
    skills_count: int = 0
    skill_ids: list[str] = field(default_factory=list)
    capability_summary: list[dict[str, object]] = field(default_factory=list)
    mcp_services: list[dict[str, object]] = field(default_factory=list)
    peer_node: dict[str, object] = field(default_factory=dict)
    recent_tasks: list[dict[str, object]] = field(default_factory=list)
