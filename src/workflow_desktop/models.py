from __future__ import annotations

from dataclasses import asdict, dataclass, field
from pathlib import Path
from typing import Any


def default_mcp_config_path() -> str:
    return str(Path.home() / ".workflow-desktop" / "mcp-services.json")


def default_settings_path() -> str:
    return str(Path.home() / ".workflow-desktop" / "settings.json")


@dataclass(slots=True)
class DesktopConfig:
    nats_url: str
    client_id: str
    node_candidates: list[str] = field(default_factory=list)
    poll_interval_sec: float = 2.0
    mcp_config_path: str = field(default_factory=default_mcp_config_path)
    settings_path: str = field(default_factory=default_settings_path)


@dataclass(slots=True)
class McpServiceConfig:
    name: str
    mode: str
    endpoint_or_command: str
    version: str = ""
    enabled: bool = True

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)

    @classmethod
    def from_dict(cls, payload: dict[str, Any]) -> "McpServiceConfig":
        return cls(
            name=str(payload.get("name", "")).strip(),
            mode=str(payload.get("mode", "endpoint")).strip() or "endpoint",
            endpoint_or_command=str(payload.get("endpoint_or_command", "")).strip(),
            version=str(payload.get("version", "")).strip(),
            enabled=bool(payload.get("enabled", True)),
        )
