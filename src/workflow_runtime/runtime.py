from __future__ import annotations

import logging
import os
from collections.abc import Iterable

from workflow_runtime.adapters.base import Adapter
from workflow_runtime.event_sink import EventSink
from workflow_runtime.protocol import Event, TaskEnvelope
from workflow_runtime.skills import SkillCatalog, try_load_skill_catalog

logger = logging.getLogger(__name__)


class InMemoryEventSink(EventSink):
    def __init__(self, task_id: str, *, start_sequence: int = 0) -> None:
        self.task_id = task_id
        self.sequence = start_sequence
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
    def __init__(
        self,
        adapters: Iterable[Adapter],
        *,
        skill_catalog: SkillCatalog | None = None,
        skill_catalog_path: str | None = None,
    ) -> None:
        self._adapters = {adapter.name: adapter for adapter in adapters}
        resolved_path = skill_catalog_path or os.getenv("WORKFLOW_SKILLS_CONFIG")
        self._skill_catalog = skill_catalog or try_load_skill_catalog(resolved_path)
        if resolved_path and self._skill_catalog is None:
            logger.warning("skill catalog path configured but not loaded: %s", resolved_path)

    def adapter_names(self) -> list[str]:
        return sorted(self._adapters.keys())

    def capability_summary(self) -> list[dict[str, object]]:
        rows: list[dict[str, object]] = []
        for name in self.adapter_names():
            adapter = self._adapters[name]
            provider = getattr(adapter, "capability_summary", None)
            if callable(provider):
                try:
                    payload = provider()
                except Exception as exc:  # pragma: no cover
                    logger.warning("adapter capability summary failed adapter=%s error=%s", name, exc)
                    payload = {}
                if isinstance(payload, dict):
                    row = dict(payload)
                else:
                    row = {}
            else:
                row = {}
            row.setdefault("name", name)
            row.setdefault("kind", "adapter")
            rows.append(row)
        return rows

    def mcp_services(self) -> list[dict[str, object]]:
        services: list[dict[str, object]] = []
        for row in self.capability_summary():
            if str(row.get("kind", "")).strip().lower() == "mcp":
                services.append(dict(row))
        return services

    def skill_catalog_info(self) -> dict[str, object]:
        if self._skill_catalog is None:
            return {
                "loaded": False,
                "source_path": None,
                "skill_count": 0,
                "skill_ids": [],
            }
        skill_ids = [skill.skill_id for skill in self._skill_catalog.skills if skill.skill_id]
        return {
            "loaded": True,
            "source_path": self._skill_catalog.source_path,
            "skill_count": len(skill_ids),
            "skill_ids": skill_ids,
        }

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

        if self._skill_catalog is not None:
            try:
                selected = self._skill_catalog.apply_to_task(task)
                if selected:
                    await sink.emit(
                        "task.skills.applied",
                        {
                            "skills": [x.skill_id for x in selected],
                            "source": self._skill_catalog.source_path,
                        },
                    )
            except Exception as exc:  # pragma: no cover
                logger.exception("apply skill catalog failed task_id=%s", task.task_id)
                await sink.emit(
                    "task.skills.error",
                    {
                        "code": "skills_apply_failed",
                        "message": str(exc),
                    },
                )

        await sink.emit("task.accepted", {"adapter": task.adapter.name})
        await adapter.run(task, sink)
