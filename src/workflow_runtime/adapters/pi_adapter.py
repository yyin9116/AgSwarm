"""PiAdapter: embeds pi coding agent as an AgSwarm adapter via RPC mode.

Architecture
------------
- AgSwarm Runtime (Python) creates a TaskEnvelope and calls PiAdapter.run()
- PiAdapter spawns `pi --mode rpc` as a subprocess
- Communicates via strict JSONL over stdin/stdout
- Maps pi RPC events -> AgSwarm EventSink events
- Returns when pi agent completes (agent_end event)

This adapter uses pi's native RPC mode; AgSwarm exposes it as a peer node
capability for task routing.
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
    _COMMON_NODE_DIRS = (
        "/opt/homebrew/bin",
        "/opt/homebrew/opt/node/bin",
        "/usr/local/bin",
        "/usr/local/opt/node/bin",
        "/usr/bin",
        "/bin",
    )

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
        self.env = self._normalized_env(env)
        self.pi_cli = pi_cli or self._resolve_pi_cli(self.env)
        self.default_model = default_model
        self.provider = provider
        self.cwd = cwd or os.getcwd()
        self._seq = 0
        self._last_message_text = ""
        self._last_thinking_text = ""
        self._last_token_text = ""

    @staticmethod
    def _resolve_pi_cli(env: dict[str, str] | None = None) -> str:
        # 1. PATH
        if shutil.which("pi", path=(env or os.environ).get("PATH")):
            return "pi"
        # 2. Local build in ~/test/pi
        local = Path.home() / "test" / "pi" / "packages" / "coding-agent" / "dist" / "cli.js"
        if local.exists():
            node = PiAdapter._resolve_node_binary(env or os.environ)
            if not node:
                raise RuntimeError(
                    "pi CLI local build found, but node was not found. "
                    "Install Node.js or set WORKFLOW_PI_CLI to an executable pi command."
                )
            return f"{shlex.quote(node)} {shlex.quote(str(local))}"
        raise RuntimeError(
            "pi CLI not found. Install pi or set pi_cli=path/to/pi"
        )

    @classmethod
    def _normalized_env(cls, env: dict[str, str] | None = None) -> dict[str, str]:
        merged = {**os.environ, **(env or {})}
        merged["PATH"] = cls._node_friendly_path(merged)
        return merged

    @classmethod
    def _node_friendly_path(cls, env: dict[str, str]) -> str:
        paths: list[str] = []
        home = env.get("HOME") or str(Path.home())
        for path in (
            Path(home) / ".nvm" / "current" / "bin",
            Path(home) / ".fnm" / "aliases" / "default" / "bin",
            Path(home) / ".asdf" / "shims",
            Path(home) / ".volta" / "bin",
        ):
            if path.is_dir():
                cls._append_path(paths, str(path))
        for path in cls._COMMON_NODE_DIRS:
            cls._append_path(paths, path)
        for path in (env.get("PATH") or "").split(os.pathsep):
            cls._append_path(paths, path)
        return os.pathsep.join(paths)

    @staticmethod
    def _append_path(paths: list[str], path: str) -> None:
        value = path.strip()
        if value and value not in paths:
            paths.append(value)

    @classmethod
    def _resolve_node_binary(cls, env: dict[str, str]) -> str | None:
        node = shutil.which("node", path=cls._node_friendly_path(env))
        if node:
            return node
        for directory in cls._COMMON_NODE_DIRS:
            candidate = Path(directory) / "node"
            if candidate.exists() and os.access(candidate, os.X_OK):
                return str(candidate)
        return None

    @classmethod
    def _normalize_command_for_env(cls, cmd_parts: list[str], env: dict[str, str]) -> list[str]:
        if cmd_parts and cmd_parts[0] == "node":
            node = cls._resolve_node_binary(env)
            if node:
                return [node, *cmd_parts[1:]]
        return cmd_parts

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
        cmd_parts = self._normalize_command_for_env(cmd_parts, proc_env)

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
            if event_type == "agent.token" and self._is_duplicate_token_payload(payload):
                continue
            if event_type == "agent.token" and not any(
                payload.get(key) for key in ("text", "thinking", "tool_call")
            ):
                continue
            if event_type:
                await sink.emit(event_type, payload)

            # Stop reading when agent completes
            if msg_type == "agent_end":
                error_message = self._agent_end_error_message(msg)
                if error_message:
                    await sink.emit(
                        "adapter.error",
                        {
                            "code": "pi_agent_error",
                            "message": error_message,
                        },
                    )
                    return False
                return True

        return False

    def _agent_end_error_message(self, msg: dict[str, Any]) -> str:
        messages = msg.get("messages")
        if not isinstance(messages, list):
            return ""
        for message in reversed(messages):
            if not isinstance(message, dict):
                continue
            error_message = message.get("errorMessage") or message.get("error")
            if isinstance(error_message, str) and error_message.strip():
                return error_message.strip()
            stop_reason = message.get("stopReason")
            if stop_reason == "error":
                return "pi agent stopped with an error before producing a response."
        return ""

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
                    "text": self._extract_message_update_text(msg),
                    "thinking": self._extract_message_update_thinking(msg),
                    "tool_call": self._extract_message_update_tool_call(msg),
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
                {
                    "tool": msg.get("tool"),
                    "params": msg.get("params"),
                    "result": msg.get("result"),
                },
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

    def _extract_message_update_text(self, msg: dict[str, Any]) -> str:
        event = msg.get("assistantMessageEvent")
        if isinstance(event, dict):
            if self._message_update_has_thinking(msg):
                return ""
            if self._event_text_phase(event) not in {"", "final_answer"}:
                return ""
            for key in ("text", "delta", "content"):
                value = event.get(key)
                if isinstance(value, str) and value:
                    return self._delta_from_stream_text(value)
            if event.get("type") == "text":
                value = event.get("text")
                if isinstance(value, str):
                    return self._delta_from_stream_text(value)
        current_text = self._extract_message_content_text(msg.get("message"))
        return self._delta_from_stream_text(current_text)

    def _message_update_has_thinking(self, msg: dict[str, Any]) -> bool:
        event = msg.get("assistantMessageEvent")
        if isinstance(event, dict):
            for key in ("thinking", "reasoning", "summary"):
                value = event.get(key)
                if isinstance(value, str) and value:
                    return True
        return bool(self._extract_current_thinking(msg))

    def _delta_from_stream_text(self, current_text: str) -> str:
        if not current_text:
            return ""
        if current_text.startswith(self._last_message_text):
            delta = current_text[len(self._last_message_text):]
            self._last_message_text = current_text
        else:
            delta = current_text
            self._last_message_text += current_text
        return delta

    def _is_duplicate_token_payload(self, payload: dict[str, Any]) -> bool:
        text = payload.get("text")
        if not isinstance(text, str) or not text:
            return False
        if text == self._last_token_text and self._last_message_text.endswith(text):
            return True
        self._last_token_text = text
        return False

    def _extract_message_update_thinking(self, msg: dict[str, Any]) -> str:
        current_thinking = self._extract_current_thinking(msg)
        if not current_thinking:
            return ""
        return self._delta_from_stream_thinking(current_thinking)

    def _extract_current_thinking(self, msg: dict[str, Any]) -> str:
        event = msg.get("assistantMessageEvent")
        if isinstance(event, dict):
            for key in ("thinking", "reasoning", "summary"):
                value = event.get(key)
                if isinstance(value, str) and value:
                    return value
        message = msg.get("message")
        if not isinstance(message, dict):
            return ""
        content = message.get("content")
        if not isinstance(content, list):
            return ""
        thoughts: list[str] = []
        for part in content:
            if not isinstance(part, dict):
                continue
            if part.get("type") in {"thinking", "reasoning"}:
                value = part.get("thinking") or part.get("text") or part.get("summary")
                if isinstance(value, str) and value:
                    thoughts.append(value)
        return "\n".join(thoughts)

    def _delta_from_stream_thinking(self, current_thinking: str) -> str:
        if not current_thinking:
            return ""
        if current_thinking.startswith(self._last_thinking_text):
            delta = current_thinking[len(self._last_thinking_text):]
            self._last_thinking_text = current_thinking
            return delta
        if self._last_thinking_text and current_thinking in self._last_thinking_text:
            return ""
        self._last_thinking_text = current_thinking
        return current_thinking

    def _extract_message_update_tool_call(self, msg: dict[str, Any]) -> Any:
        event = msg.get("assistantMessageEvent")
        if isinstance(event, dict):
            for key in ("toolCall", "tool_call", "tool"):
                value = event.get(key)
                if value is not None:
                    return value
        message = msg.get("message")
        if not isinstance(message, dict):
            return None
        content = message.get("content")
        if not isinstance(content, list):
            return None
        for part in content:
            if isinstance(part, dict) and part.get("type") == "toolCall":
                return part
        return None

    def _extract_message_content_text(self, message: Any) -> str:
        if not isinstance(message, dict):
            return ""
        content = message.get("content")
        if isinstance(content, str):
            return content
        if not isinstance(content, list):
            return ""
        texts: list[str] = []
        for part in content:
            if isinstance(part, str):
                texts.append(part)
            elif isinstance(part, dict) and part.get("type") == "text":
                if self._event_text_phase(part) not in {"", "final_answer"}:
                    continue
                value = part.get("text")
                if isinstance(value, str):
                    texts.append(value)
        return "".join(texts)

    def _event_text_phase(self, value: dict[str, Any]) -> str:
        signature = value.get("textSignature")
        if not isinstance(signature, str) or not signature.strip():
            return ""
        try:
            parsed = json.loads(signature)
        except json.JSONDecodeError:
            return ""
        phase = parsed.get("phase") if isinstance(parsed, dict) else ""
        return phase if isinstance(phase, str) else ""
