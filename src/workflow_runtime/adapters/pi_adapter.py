"""PiAdapter: embeds pi coding agent as an AgSwarm adapter via RPC mode.

Architecture
------------
- AgSwarm Runtime (Python) creates a TaskEnvelope and calls PiAdapter.run()
- PiAdapter spawns `pi --mode rpc` as a subprocess
- Communicates via strict JSONL over stdin/stdout
- Maps pi RPC events -> AgSwarm EventSink events
- Returns when pi agent completes (agent_end event)

This adapter does NOT use OpenClaw Node Host directly; it uses pi's native
RPC mode. For OpenClaw Node Host integration, see docs/openclaw-node.md.
"""
from __future__ import annotations

import asyncio
import json
import os
import shlex
import shutil
from pathlib import Path
from typing import Any

from workflow_runtime.adapters.base import Adapter
from workflow_runtime.event_sink import EventSink
from workflow_runtime.protocol import Event, TaskEnvelope


class PiAdapter(Adapter):
    name = "pi"

    def __init__(
        self,
        pi_cli: str | None = None,
        default_model: str | None = None,
        provider: str | None = None,
        cwd: str | None = None,
        env: dict[str, str] | None = None,
    ) -> None:
        """
        Args:
            pi_cli: Path to pi CLI (default: auto-detect from PATH or ~/test/pi)
            default_model: Model pattern, e.g. "anthropic/claude-sonnet-4" or "kimi/k2-6"
            provider: LLM provider name (anthropic, openai, kimi, etc.)
            cwd: Working directory for pi subprocess
            env: Extra env vars for pi subprocess
        """
        self.pi_cli = pi_cli or self._resolve_pi_cli()
        self.default_model = default_model
        self.provider = provider
        self.cwd = cwd or os.getcwd()
        self.env = {**os.environ, **(env or {})}
        self._seq = 0

    @staticmethod
    def _resolve_pi_cli() -> str:
        # 1. PATH
        if shutil.which("pi"):
            return "pi"
        # 2. Local build in ~/test/pi
        local = Path.home() / "test" / "pi" / "packages" / "coding-agent" / "dist" / "cli.js"
        if local.exists():
            return f"node {shlex.quote(str(local))}"
        raise RuntimeError(
            "pi CLI not found. Install pi or set pi_cli=path/to/pi"
        )

    def _next_seq(self) -> int:
        self._seq += 1
        return self._seq

    async def run(self, task: TaskEnvelope, sink: EventSink) -> None:
        await sink.emit(
            "adapter.started",
            {
                "adapter": self.name,
                "model": task.adapter.model or self.default_model,
                "pi_cli": self.pi_cli,
            },
        )

        # Build pi CLI args. shlex preserves quoted paths in WORKFLOW_PI_CLI.
        cmd_parts = shlex.split(self.pi_cli)
        cmd_parts.extend(["--mode", "rpc"])
        if self.provider:
            cmd_parts.extend(["--provider", self.provider])
        if task.adapter.model or self.default_model:
            cmd_parts.extend(["--model", task.adapter.model or self.default_model])
        if task.adapter.options.get("no_session", True):
            cmd_parts.append("--no-session")

        # Merge task context into env (API keys, etc.)
        proc_env = {**self.env}
        for key, value in task.context.items():
            if isinstance(value, str):
                proc_env[key] = value

        try:
            proc = await asyncio.create_subprocess_exec(
                *cmd_parts,
                stdin=asyncio.subprocess.PIPE,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
                cwd=self.cwd,
                env=proc_env,
            )
        except Exception as exc:
            await sink.emit(
                "adapter.error",
                {
                    "code": "spawn_failed",
                    "message": str(exc),
                    "command": " ".join(cmd_parts),
                },
            )
            return

        # Send prompt to pi
        prompt_msg = json.dumps(
            {
                "id": task.task_id,
                "type": "prompt",
                "message": task.input_text,
            },
            ensure_ascii=False,
        )
        assert proc.stdin is not None
        proc.stdin.write(prompt_msg.encode("utf-8") + b"\n")
        await proc.stdin.drain()

        stderr_task = asyncio.create_task(self._collect_stderr(proc.stderr))

        # Read events from stdout
        assert proc.stdout is not None
        completed = False
        try:
            completed = await self._read_events(proc.stdout, sink, task.task_id)
        except Exception as exc:
            await sink.emit(
                "adapter.error",
                {"code": "event_read_failed", "message": str(exc)},
            )

        # Pi RPC is a long-lived JSONL server. Closing stdin after agent_end lets
        # it perform a normal EOF shutdown instead of waiting for another command.
        if completed and proc.stdin and not proc.stdin.is_closing():
            proc.stdin.close()
            try:
                await proc.stdin.wait_closed()
            except Exception:
                pass

        timeout_sec = 5 if completed else (task.controls.get("timeout_ms", 120_000)) / 1000
        try:
            await asyncio.wait_for(proc.wait(), timeout=timeout_sec)
        except asyncio.TimeoutError:
            if completed:
                proc.terminate()
                try:
                    await asyncio.wait_for(proc.wait(), timeout=2)
                except asyncio.TimeoutError:
                    proc.kill()
                    await proc.wait()
            else:
                proc.kill()
                await proc.wait()
                await sink.emit(
                    "adapter.error",
                    {"code": "timeout", "message": f"pi agent timed out after {timeout_sec}s"},
                )
                return

        stderr = await stderr_task
        if proc.returncode != 0 and not completed:
            await sink.emit(
                "adapter.error",
                {
                    "code": "pi_exit_error",
                    "message": f"pi exited with code {proc.returncode}",
                    "stderr": stderr[:2000],
                },
            )
            return

        await sink.emit("adapter.completed", {"output": "pi agent finished"})

    async def _collect_stderr(self, stderr: asyncio.StreamReader | None) -> str:
        if stderr is None:
            return ""
        data = await stderr.read()
        return data.decode("utf-8", errors="replace")

    async def _read_events(
        self, stdout: asyncio.StreamReader, sink: EventSink, task_id: str
    ) -> bool:
        """Parse pi RPC JSONL events and forward to AgSwarm EventSink."""
        while True:
            try:
                line = await asyncio.wait_for(stdout.readline(), timeout=300)
            except asyncio.TimeoutError:
                return False
            if not line:
                return False

            text = line.decode("utf-8", errors="replace").rstrip("\n").rstrip("\r")
            if not text:
                continue

            try:
                msg = json.loads(text)
            except json.JSONDecodeError:
                await sink.emit(
                    "adapter.warning",
                    {"message": f"Invalid JSON from pi: {text[:200]}"},
                )
                continue

            msg_type = msg.get("type")

            # Responses (ack/nack) — mostly ignored unless error
            if msg_type == "response":
                if not msg.get("success"):
                    await sink.emit(
                        "adapter.error",
                        {
                            "code": "pi_rpc_error",
                            "command": msg.get("command"),
                            "message": str(msg),
                        },
                    )
                continue

            # Map pi events -> AgSwarm events
            event_type, payload = self._map_pi_event(msg)
            if event_type:
                await sink.emit(event_type, payload)

            # Stop reading when agent completes
            if msg_type == "agent_end":
                return True

        return False

    def _map_pi_event(self, msg: dict[str, Any]) -> tuple[str | None, dict[str, Any]]:
        """Map a single pi RPC event to AgSwarm EventSink event type + payload."""
        msg_type = msg.get("type")

        mapping: dict[str, tuple[str | None, dict[str, Any]]] = {
            "agent_start": ("agent.start", {}),
            "agent_end": ("agent.end", {"messages": msg.get("messages", [])}),
            "turn_start": ("agent.turn_start", {}),
            "turn_end": (
                "agent.turn_end",
                {
                    "message": msg.get("message"),
                    "tool_results": msg.get("toolResults", []),
                },
            ),
            "message_start": ("agent.message_start", {}),
            "message_update": (
                "agent.token",
                {
                    "text": msg.get("text", ""),
                    "thinking": msg.get("thinking", ""),
                    "tool_call": msg.get("toolCall"),
                },
            ),
            "message_end": ("agent.message_end", {}),
            "tool_execution_start": (
                "agent.tool_start",
                {"tool": msg.get("tool"), "params": msg.get("params")},
            ),
            "tool_execution_update": (
                "agent.tool_update",
                {"output": msg.get("output", "")},
            ),
            "tool_execution_end": (
                "agent.tool_end",
                {"result": msg.get("result")},
            ),
            "compaction_start": ("agent.compaction_start", {}),
            "compaction_end": ("agent.compaction_end", {}),
            "auto_retry_start": ("agent.retry_start", {}),
            "auto_retry_end": ("agent.retry_end", {}),
            "extension_error": (
                "adapter.error",
                {"message": msg.get("message", ""), "extension": msg.get("extension")},
            ),
        }

        return mapping.get(msg_type, (None, {}))
