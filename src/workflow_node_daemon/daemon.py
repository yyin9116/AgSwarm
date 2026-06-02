from __future__ import annotations

import asyncio
import logging
from typing import Any

from workflow_node_daemon.models import (
    NodeSnapshot,
    TaskRecord,
    TaskSnapshot,
    TaskStatus,
    utc_now_iso,
)
from workflow_node_daemon.openclaw import OpenClawNodeConfig
from workflow_runtime.protocol import Event, TaskEnvelope
from workflow_runtime.runtime import InMemoryEventSink, Runtime

logger = logging.getLogger(__name__)


class WorkflowNodeDaemon:
    def __init__(
        self,
        runtime: Runtime,
        *,
        max_concurrency: int = 1,
        default_retries: int = 0,
        openclaw_config: OpenClawNodeConfig | None = None,
    ) -> None:
        if max_concurrency < 1:
            raise ValueError("max_concurrency must be >= 1")
        if default_retries < 0:
            raise ValueError("default_retries must be >= 0")

        self.runtime = runtime
        self.max_concurrency = max_concurrency
        self.default_retries = default_retries
        self.openclaw_config = openclaw_config or OpenClawNodeConfig()
        self.records: dict[str, TaskRecord] = {}
        self._queue: asyncio.Queue[str | None] = asyncio.Queue()
        self._workers: list[asyncio.Task[None]] = []
        self._running = False
        self._active_runs: dict[str, asyncio.Task[None]] = {}

    async def start(self) -> None:
        if self._running:
            return
        self._running = True
        logger.info("daemon start max_concurrency=%d default_retries=%d", self.max_concurrency, self.default_retries)
        for i in range(self.max_concurrency):
            worker = asyncio.create_task(self._worker_loop(i), name=f"daemon-worker-{i}")
            self._workers.append(worker)

    async def stop(self) -> None:
        if not self._running:
            return

        self._running = False
        logger.info("daemon stop workers=%d", len(self._workers))
        for _ in self._workers:
            await self._queue.put(None)

        await asyncio.gather(*self._workers, return_exceptions=True)
        self._workers.clear()

    async def submit(self, envelope: TaskEnvelope, *, max_retries: int | None = None) -> str:
        retries = self.default_retries if max_retries is None else max_retries
        if retries < 0:
            raise ValueError("max_retries must be >= 0")

        record = TaskRecord(envelope=envelope, max_retries=retries)
        self.records[record.task_id] = record
        await self._queue.put(record.task_id)
        logger.info(
            "task submitted task_id=%s adapter=%s retries=%d queue=%d",
            record.task_id,
            record.envelope.adapter.name,
            retries,
            self._queue.qsize(),
        )
        return record.task_id

    def cancel(self, task_id: str) -> bool:
        record = self.records.get(task_id)
        if record is None or record.is_terminal():
            return False

        record.cancel_requested = True
        running_task = self._active_runs.get(task_id)
        if running_task is not None and not running_task.done():
            running_task.cancel()
        return True

    async def wait_for_task(self, task_id: str, timeout: float | None = None) -> TaskSnapshot:
        async def _wait() -> TaskSnapshot:
            while True:
                snapshot = self.get_snapshot(task_id)
                if snapshot is None:
                    raise KeyError(f"Unknown task_id: {task_id}")
                if snapshot.status in {
                    TaskStatus.SUCCEEDED.value,
                    TaskStatus.FAILED.value,
                    TaskStatus.CANCELED.value,
                }:
                    return snapshot
                await asyncio.sleep(0.05)

        if timeout is None:
            return await _wait()
        return await asyncio.wait_for(_wait(), timeout=timeout)

    def get_snapshot(self, task_id: str) -> TaskSnapshot | None:
        record = self.records.get(task_id)
        if record is None:
            return None
        return self._snapshot(record)

    def list_snapshots(self) -> list[TaskSnapshot]:
        return [self._snapshot(record) for record in self.records.values()]

    def get_node_snapshot(self) -> NodeSnapshot:
        skill_info = self.runtime.skill_catalog_info()
        adapters = self.runtime.adapter_names()
        skills_loaded = bool(skill_info.get("loaded", False))
        skills_source = skill_info.get("source_path")
        if not isinstance(skills_source, str):
            skills_source = None
        skill_ids = [str(x) for x in skill_info.get("skill_ids", [])] if isinstance(skill_info.get("skill_ids"), list) else []
        capability_summary = self.runtime.capability_summary()
        mcp_services = self.runtime.mcp_services()
        return NodeSnapshot(
            status=self._node_status(),
            max_concurrency=self.max_concurrency,
            active_tasks=len(self._active_runs),
            queued_tasks=self._queue.qsize(),
            total_tasks=len(self.records),
            can_accept_tasks=self._running,
            agent_ready=(self._running and len(adapters) > 0),
            adapters=adapters,
            skills_loaded=skills_loaded,
            skills_source_path=skills_source,
            skills_count=int(skill_info.get("skill_count", 0) or 0),
            skill_ids=skill_ids,
            capability_summary=capability_summary,
            mcp_services=mcp_services,
            openclaw_node=self.openclaw_config.describe(adapters=adapters),
        )

    def get_task_events(self, task_id: str) -> list[dict]:
        record = self.records.get(task_id)
        if record is None:
            raise KeyError(f"Unknown task_id: {task_id}")
        return [event.to_dict() for event in record.events]

    async def _worker_loop(self, _: int) -> None:
        while True:
            task_id = await self._queue.get()
            if task_id is None:
                self._queue.task_done()
                return

            record = self.records.get(task_id)
            if record is None:
                self._queue.task_done()
                continue

            run_task = asyncio.create_task(self._execute(record))
            self._active_runs[task_id] = run_task
            try:
                await run_task
            finally:
                self._active_runs.pop(task_id, None)
                self._queue.task_done()

    async def _execute(self, record: TaskRecord) -> None:
        if record.cancel_requested:
            self._mark_canceled(record, reason="canceled_before_start")
            return

        while True:
            if record.cancel_requested:
                self._mark_canceled(record, reason="canceled_before_attempt")
                return

            record.attempts += 1
            record.status = TaskStatus.RUNNING
            if record.started_at is None:
                record.started_at = utc_now_iso()

            start_seq = record.events[-1].sequence if record.events else 0
            sink = InMemoryEventSink(task_id=record.task_id, start_sequence=start_seq)

            timeout_ms = int(record.envelope.controls.get("timeout_ms", 120000))
            timeout_sec = timeout_ms / 1000.0
            logger.info(
                "task run task_id=%s attempt=%d/%d adapter=%s timeout_ms=%d",
                record.task_id,
                record.attempts,
                record.max_retries + 1,
                record.envelope.adapter.name,
                timeout_ms,
            )

            try:
                await asyncio.wait_for(self.runtime.run(record.envelope, sink), timeout=timeout_sec)
            except asyncio.TimeoutError:
                logger.warning("task timeout task_id=%s attempt=%d timeout_ms=%d", record.task_id, record.attempts, timeout_ms)
                await sink.emit(
                    "adapter.error",
                    {
                        "code": "runtime_timeout",
                        "message": f"Task timed out after {timeout_ms}ms",
                    },
                )
            except asyncio.CancelledError:
                logger.warning("task canceled task_id=%s attempt=%d", record.task_id, record.attempts)
                await sink.emit(
                    "adapter.error",
                    {
                        "code": "task_canceled",
                        "message": "Task canceled by user",
                    },
                )
                record.events.extend(sink.events)
                self._mark_canceled(record, reason="canceled_during_run")
                return
            except Exception as exc:  # pragma: no cover
                logger.exception("task runtime exception task_id=%s attempt=%d", record.task_id, record.attempts)
                await sink.emit(
                    "adapter.error",
                    {
                        "code": "runtime_exception",
                        "message": str(exc),
                    },
                )

            record.events.extend(sink.events)
            run_outcome = self._detect_run_outcome(sink.events)

            if record.cancel_requested:
                self._mark_canceled(record, reason="canceled_after_run")
                return
            if run_outcome == "succeeded":
                self._mark_succeeded(record)
                return
            if record.attempts > record.max_retries:
                code, message = self._latest_adapter_error(record.events)
                logger.error(
                    "task failed terminal task_id=%s attempts=%d code=%s message=%s",
                    record.task_id,
                    record.attempts,
                    code,
                    message,
                )
                self._append_user_message_event(
                    record,
                    message=message or "Task failed after retries were exhausted.",
                    level="error",
                    code=code,
                )
                self._mark_failed(record, reason="retry_exhausted")
                return

            code, message = self._latest_adapter_error(record.events)
            logger.warning(
                "task retry task_id=%s attempt=%d/%d code=%s message=%s",
                record.task_id,
                record.attempts,
                record.max_retries + 1,
                code,
                message,
            )
            self._append_user_message_event(
                record,
                message=message or "Task failed and will retry.",
                level="warning",
                code=code,
            )
            record.status = TaskStatus.RETRYING

    def _detect_run_outcome(self, events: list[Event]) -> str:
        for event in reversed(events):
            if event.type == "adapter.completed":
                return "succeeded"
            if event.type == "adapter.error":
                return "failed"
        return "failed"

    def _mark_succeeded(self, record: TaskRecord) -> None:
        logger.info("task succeeded task_id=%s attempts=%d", record.task_id, record.attempts)
        self._append_user_message_event(
            record,
            message="Task completed successfully.",
            level="info",
            code=None,
        )
        record.status = TaskStatus.SUCCEEDED
        record.error = None
        record.finished_at = utc_now_iso()

    def _mark_failed(self, record: TaskRecord, *, reason: str) -> None:
        logger.error("task marked failed task_id=%s reason=%s", record.task_id, reason)
        record.status = TaskStatus.FAILED
        record.error = reason
        record.finished_at = utc_now_iso()

    def _mark_canceled(self, record: TaskRecord, *, reason: str) -> None:
        logger.warning("task marked canceled task_id=%s reason=%s", record.task_id, reason)
        self._append_user_message_event(
            record,
            message="Task was canceled.",
            level="warning",
            code=reason,
        )
        record.status = TaskStatus.CANCELED
        record.error = reason
        record.finished_at = utc_now_iso()

    def _node_status(self) -> str:
        if not self._running:
            return "stopped"
        if len(self._active_runs) == 0 and self._queue.qsize() == 0:
            return "idle"
        return "busy"

    def _extract_progress_fields(
        self,
        events: list[Event],
        status: TaskStatus,
    ) -> tuple[int | None, str | None, str | None, str | None, str | None]:
        progress: int | None = None
        current_step: str | None = None
        last_error_code: str | None = None
        last_error_message: str | None = None
        user_message: str | None = None
        for event in events:
            payload: dict[str, Any] = event.payload
            if "progress" in payload:
                try:
                    value = int(payload["progress"])
                except (TypeError, ValueError):
                    value = None
                if value is not None:
                    progress = max(0, min(100, value))
            if "step" in payload and isinstance(payload["step"], str):
                current_step = payload["step"]
            if event.type == "adapter.error":
                code = payload.get("code")
                if isinstance(code, str):
                    last_error_code = code
                msg = payload.get("message")
                if isinstance(msg, str):
                    last_error_message = msg
            if event.type == "task.user_message":
                msg = payload.get("message")
                if isinstance(msg, str):
                    user_message = msg

        if status == TaskStatus.SUCCEEDED:
            progress = 100
        elif status == TaskStatus.PENDING and progress is None:
            progress = 0

        return progress, current_step, last_error_code, last_error_message, user_message

    def _snapshot(self, record: TaskRecord) -> TaskSnapshot:
        last_event_type = record.events[-1].type if record.events else None
        progress, current_step, last_error_code, last_error_message, user_message = self._extract_progress_fields(
            record.events,
            record.status,
        )
        return TaskSnapshot(
            task_id=record.task_id,
            status=record.status.value,
            attempts=record.attempts,
            max_retries=record.max_retries,
            created_at=record.created_at,
            started_at=record.started_at,
            finished_at=record.finished_at,
            error=record.error,
            cancel_requested=record.cancel_requested,
            progress=progress,
            current_step=current_step,
            last_event_type=last_event_type,
            last_error_code=last_error_code,
            last_error_message=last_error_message,
            user_message=user_message,
        )

    def _latest_adapter_error(self, events: list[Event]) -> tuple[str | None, str | None]:
        for event in reversed(events):
            if event.type != "adapter.error":
                continue
            payload: dict[str, Any] = event.payload
            code = payload.get("code")
            message = payload.get("message")
            return (
                code if isinstance(code, str) else None,
                message if isinstance(message, str) else None,
            )
        return None, None

    def _append_user_message_event(
        self,
        record: TaskRecord,
        *,
        message: str,
        level: str,
        code: str | None,
    ) -> None:
        sequence = record.events[-1].sequence + 1 if record.events else 1
        payload: dict[str, Any] = {
            "level": level,
            "message": message,
        }
        if code:
            payload["code"] = code
        record.events.append(
            Event(
                type="task.user_message",
                task_id=record.task_id,
                sequence=sequence,
                payload=payload,
            )
        )
