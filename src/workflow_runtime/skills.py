from __future__ import annotations

import json
import logging
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from workflow_runtime.protocol import TaskEnvelope

logger = logging.getLogger(__name__)


def _deep_merge_dict(base: dict[str, Any], patch: dict[str, Any]) -> dict[str, Any]:
    merged = dict(base)
    for key, value in patch.items():
        if key in merged and isinstance(merged[key], dict) and isinstance(value, dict):
            merged[key] = _deep_merge_dict(dict(merged[key]), value)
        else:
            merged[key] = value
    return merged


@dataclass(slots=True)
class SkillSpec:
    skill_id: str
    name: str
    description: str
    instructions: str = ""
    enabled: bool = True
    default: bool = False
    tags: list[str] = field(default_factory=list)
    auto_when_any_keywords: list[str] = field(default_factory=list)
    adapter_overrides: dict[str, dict[str, Any]] = field(default_factory=dict)
    metadata: dict[str, Any] = field(default_factory=dict)

    @classmethod
    def from_dict(cls, payload: dict[str, Any]) -> "SkillSpec":
        return cls(
            skill_id=str(payload.get("id", "")).strip(),
            name=str(payload.get("name", "")).strip(),
            description=str(payload.get("description", "")).strip(),
            instructions=str(payload.get("instructions", "")),
            enabled=bool(payload.get("enabled", True)),
            default=bool(payload.get("default", False)),
            tags=[str(x).strip() for x in payload.get("tags", []) if str(x).strip()],
            auto_when_any_keywords=[
                str(x).strip().lower()
                for x in payload.get("auto_when_any_keywords", [])
                if str(x).strip()
            ],
            adapter_overrides={
                str(k): dict(v) for k, v in dict(payload.get("adapter_overrides", {})).items() if isinstance(v, dict)
            },
            metadata=dict(payload.get("metadata", {})),
        )


class SkillCatalog:
    def __init__(self, skills: list[SkillSpec], *, source_path: str) -> None:
        self.skills = skills
        self.source_path = source_path
        self._by_id = {skill.skill_id: skill for skill in skills if skill.skill_id}

    @classmethod
    def from_json_path(cls, path: str) -> "SkillCatalog":
        payload = json.loads(Path(path).read_text(encoding="utf-8"))
        rows = payload.get("skills", []) if isinstance(payload, dict) else []
        skills = [SkillSpec.from_dict(item) for item in rows if isinstance(item, dict)]
        return cls(skills=skills, source_path=path)

    def _normalize_requested_ids(self, task: TaskEnvelope) -> list[str]:
        requested: list[str] = []
        for container in (task.metadata, task.context):
            raw = container.get("skills")
            if isinstance(raw, str):
                requested.extend([x.strip() for x in raw.split(",") if x.strip()])
            elif isinstance(raw, list):
                requested.extend([str(x).strip() for x in raw if str(x).strip()])
        unique: list[str] = []
        seen = set()
        for skill_id in requested:
            if skill_id in seen:
                continue
            seen.add(skill_id)
            unique.append(skill_id)
        return unique

    def resolve(self, task: TaskEnvelope) -> list[SkillSpec]:
        selected: list[SkillSpec] = []
        selected_ids = set()

        for skill in self.skills:
            if skill.enabled and skill.default and skill.skill_id not in selected_ids:
                selected.append(skill)
                selected_ids.add(skill.skill_id)

        for skill_id in self._normalize_requested_ids(task):
            skill = self._by_id.get(skill_id)
            if skill is None:
                logger.warning("requested skill not found: %s", skill_id)
                continue
            if not skill.enabled:
                logger.warning("requested skill disabled: %s", skill_id)
                continue
            if skill.skill_id not in selected_ids:
                selected.append(skill)
                selected_ids.add(skill.skill_id)

        text = f"{task.input_text}\n{task.adapter.options.get('instructions', '')}".lower()
        for skill in self.skills:
            if not skill.enabled or not skill.auto_when_any_keywords:
                continue
            if skill.skill_id in selected_ids:
                continue
            if any(keyword in text for keyword in skill.auto_when_any_keywords):
                selected.append(skill)
                selected_ids.add(skill.skill_id)
        return selected

    def apply_to_task(self, task: TaskEnvelope) -> list[SkillSpec]:
        selected = self.resolve(task)
        if not selected:
            return []

        skill_instructions = []
        for skill in selected:
            if skill.instructions.strip():
                skill_instructions.append(f"[{skill.skill_id}] {skill.instructions.strip()}")
        if skill_instructions:
            current_instructions = str(task.adapter.options.get("instructions", "")).strip()
            merged = "\n\n".join(skill_instructions)
            if current_instructions:
                merged = current_instructions + "\n\n" + merged
            task.adapter.options["instructions"] = merged

        adapter_name = task.adapter.name
        for skill in selected:
            override = skill.adapter_overrides.get(adapter_name)
            if not isinstance(override, dict):
                continue
            if "model" in override:
                task.adapter.model = str(override["model"])
            options_patch = override.get("options")
            if isinstance(options_patch, dict):
                task.adapter.options = _deep_merge_dict(task.adapter.options, options_patch)

        applied_ids = [skill.skill_id for skill in selected]
        task.metadata["applied_skills"] = applied_ids
        task.metadata["skills_source"] = self.source_path
        return selected


def try_load_skill_catalog(path: str | None) -> SkillCatalog | None:
    if not path:
        return None
    skill_path = Path(path)
    if not skill_path.exists():
        return None
    try:
        catalog = SkillCatalog.from_json_path(str(skill_path))
    except Exception as exc:  # pragma: no cover
        logger.exception("failed to load skill catalog path=%s error=%s", skill_path, exc)
        return None
    logger.info("skill catalog loaded path=%s skills=%d", skill_path, len(catalog.skills))
    return catalog
