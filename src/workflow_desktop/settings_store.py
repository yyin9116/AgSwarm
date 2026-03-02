from __future__ import annotations

import json
from pathlib import Path
from typing import Any


def load_settings(settings_path: str) -> dict[str, Any]:
    path = Path(settings_path)
    if not path.exists():
        return {}
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        return {}
    if not isinstance(payload, dict):
        return {}
    return payload


def save_settings(settings_path: str, payload: dict[str, Any]) -> None:
    path = Path(settings_path)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
