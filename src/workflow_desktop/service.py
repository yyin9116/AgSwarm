from __future__ import annotations

import asyncio
import logging
from pathlib import Path
from time import time

from workflow_control_client import WorkflowControlClient
from workflow_runtime.protocol import AdapterConfig, TaskEnvelope
from workflow_transport import NatsTransportProvider

logger = logging.getLogger(__name__)


class DesktopControlService:
    def __init__(self, *, client_id: str, nats_url: str) -> None:
        self._transport = NatsTransportProvider(server_url=nats_url)
        self._client = WorkflowControlClient(client_id=client_id, transport=self._transport)
        self._connected = False
        self._lock = asyncio.Lock()

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
            await self._client.close()
            self._connected = False
            logger.info("desktop service closed")

    async def ensure_connected(self) -> None:
        if not self._connected:
            await self.connect()

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
