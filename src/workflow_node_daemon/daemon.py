from __future__ import annotations

import asyncio

from workflow_node_daemon.models import TaskRecord, TaskSnapshot, TaskStatus, utc_now_iso
from workflow_runtime.protocol import Event, TaskEnvelope
from workflow_runtime.runtime import InMemoryEventSink, Runtime


class WorkflowNodeDaemon:
    def __init__(
        self,
        runtime: Runtime,
        *,
        max_concurrency: int = 1,
        default_retries: int = 0,
    ) -> None:
        if max_concurrency < 1:
            raise ValueError("max_concurrency must be >= 1")
        if default_retries < 0:
            raise ValueError("default_retries must be >= 0")

        self.runtime = runtime
        self.max_concurrency = max_concurrency
        self.default_retries = default_retries
        self.records: dict[str, TaskRecord] = {}
        self._queue: asyncio.Queue[str | None] = asyncio.Queue()
        self._workers: list[asyncio.Task[None]] = []
        self._running = False
        self._active_runs: dict[str, asyncio.Task[None]] = {}

    async def start(self) -> None:
        if self._running:
            return
        self._running = True
        for i in range(self.max_concurrency):
            worker = asyncio.create_task(self._worker_loop(i), name=f"daemon-worker-{i}")
            self._workers.append(worker)

    async def stop(self) -> None:
        if not self._running:
            return

        self._running = False
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

            sink = InMemoryEventSink(task_id=record.task_id)

            timeout_ms = int(record.envelope.controls.get("timeout_ms", 120000))
            timeout_sec = timeout_ms / 1000.0

            try:
                await asyncio.wait_for(self.runtime.run(record.envelope, sink), timeout=timeout_sec)
            except asyncio.TimeoutError:
                await sink.emit(
                    "adapter.error",
                    {
                        "code": "runtime_timeout",
                        "message": f"Task timed out after {timeout_ms}ms",
                    },
                )
            except asyncio.CancelledError:
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
                self._mark_failed(record, reason="retry_exhausted")
                return

            record.status = TaskStatus.RETRYING

    def _detect_run_outcome(self, events: list[Event]) -> str:
        for event in reversed(events):
            if event.type == "adapter.completed":
                return "succeeded"
            if event.type == "adapter.error":
                return "failed"
        return "failed"

    def _mark_succeeded(self, record: TaskRecord) -> None:
        record.status = TaskStatus.SUCCEEDED
        record.error = None
        record.finished_at = utc_now_iso()

    def _mark_failed(self, record: TaskRecord, *, reason: str) -> None:
        record.status = TaskStatus.FAILED
        record.error = reason
        record.finished_at = utc_now_iso()

    def _mark_canceled(self, record: TaskRecord, *, reason: str) -> None:
        record.status = TaskStatus.CANCELED
        record.error = reason
        record.finished_at = utc_now_iso()

    def _snapshot(self, record: TaskRecord) -> TaskSnapshot:
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
        )
