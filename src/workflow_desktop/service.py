from __future__ import annotations

import asyncio
import logging
import os
import shlex
import tempfile
from pathlib import Path
from time import time
from collections.abc import Awaitable, Callable

from workflow_control_client import WorkflowControlClient
from workflow_runtime.protocol import AdapterConfig, TaskEnvelope
from workflow_transport import NatsTransportProvider, Subscription

logger = logging.getLogger(__name__)

ClientEventHandler = Callable[[str, dict], Awaitable[None]]


class DesktopControlService:
    def __init__(self, *, client_id: str, nats_url: str) -> None:
        self._nats_url = nats_url
        self._transport = NatsTransportProvider(server_url=nats_url)
        self._client = WorkflowControlClient(client_id=client_id, transport=self._transport)
        self.client_id = client_id
        self._connected = False
        self._lock = asyncio.Lock()
        self._client_subscriptions: list[Subscription] = []

    @property
    def nats_url(self) -> str:
        return self._nats_url

    @property
    def connected(self) -> bool:
        return self._connected

    async def connect(self) -> None:
        async with self._lock:
            if self._connected:
                return
            await self._client.connect()
            self._connected = True
            logger.info("desktop service connected")

    async def close(self) -> None:
        async with self._lock:
            if not self._connected:
                return
            await self.stop_client_messaging()
            await self._client.close()
            self._connected = False
            logger.info("desktop service closed")

    async def ensure_connected(self) -> None:
        if not self._connected:
            await self.connect()

    async def start_client_messaging(self, *, handler: ClientEventHandler) -> None:
        await self.ensure_connected()
        if self._client_subscriptions:
            return

        async def _presence(subject: str, payload: dict) -> None:
            await handler(subject, payload)

        async def _inbox(subject: str, payload: dict) -> None:
            await handler(subject, payload)

        self._client_subscriptions.append(await self._client.subscribe_client_presence(handler=_presence))
        self._client_subscriptions.append(await self._client.subscribe_client_inbox(handler=_inbox))
        await self.publish_presence(status="online")

    async def stop_client_messaging(self) -> None:
        if not self._client_subscriptions:
            return
        await self.publish_presence(status="offline")
        subscriptions = list(self._client_subscriptions)
        self._client_subscriptions.clear()
        for sub in subscriptions:
            try:
                await sub.unsubscribe()
            except Exception:
                logger.exception("desktop client subscription cleanup failed")

    async def publish_presence(self, *, status: str = "online") -> None:
        await self.ensure_connected()
        await self._client.publish_client_presence(
            {
                "status": status,
                "display_name": self.client_id,
            }
        )

    async def send_chat_message(
        self,
        *,
        target_client_id: str,
        text: str,
        conversation_id: str | None = None,
    ) -> dict:
        await self.ensure_connected()
        return await self._client.send_client_message(
            target_client_id=target_client_id,
            message_type="chat.message",
            conversation_id=conversation_id,
            payload={"text": text},
        )

    async def send_task_request(
        self,
        *,
        target_client_id: str,
        instruction: str,
        suggested_script: str = "",
        conversation_id: str | None = None,
    ) -> dict:
        await self.ensure_connected()
        return await self._client.send_client_message(
            target_client_id=target_client_id,
            message_type="task.request",
            conversation_id=conversation_id,
            payload={
                "instruction": instruction,
                "suggested_script": suggested_script,
            },
        )

    async def send_task_result(
        self,
        *,
        target_client_id: str,
        request_message_id: str,
        result: dict,
        conversation_id: str | None = None,
    ) -> dict:
        await self.ensure_connected()
        return await self._client.send_client_message(
            target_client_id=target_client_id,
            message_type="task.result",
            conversation_id=conversation_id,
            payload={
                "request_message_id": request_message_id,
                "result": result,
            },
        )

    async def execute_python_script(self, *, script: str, timeout_sec: float = 30.0) -> dict:
        text = script.strip()
        if not text:
            raise ValueError("script is required")
        tmp_dir = Path(tempfile.mkdtemp(prefix="workflow-client-task-"))
        script_path = tmp_dir / "task.py"
        script_path.write_text(text + "\n", encoding="utf-8")
        cmd = [os.environ.get("PYTHON", "python3"), str(script_path)]
        started_at = time()
        proc = await asyncio.create_subprocess_exec(
            *cmd,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
            cwd=str(tmp_dir),
        )
        try:
            stdout, stderr = await asyncio.wait_for(proc.communicate(), timeout=timeout_sec)
        except asyncio.TimeoutError:
            proc.kill()
            stdout, stderr = await proc.communicate()
            return {
                "ok": False,
                "returncode": proc.returncode,
                "timeout": True,
                "command": shlex.join(cmd),
                "cwd": str(tmp_dir),
                "stdout": stdout.decode("utf-8", errors="replace"),
                "stderr": stderr.decode("utf-8", errors="replace"),
                "duration_sec": round(time() - started_at, 3),
            }
        return {
            "ok": proc.returncode == 0,
            "returncode": proc.returncode,
            "timeout": False,
            "command": shlex.join(cmd),
            "cwd": str(tmp_dir),
            "stdout": stdout.decode("utf-8", errors="replace"),
            "stderr": stderr.decode("utf-8", errors="replace"),
            "duration_sec": round(time() - started_at, 3),
        }

    async def request_node_snapshot(self, *, node_id: str, timeout_sec: float = 2.0) -> dict:
        await self.ensure_connected()
        return await self._client.request_node_snapshot(node_id=node_id, timeout_sec=timeout_sec)

    async def sync_node_config(
        self,
        *,
        node_id: str,
        config_payload: dict,
        timeout_sec: float = 4.0,
    ) -> dict:
        await self.ensure_connected()
        return await self._client.sync_node_config(
            node_id=node_id,
            config_payload=config_payload,
            timeout_sec=timeout_sec,
        )

    async def agent_check(
        self,
        *,
        node_id: str,
        required_adapters: list[str] | None = None,
        timeout_sec: float = 2.0,
    ) -> dict:
        snapshot = await self.request_node_snapshot(node_id=node_id, timeout_sec=timeout_sec)
        required = [x.strip() for x in (required_adapters or []) if x.strip()]
        adapters = snapshot.get("adapters")
        if isinstance(adapters, list):
            adapter_set = {str(x) for x in adapters}
        else:
            adapter_set = set()
        missing_adapters = [name for name in required if name not in adapter_set]

        status = str(snapshot.get("status", "unknown"))
        can_accept = bool(snapshot.get("can_accept_tasks", status != "stopped"))
        agent_ready = bool(snapshot.get("agent_ready", can_accept and len(adapter_set) > 0))
        skills_loaded = bool(snapshot.get("skills_loaded", False))
        checks = {
            "node_reachable": True,
            "can_accept_tasks": can_accept,
            "agent_ready": agent_ready,
            "required_adapters_ok": len(missing_adapters) == 0,
            "skills_loaded": skills_loaded,
        }
        return {
            "ok": all(checks.values()),
            "node_id": node_id,
            "checks": checks,
            "required_adapters": required,
            "missing_adapters": missing_adapters,
            "snapshot": snapshot,
        }

    async def submit_echo(
        self,
        *,
        node_id: str,
        instruction: str,
        timeout_sec: float = 120.0,
        skills: list[str] | None = None,
    ) -> dict:
        await self.ensure_connected()
        metadata: dict[str, object] = {}
        if skills:
            metadata["skills"] = skills
        task = TaskEnvelope(
            adapter=AdapterConfig(name="echo"),
            input_text=instruction,
            controls={"stream": True, "timeout_ms": int(timeout_sec * 1000), "max_steps": 32},
            metadata=metadata,
        )
        return await self._client.run_task_and_wait(
            target_node_id=node_id,
            task=task,
            timeout_sec=timeout_sec + 5.0,
        )

    async def submit_latex(
        self,
        *,
        node_id: str,
        workspace: str,
        latex_mcp_dir: str,
        main_tex: str,
        instruction: str,
        engine: str = "pdflatex",
        output_subdir: str = "build_case_desktop",
        latex_bin_dir: str | None = None,
        preview_page: int = 1,
        preview_dpi: int = 160,
        compile_timeout_sec: int = 360,
        timeout_sec: float = 900.0,
        skills: list[str] | None = None,
    ) -> dict:
        await self.ensure_connected()
        options = {
            "workspace": workspace,
            "server_cwd": latex_mcp_dir,
            "tool": "compile_and_preview",
            "file_list": [main_tex],
            "main_tex": main_tex,
            "engine": engine,
            "output_subdir": output_subdir,
            "latex_bin_dir": latex_bin_dir,
            "tool_args": {
                "preview_page": int(preview_page),
                "preview_dpi": int(preview_dpi),
                "timeout_sec": int(compile_timeout_sec),
            },
        }
        task = TaskEnvelope(
            adapter=AdapterConfig(name="latex_mcp", options=options),
            input_text=instruction or f"Compile LaTeX file: {main_tex}",
            controls={"stream": True, "timeout_ms": int(timeout_sec * 1000), "max_steps": 96},
            metadata={"scenario": "latex_compile_desktop"},
        )
        if skills:
            task.metadata["skills"] = skills
        return await self._client.run_task_and_wait(
            target_node_id=node_id,
            task=task,
            timeout_sec=timeout_sec + 5.0,
        )

    async def upload_paths(self, *, node_id: str, local_paths: list[str], remote_root: str | None = None) -> dict:
        await self.ensure_connected()
        if not local_paths:
            return {"ok": True, "uploaded": [], "failed": []}

        base = remote_root or f"desktop-input-{int(time())}"
        uploaded: list[dict] = []
        failed: list[dict] = []

        for raw in local_paths:
            path = Path(raw)
            try:
                if path.is_file():
                    remote_name = f"{base}/{path.name}"
                    item = await self._client.upload_file(
                        target_node_id=node_id,
                        source_path=str(path),
                        remote_name=remote_name,
                    )
                    item["kind"] = "file"
                    item["source_path"] = str(path)
                    uploaded.append(item)
                elif path.is_dir():
                    remote_dir = f"{base}/{path.name}"
                    item = await self._client.upload_directory(
                        target_node_id=node_id,
                        source_dir=str(path),
                        remote_dir=remote_dir,
                    )
                    item["kind"] = "directory"
                    item["source_path"] = str(path)
                    uploaded.append(item)
                else:
                    failed.append({"source_path": str(path), "error": "path_not_found"})
            except Exception as exc:  # pragma: no cover
                failed.append({"source_path": str(path), "error": str(exc)})

        return {"ok": len(failed) == 0, "uploaded": uploaded, "failed": failed}

    async def download_file(
        self,
        *,
        node_id: str,
        source_path: str,
        output_path: str,
        chunk_size: int = 256 * 1024,
        chunk_retries: int = 1,
        request_timeout_sec: float = 10.0,
    ) -> dict:
        await self.ensure_connected()
        return await self._client.download_file(
            target_node_id=node_id,
            source_path=source_path,
            output_path=output_path,
            chunk_size=chunk_size,
            chunk_retries=chunk_retries,
            request_timeout_sec=request_timeout_sec,
            allow_overwrite=True,
        )

    async def download_directory(
        self,
        *,
        node_id: str,
        source_dir: str,
        output_dir: str,
        max_files: int = 2000,
        list_page_size: int = 500,
        max_parallelism: int = 4,
        chunk_size: int = 256 * 1024,
        chunk_retries: int = 1,
        request_timeout_sec: float = 10.0,
        continue_on_error: bool = False,
    ) -> dict:
        await self.ensure_connected()
        return await self._client.download_directory(
            target_node_id=node_id,
            source_dir=source_dir,
            output_dir=output_dir,
            max_files=max_files,
            list_page_size=list_page_size,
            max_parallelism=max_parallelism,
            chunk_size=chunk_size,
            chunk_retries=chunk_retries,
            request_timeout_sec=request_timeout_sec,
            continue_on_error=continue_on_error,
            allow_overwrite=True,
        )
