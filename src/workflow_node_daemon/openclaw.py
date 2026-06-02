from __future__ import annotations

import asyncio
import json
import os
import shlex
from dataclasses import dataclass, field
from typing import Iterable


@dataclass(slots=True)
class OpenClawNodeConfig:
    transport: str = "nats"
    endpoint: str | None = None
    device_id: str | None = None
    device_label: str | None = None
    device_tags: list[str] = field(default_factory=list)
    capabilities: list[str] = field(default_factory=list)
    gateway_command: str | None = None
    gateway_cwd: str | None = None
    gateway_timeout_sec: float = 30.0

    def describe(self, *, adapters: Iterable[str]) -> dict[str, object]:
        capability_list = list(self.capabilities)
        if "task-dispatch" not in capability_list:
            capability_list.append("task-dispatch")
        if "interactive-file-stream" not in capability_list:
            capability_list.append("interactive-file-stream")
        if "pi" in set(adapters) and "pi-agent" not in capability_list:
            capability_list.append("pi-agent")
        if self.gateway_command and "external-openclaw-gateway" not in capability_list:
            capability_list.append("external-openclaw-gateway")

        return {
            "host_layer": "openclaw_node",
            "transport": self.transport,
            "endpoint": self.endpoint,
            "device_id": self.device_id,
            "device_label": self.device_label,
            "device_tags": list(self.device_tags),
            "capabilities": capability_list,
            "gateway_configured": bool(self.gateway_command),
        }


class OpenClawNodeHost:
    def __init__(self, config: OpenClawNodeConfig) -> None:
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
        if normalized in {"describe", "capabilities"}:
            return {
                "ok": True,
                "command": normalized,
                "openclaw_node": self.config.describe(adapters=adapters),
            }
        if normalized == "ping":
            return {
                "ok": True,
                "command": normalized,
                "message": "pong",
                "echo": dict(body),
                "openclaw_node": self.config.describe(adapters=adapters),
            }
        if self.config.gateway_command:
            return await self._run_gateway_command(
                command=command,
                payload=body,
                adapters=adapters,
            )
        return {
            "ok": False,
            "command": command,
            "error": "unsupported_openclaw_command",
            "supported_commands": ["describe", "ping"],
        }

    async def _run_gateway_command(
        self,
        *,
        command: str,
        payload: dict[str, object],
        adapters: Iterable[str],
    ) -> dict[str, object]:
        request = {
            "command": command,
            "payload": payload,
            "openclaw_node": self.config.describe(adapters=adapters),
        }
        try:
            argv = shlex.split(self.config.gateway_command or "")
        except ValueError as exc:
            return {
                "ok": False,
                "command": command,
                "error": "invalid_openclaw_gateway_command",
                "message": str(exc),
            }
        if not argv:
            return {
                "ok": False,
                "command": command,
                "error": "missing_openclaw_gateway_command",
            }

        env = {
            **os.environ,
            "WORKFLOW_OPENCLAW_COMMAND": command,
            "WORKFLOW_OPENCLAW_DEVICE_ID": self.config.device_id or "",
        }
        try:
            proc = await asyncio.create_subprocess_exec(
                *argv,
                stdin=asyncio.subprocess.PIPE,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
                cwd=self.config.gateway_cwd,
                env=env,
            )
            raw_request = json.dumps(request, ensure_ascii=False).encode("utf-8")
            stdout, stderr = await asyncio.wait_for(
                proc.communicate(raw_request),
                timeout=self.config.gateway_timeout_sec,
            )
        except asyncio.TimeoutError:
            return {
                "ok": False,
                "command": command,
                "error": "openclaw_gateway_timeout",
                "timeout_sec": self.config.gateway_timeout_sec,
            }
        except Exception as exc:
            return {
                "ok": False,
                "command": command,
                "error": "openclaw_gateway_failed",
                "message": str(exc),
            }

        stderr_text = stderr.decode("utf-8", errors="replace") if stderr else ""
        stdout_text = stdout.decode("utf-8", errors="replace").strip() if stdout else ""
        if proc.returncode != 0:
            return {
                "ok": False,
                "command": command,
                "error": "openclaw_gateway_exit_error",
                "returncode": proc.returncode,
                "stderr": stderr_text[:2000],
            }
        if not stdout_text:
            return {
                "ok": True,
                "command": command,
                "gateway": "completed",
                "stderr": stderr_text[:2000],
            }
        try:
            response = json.loads(stdout_text)
        except json.JSONDecodeError:
            return {
                "ok": False,
                "command": command,
                "error": "openclaw_gateway_invalid_json",
                "stdout": stdout_text[:2000],
                "stderr": stderr_text[:2000],
            }
        if not isinstance(response, dict):
            return {
                "ok": False,
                "command": command,
                "error": "openclaw_gateway_invalid_response",
                "stdout": stdout_text[:2000],
            }
        response.setdefault("ok", True)
        response.setdefault("command", command)
        if stderr_text:
            response.setdefault("stderr", stderr_text[:2000])
        return response
