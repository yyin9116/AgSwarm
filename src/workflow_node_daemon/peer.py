from __future__ import annotations

from dataclasses import dataclass, field
from typing import Iterable


@dataclass(slots=True)
class PeerNodeConfig:
    transport: str = "nats"
    endpoint: str | None = None
    device_id: str | None = None
    device_label: str | None = None
    device_tags: list[str] = field(default_factory=list)
    capabilities: list[str] = field(default_factory=list)

    def describe(self, *, adapters: Iterable[str]) -> dict[str, object]:
        capability_list = list(dict.fromkeys(self.capabilities))
        for capability in ("task-dispatch", "interactive-file-stream"):
            if capability not in capability_list:
                capability_list.append(capability)
        if "pi" in set(adapters) and "pi-agent" not in capability_list:
            capability_list.append("pi-agent")

        return {
            "host_layer": "agswarm_peer",
            "transport": self.transport,
            "endpoint": self.endpoint,
            "device_id": self.device_id,
            "device_label": self.device_label,
            "device_tags": list(self.device_tags),
            "capabilities": capability_list,
        }


class PeerNodeHost:
    def __init__(self, config: PeerNodeConfig) -> None:
        self.config = config

    async def handle_command(
        self,
        *,
        command: str,
        payload: dict[str, object] | None = None,
        adapters: Iterable[str],
    ) -> dict[str, object]:
        normalized = command.strip().lower()
        body = payload or {}
        peer_node = self.config.describe(adapters=adapters)
        if normalized in {"describe", "capabilities"}:
            return {
                "ok": True,
                "command": normalized,
                "peer_node": peer_node,
            }
        if normalized == "ping":
            return {
                "ok": True,
                "command": normalized,
                "message": "pong",
                "echo": dict(body),
                "peer_node": peer_node,
            }
        return {
            "ok": False,
            "command": command,
            "error": "unsupported_peer_command",
            "supported_commands": ["describe", "ping"],
            "peer_node": peer_node,
        }
