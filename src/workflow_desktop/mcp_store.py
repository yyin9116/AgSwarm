from __future__ import annotations

import json
from pathlib import Path

from workflow_desktop.models import McpServiceConfig


def load_mcp_services(config_path: str) -> list[McpServiceConfig]:
    path = Path(config_path)
    if not path.exists():
        return []
    data = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(data, list):
        return []
    services: list[McpServiceConfig] = []
    for row in data:
        if isinstance(row, dict):
            services.append(McpServiceConfig.from_dict(row))
    return services


def save_mcp_services(config_path: str, services: list[McpServiceConfig]) -> None:
    path = Path(config_path)
    path.parent.mkdir(parents=True, exist_ok=True)
    payload = [item.to_dict() for item in services]
    path.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
