from __future__ import annotations

from dataclasses import asdict, dataclass, field
from pathlib import Path
from typing import Any

from workflow_discovery import DISCOVERY_PORT_DEFAULT


def default_mcp_config_path() -> str:
    return str(Path.home() / ".workflow-desktop" / "mcp-services.json")


def default_settings_path() -> str:
    return str(Path.home() / ".workflow-desktop" / "settings.json")


def default_conversation_state_path(client_id: str = "desktop-client") -> str:
    safe_client_id = "".join(ch if ch.isalnum() or ch in {"-", "_"} else "_" for ch in client_id).strip("_")
    return str(Path.home() / ".workflow-desktop" / f"{safe_client_id or 'desktop-client'}-conversations.json")


@dataclass(slots=True)
class DesktopConfig:
    nats_url: str
    client_id: str
    language: str = "en-US"
    display_name: str = ""
    node_candidates: list[str] = field(default_factory=list)
    poll_interval_sec: float = 2.0
    discovery_enabled: bool = True
    discovery_port: int = DISCOVERY_PORT_DEFAULT
    discovery_max_age_sec: float = 8.0
    discovery_auto_switch_nats: bool = True
    config_sync_enabled: bool = True
    config_sync_interval_sec: float = 30.0
    config_sync_conflict_policy: str = "desktop_wins"
    mcp_config_path: str = field(default_factory=default_mcp_config_path)
    settings_path: str = field(default_factory=default_settings_path)
    conversation_state_path: str = ""


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
