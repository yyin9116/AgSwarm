from __future__ import annotations

import asyncio
import base64
import hashlib
import logging
from collections.abc import Awaitable, Callable
from contextlib import suppress
from datetime import datetime
from pathlib import Path
from time import monotonic
from uuid import uuid4

from workflow_runtime.protocol import Event, TaskEnvelope
from workflow_transport import Subscription, TransportProvider, subjects

EventHandler = Callable[[Event], Awaitable[None]]
StatusHandler = Callable[[str, dict], Awaitable[None]]
ClientMessageHandler = Callable[[str, dict], Awaitable[None]]

logger = logging.getLogger(__name__)


class WorkflowControlClient:
    def __init__(self, *, client_id: str, transport: TransportProvider) -> None:
        self.client_id = client_id
        self.transport = transport

    async def connect(self) -> None:
        logger.info("client connect client_id=%s", self.client_id)
        await self.transport.connect()

    async def close(self) -> None:
        logger.info("client close client_id=%s", self.client_id)
        await self.transport.close()

    async def submit_task(self, *, target_node_id: str, task: TaskEnvelope) -> str:
        payload = {
            "from_client_id": self.client_id,
            "task": task.to_dict(),
        }
        await self.transport.publish(subjects.task_submit(target_node_id), payload)
        logger.info(
            "task submitted by client client_id=%s target_node_id=%s task_id=%s adapter=%s",
            self.client_id,
            target_node_id,
            task.task_id,
            task.adapter.name,
        )
        return task.task_id

    async def subscribe_task_events(
        self,
        *,
        node_id: str,
        handler: EventHandler,
        task_id: str | None = None,
    ) -> Subscription:
        async def _on_message(_: str, payload: dict, __: str | None) -> None:
            await handler(Event.from_dict(payload))

        return await self.transport.subscribe(subjects.task_events(node_id, task_id), _on_message)

    async def subscribe_node_status(
        self,
        *,
        handler: StatusHandler,
        node_id: str | None = None,
    ) -> Subscription:
        async def _on_message(subject: str, payload: dict, _: str | None) -> None:
            await handler(subject, payload)

        return await self.transport.subscribe(subjects.node_status(node_id), _on_message)

    async def publish_client_presence(self, payload: dict | None = None) -> None:
        body = {
            "type": "presence",
            "from_client_id": self.client_id,
            "client_id": self.client_id,
            "ts": datetime.now().isoformat(timespec="seconds"),
        }
        if payload:
            body.update(payload)
        await self.transport.publish(subjects.client_presence(self.client_id), body)

    async def subscribe_client_presence(self, *, handler: ClientMessageHandler) -> Subscription:
        async def _on_message(subject: str, payload: dict, _: str | None) -> None:
            await handler(subject, payload)

        return await self.transport.subscribe(subjects.client_presence(), _on_message)

    async def send_client_message(
        self,
        *,
        target_client_id: str,
        message_type: str,
        payload: dict | None = None,
        conversation_id: str | None = None,
    ) -> dict:
        target = target_client_id.strip()
        if not target:
            raise ValueError("target_client_id is required")
        msg_type = message_type.strip()
        if not msg_type:
            raise ValueError("message_type is required")
        message_id = str(uuid4())
        body = {
            "type": msg_type,
            "message_id": message_id,
            "conversation_id": conversation_id or f"{self.client_id}:{target}",
            "from_client_id": self.client_id,
            "target_client_id": target,
            "payload": payload or {},
            "ts": datetime.now().isoformat(timespec="seconds"),
        }
        await self.transport.publish(subjects.client_inbox(target), body)
        return body

    async def subscribe_client_inbox(self, *, handler: ClientMessageHandler) -> Subscription:
        async def _on_message(subject: str, payload: dict, _: str | None) -> None:
            await handler(subject, payload)

        return await self.transport.subscribe(subjects.client_inbox(self.client_id), _on_message)

    async def request_node_snapshot(
        self,
        *,
        node_id: str,
        timeout_sec: float = 2.0,
    ) -> dict:
        return await self.transport.request(
            subjects.node_snapshot_request(node_id),
            {"from_client_id": self.client_id},
            timeout_sec=timeout_sec,
        )

    async def sync_node_config(
        self,
        *,
        node_id: str,
        config_payload: dict,
        timeout_sec: float = 4.0,
    ) -> dict:
        return await self.transport.request(
            subjects.node_config_sync_request(node_id),
            {
                "from_client_id": self.client_id,
                "config_payload": config_payload,
            },
            timeout_sec=timeout_sec,
        )

    async def discover_peer_nodes(
        self,
        *,
        timeout_sec: float = 1.0,
        require_capabilities: list[str] | None = None,
    ) -> list[dict]:
        if timeout_sec <= 0:
            raise ValueError("timeout_sec must be > 0")
        required = set(require_capabilities or [])
        nodes_by_id: dict[str, dict] = {}

        async def _on_status(_: str, payload: dict) -> None:
            node_id = payload.get("node_id")
            peer = payload.get("peer_node")
            if not isinstance(node_id, str) or not isinstance(peer, dict):
                return
            capabilities = peer.get("capabilities")
            capability_set = {str(x) for x in capabilities} if isinstance(capabilities, list) else set()
            if not required.issubset(capability_set):
                return
            nodes_by_id[node_id] = dict(payload)

        sub = await self.subscribe_node_status(handler=_on_status)
        try:
            await asyncio.sleep(timeout_sec)
        finally:
            await sub.unsubscribe()
        return [nodes_by_id[key] for key in sorted(nodes_by_id)]

    async def resolve_peer_device_node(
        self,
        *,
        device_id: str,
        timeout_sec: float = 1.0,
        require_capabilities: list[str] | None = None,
    ) -> dict:
        wanted = device_id.strip()
        if not wanted:
            raise ValueError("device_id is required")
        nodes = await self.discover_peer_nodes(
            timeout_sec=timeout_sec,
            require_capabilities=require_capabilities,
        )
        matches: list[dict] = []
        for node in nodes:
            peer = node.get("peer_node")
            if not isinstance(peer, dict):
                continue
            candidates = {
                str(node.get("node_id") or ""),
                str(peer.get("device_id") or ""),
            }
            if wanted in candidates:
                matches.append(node)
        if not matches:
            raise LookupError(f"No peer node found for device_id={wanted!r}")
        if len(matches) > 1:
            node_ids = sorted(str(item.get("node_id")) for item in matches)
            raise LookupError(f"Multiple peer nodes found for device_id={wanted!r}: {node_ids}")
        return matches[0]

    async def request_peer_command(
        self,
        *,
        node_id: str,
        command: str,
        payload: dict | None = None,
        timeout_sec: float = 2.0,
    ) -> dict:
        if not command.strip():
            raise ValueError("command is required")
        return await self.transport.request(
            subjects.peer_command_request(node_id),
            {
                "from_client_id": self.client_id,
                "command": command,
                "payload": payload or {},
            },
            timeout_sec=timeout_sec,
        )

    async def upload_file(
        self,
        *,
        target_node_id: str,
        source_path: str,
        remote_name: str | None = None,
        chunk_size: int = 256 * 1024,
        transfer_id: str | None = None,
        max_parallelism: int = 4,
        chunk_retries: int = 1,
    ) -> dict:
        path = Path(source_path)
        if not path.is_file():
            raise FileNotFoundError(f"File not found: {source_path}")
        if chunk_size <= 0:
            raise ValueError("chunk_size must be > 0")
        if max_parallelism < 1:
            raise ValueError("max_parallelism must be >= 1")
        if chunk_retries < 0:
            raise ValueError("chunk_retries must be >= 0")

        transfer_id = transfer_id or str(uuid4())
        file_size = path.stat().st_size
        digest = hashlib.sha256()
        with path.open("rb") as f:
            for block in iter(lambda: f.read(1024 * 1024), b""):
                digest.update(block)
        sha256 = digest.hexdigest()
        total_chunks = (file_size + chunk_size - 1) // chunk_size if file_size else 0
        logger.info(
            "upload start client_id=%s node_id=%s file=%s transfer_id=%s size=%d chunk_size=%d total_chunks=%d",
            self.client_id,
            target_node_id,
            str(path),
            transfer_id,
            file_size,
            chunk_size,
            total_chunks,
        )

        prepare_resp = await self.transport.request(
            subjects.file_prepare_request(target_node_id),
            {
                "from_client_id": self.client_id,
                "transfer_id": transfer_id,
                "file_name": remote_name or path.name,
                "size_bytes": file_size,
                "sha256": sha256,
                "chunk_size": chunk_size,
                "total_chunks": total_chunks,
            },
            timeout_sec=5.0,
        )
        if not prepare_resp.get("accepted"):
            raise RuntimeError(f"Prepare rejected: {prepare_resp}")

        missing_indexes = prepare_resp.get("missing_indexes")
        if isinstance(missing_indexes, list):
            upload_indexes = sorted(
                {
                    int(idx)
                    for idx in missing_indexes
                    if isinstance(idx, int) and 0 <= idx < total_chunks
                }
            )
        else:
            upload_indexes = list(range(total_chunks))

        async def _send_chunk(index: int) -> None:
            offset = index * chunk_size
            with path.open("rb") as f:
                f.seek(offset)
                chunk = f.read(chunk_size)
            last_error: Exception | None = None
            for attempt in range(chunk_retries + 1):
                try:
                    await self.transport.publish(
                        subjects.file_chunk(target_node_id, transfer_id),
                        {
                            "transfer_id": transfer_id,
                            "index": index,
                            "total_chunks": total_chunks,
                            "data_b64": base64.b64encode(chunk).decode("ascii"),
                        },
                    )
                    return
                except Exception as exc:  # pragma: no cover
                    last_error = exc
                    if attempt < chunk_retries:
                        await asyncio.sleep(min(0.2 * (2**attempt), 1.5))
            raise RuntimeError(f"chunk publish failed for index={index}") from last_error

        for i in range(0, len(upload_indexes), max_parallelism):
            group = upload_indexes[i : i + max_parallelism]
            await asyncio.gather(*(_send_chunk(idx) for idx in group))
            logger.debug(
                "upload chunk group sent transfer_id=%s sent=%d/%d",
                transfer_id,
                min(i + len(group), len(upload_indexes)),
                len(upload_indexes),
            )

        commit_resp = await self.transport.request(
            subjects.file_commit_request(target_node_id),
            {
                "from_client_id": self.client_id,
                "transfer_id": transfer_id,
                "expected_sha256": sha256,
                "expected_size_bytes": file_size,
            },
            timeout_sec=20.0,
        )
        if not commit_resp.get("ok"):
            raise RuntimeError(f"Commit failed: {commit_resp}")
        commit_resp.setdefault("transfer_id", transfer_id)
        commit_resp["uploaded_chunks"] = len(upload_indexes)
        commit_resp["total_chunks"] = total_chunks
        logger.info(
            "upload success client_id=%s node_id=%s transfer_id=%s uploaded_chunks=%d total_chunks=%d saved_path=%s",
            self.client_id,
            target_node_id,
            transfer_id,
            len(upload_indexes),
            total_chunks,
            commit_resp.get("saved_path"),
        )
        return commit_resp

    async def upload_directory(
        self,
        *,
        target_node_id: str,
        source_dir: str,
        remote_dir: str | None = None,
        chunk_size: int = 256 * 1024,
        max_parallelism: int = 4,
        chunk_retries: int = 1,
        continue_on_error: bool = False,
    ) -> dict:
        root = Path(source_dir)
        if not root.is_dir():
            raise NotADirectoryError(f"Directory not found: {source_dir}")

        files = sorted(p for p in root.rglob("*") if p.is_file())
        normalized_remote_dir: str | None = None
        if remote_dir is not None:
            value = remote_dir.strip().replace("\\", "/").strip("/")
            normalized_remote_dir = value if value else None

        base_remote = normalized_remote_dir or root.name
        results: list[dict] = []
        failures: list[dict] = []

        for file_path in files:
            rel_path = file_path.relative_to(root).as_posix()
            remote_name = f"{base_remote}/{rel_path}" if base_remote else rel_path
            try:
                item = await self.upload_file(
                    target_node_id=target_node_id,
                    source_path=str(file_path),
                    remote_name=remote_name,
                    chunk_size=chunk_size,
                    max_parallelism=max_parallelism,
                    chunk_retries=chunk_retries,
                )
                item["source_path"] = str(file_path)
                item["remote_name"] = remote_name
                results.append(item)
            except Exception as exc:
                failure = {
                    "source_path": str(file_path),
                    "remote_name": remote_name,
                    "error": str(exc),
                }
                failures.append(failure)
                logger.error(
                    "upload directory item failed client_id=%s node_id=%s source=%s remote=%s error=%s",
                    self.client_id,
                    target_node_id,
                    str(file_path),
                    remote_name,
                    str(exc),
                )
                if not continue_on_error:
                    return {
                        "ok": False,
                        "source_dir": str(root),
                        "remote_dir": base_remote,
                        "files_total": len(files),
                        "files_uploaded": len(results),
                        "files_failed": len(failures),
                        "uploaded": results,
                        "failures": failures,
                    }

        return {
            "ok": len(failures) == 0,
            "source_dir": str(root),
            "remote_dir": base_remote,
            "files_total": len(files),
            "files_uploaded": len(results),
            "files_failed": len(failures),
            "uploaded": results,
            "failures": failures,
        }

    async def resume_file_upload(
        self,
        *,
        target_node_id: str,
        source_path: str,
        transfer_id: str,
        remote_name: str | None = None,
        chunk_size: int = 256 * 1024,
        max_parallelism: int = 4,
        chunk_retries: int = 1,
    ) -> dict:
        return await self.upload_file(
            target_node_id=target_node_id,
            source_path=source_path,
            remote_name=remote_name,
            chunk_size=chunk_size,
            transfer_id=transfer_id,
            max_parallelism=max_parallelism,
            chunk_retries=chunk_retries,
        )

    async def download_file(
        self,
        *,
        target_node_id: str,
        source_path: str,
        output_path: str | None = None,
        chunk_size: int = 256 * 1024,
        download_id: str | None = None,
        chunk_retries: int = 1,
        request_timeout_sec: float = 10.0,
        allow_overwrite: bool = False,
    ) -> dict:
        if chunk_size <= 0:
            raise ValueError("chunk_size must be > 0")
        if chunk_retries < 0:
            raise ValueError("chunk_retries must be >= 0")
        if request_timeout_sec <= 0:
            raise ValueError("request_timeout_sec must be > 0")
        source_text = source_path.strip()
        if not source_text:
            raise ValueError("source_path is required")

        download_id = download_id or str(uuid4())
        prepare_resp = await self.transport.request(
            subjects.file_download_prepare_request(target_node_id),
            {
                "from_client_id": self.client_id,
                "download_id": download_id,
                "source_path": source_text,
                "chunk_size": chunk_size,
            },
            timeout_sec=request_timeout_sec,
        )
        if not prepare_resp.get("ok"):
            raise RuntimeError(f"Download prepare failed: {prepare_resp}")

        remote_file_name = str(prepare_resp.get("file_name") or _safe_download_name(source_text, download_id))
        total_chunks = int(prepare_resp.get("total_chunks", 0))
        expected_size = int(prepare_resp.get("size_bytes", 0))
        expected_sha256 = str(prepare_resp.get("sha256", "")).strip()
        remote_source_path = str(prepare_resp.get("source_path", source_text))
        resolved_download_id = str(prepare_resp.get("download_id", download_id))

        destination = self._resolve_download_destination(
            output_path=output_path,
            remote_file_name=remote_file_name,
            allow_overwrite=allow_overwrite,
        )
        destination.parent.mkdir(parents=True, exist_ok=True)
        temp_path = destination.with_name(f"{destination.name}.part-{resolved_download_id[:8]}")
        temp_path.unlink(missing_ok=True)

        hasher = hashlib.sha256()
        downloaded_size = 0
        try:
            with temp_path.open("wb") as out:
                if total_chunks == 0:
                    pass
                else:
                    for index in range(total_chunks):
                        chunk_bytes = await self._download_chunk_with_retry(
                            target_node_id=target_node_id,
                            download_id=resolved_download_id,
                            index=index,
                            chunk_retries=chunk_retries,
                            request_timeout_sec=request_timeout_sec,
                        )
                        out.write(chunk_bytes)
                        hasher.update(chunk_bytes)
                        downloaded_size += len(chunk_bytes)
            actual_sha256 = hasher.hexdigest()
            if expected_size != downloaded_size:
                raise RuntimeError(
                    f"download size mismatch expected={expected_size} actual={downloaded_size}"
                )
            if expected_sha256 and expected_sha256 != actual_sha256:
                raise RuntimeError(
                    f"download sha256 mismatch expected={expected_sha256} actual={actual_sha256}"
                )
            if destination.exists():
                destination.unlink()
            temp_path.replace(destination)
        except Exception:
            temp_path.unlink(missing_ok=True)
            raise

        logger.info(
            "download success client_id=%s node_id=%s download_id=%s source=%s output=%s size=%d",
            self.client_id,
            target_node_id,
            resolved_download_id,
            remote_source_path,
            str(destination),
            downloaded_size,
        )
        return {
            "ok": True,
            "download_id": resolved_download_id,
            "source_path": remote_source_path,
            "output_path": str(destination),
            "file_name": remote_file_name,
            "size_bytes": downloaded_size,
            "sha256": actual_sha256,
            "total_chunks": total_chunks,
            "chunk_size": int(prepare_resp.get("chunk_size", chunk_size)),
        }

    async def _download_chunk_with_retry(
        self,
        *,
        target_node_id: str,
        download_id: str,
        index: int,
        chunk_retries: int,
        request_timeout_sec: float,
    ) -> bytes:
        last_error: Exception | None = None
        for attempt in range(chunk_retries + 1):
            try:
                chunk_resp = await self.transport.request(
                    subjects.file_download_chunk_request(target_node_id),
                    {
                        "from_client_id": self.client_id,
                        "download_id": download_id,
                        "index": index,
                    },
                    timeout_sec=request_timeout_sec,
                )
                if not chunk_resp.get("ok"):
                    raise RuntimeError(f"chunk request failed: {chunk_resp}")
                data_b64 = chunk_resp.get("data_b64")
                if not isinstance(data_b64, str):
                    raise RuntimeError(f"chunk response missing data_b64: {chunk_resp}")
                return base64.b64decode(data_b64.encode("ascii"))
            except Exception as exc:
                last_error = exc
                if attempt < chunk_retries:
                    await asyncio.sleep(min(0.2 * (2**attempt), 1.5))
        raise RuntimeError(f"download chunk failed index={index}") from last_error

    async def download_directory(
        self,
        *,
        target_node_id: str,
        source_dir: str,
        output_dir: str | None = None,
        max_files: int = 2000,
        list_page_size: int = 500,
        max_parallelism: int = 4,
        chunk_size: int = 256 * 1024,
        chunk_retries: int = 1,
        request_timeout_sec: float = 10.0,
        continue_on_error: bool = False,
        allow_overwrite: bool = False,
    ) -> dict:
        source_text = source_dir.strip()
        if not source_text:
            raise ValueError("source_dir is required")
        if max_files < 1:
            raise ValueError("max_files must be >= 1")
        if list_page_size < 1:
            raise ValueError("list_page_size must be >= 1")
        if max_parallelism < 1:
            raise ValueError("max_parallelism must be >= 1")
        rows: list[dict[str, Any]] = []
        source_path = source_text
        list_pages = 0
        cursor = 0
        has_more = True
        truncated = False
        while has_more and len(rows) < max_files:
            page_quota = max_files - len(rows)
            page_size = min(list_page_size, page_quota)
            list_resp = await self.transport.request(
                subjects.file_download_list_request(target_node_id),
                {
                    "from_client_id": self.client_id,
                    "source_path": source_text,
                    "max_files": int(max_files),
                    "cursor": int(cursor),
                    "page_size": int(page_size),
                },
                timeout_sec=request_timeout_sec,
            )
            if not list_resp.get("ok"):
                raise RuntimeError(f"Download list failed: {list_resp}")
            source_path = str(list_resp.get("source_path", source_path))
            page_rows = list_resp.get("files")
            if not isinstance(page_rows, list):
                raise RuntimeError(f"Invalid download list response: {list_resp}")
            list_pages += 1
            for item in page_rows:
                if isinstance(item, dict):
                    rows.append(item)
                if len(rows) >= max_files:
                    break
            has_more = bool(list_resp.get("has_more", list_resp.get("truncated", False)))
            truncated = truncated or bool(list_resp.get("truncated", False))
            if not has_more:
                break
            next_cursor = list_resp.get("next_cursor")
            if isinstance(next_cursor, int) and next_cursor > cursor:
                cursor = next_cursor
            else:
                cursor += len(page_rows)
            if len(page_rows) == 0:
                break

        source_name = Path(source_path).name or "download-dir"
        if output_dir:
            output_root = Path(output_dir)
        else:
            stamp = datetime.now().strftime("%Y%m%d_%H%M%S")
            output_root = Path.cwd() / "tmp" / "downloads" / f"{source_name}-{stamp}"
        output_root.mkdir(parents=True, exist_ok=True)

        entries: list[tuple[int, str, Path]] = []
        failures: list[dict] = []
        for idx, row in enumerate(rows):
            if not isinstance(row, dict):
                failures.append({"error": f"invalid list item: {row}"})
                if not continue_on_error:
                    break
                continue
            remote_file_path = row.get("source_path")
            rel_path = row.get("relative_path")
            if not isinstance(remote_file_path, str) or not isinstance(rel_path, str):
                failures.append({"error": f"invalid list item: {row}"})
                if not continue_on_error:
                    break
                continue
            try:
                safe_rel = _safe_relative_download_path(rel_path)
            except ValueError as exc:
                failures.append({"source_path": remote_file_path, "relative_path": rel_path, "error": str(exc)})
                if not continue_on_error:
                    break
                continue
            entries.append((idx, remote_file_path, safe_rel))

        if failures and (not continue_on_error):
            return {
                "ok": False,
                "source_dir": source_path,
                "output_dir": str(output_root),
                "files_total": len(rows),
                "files_downloaded": 0,
                "files_failed": len(failures),
                "downloaded": [],
                "failures": failures,
                "truncated": truncated,
                "list_pages": list_pages,
            }

        downloaded: list[dict] = []
        result_lock = asyncio.Lock()
        queue: asyncio.Queue[tuple[int, str, Path]] = asyncio.Queue()
        abort_event = asyncio.Event()
        for entry in entries:
            queue.put_nowait(entry)

        async def _worker() -> None:
            try:
                while True:
                    try:
                        idx, remote_file_path, safe_rel = queue.get_nowait()
                    except asyncio.QueueEmpty:
                        return
                    if abort_event.is_set() and (not continue_on_error):
                        queue.task_done()
                        continue
                    try:
                        destination = output_root / safe_rel
                        destination.parent.mkdir(parents=True, exist_ok=True)
                        item = await self.download_file(
                            target_node_id=target_node_id,
                            source_path=remote_file_path,
                            output_path=str(destination),
                            chunk_size=chunk_size,
                            chunk_retries=chunk_retries,
                            request_timeout_sec=request_timeout_sec,
                            allow_overwrite=allow_overwrite,
                        )
                        item["relative_path"] = safe_rel.as_posix()
                        item["_index"] = idx
                        async with result_lock:
                            downloaded.append(item)
                    except Exception as exc:
                        failure = {
                            "source_path": remote_file_path,
                            "relative_path": safe_rel.as_posix(),
                            "error": str(exc),
                        }
                        async with result_lock:
                            failures.append(failure)
                        if not continue_on_error:
                            abort_event.set()
                    finally:
                        queue.task_done()
            except asyncio.CancelledError:
                return

        workers = [asyncio.create_task(_worker()) for _ in range(min(max_parallelism, max(1, len(entries))))]
        await queue.join()
        for task in workers:
            task.cancel()
        for task in workers:
            with suppress(asyncio.CancelledError):
                await task

        downloaded.sort(key=lambda x: int(x.get("_index", 0)))
        for item in downloaded:
            item.pop("_index", None)

        ok = len(failures) == 0
        return {
            "ok": ok,
            "source_dir": source_path,
            "output_dir": str(output_root),
            "files_total": len(rows),
            "files_downloaded": len(downloaded),
            "files_failed": len(failures),
            "downloaded": downloaded,
            "failures": failures,
            "truncated": truncated,
            "list_pages": list_pages,
        }

    def _resolve_download_destination(
        self,
        *,
        output_path: str | None,
        remote_file_name: str,
        allow_overwrite: bool,
    ) -> Path:
        if output_path:
            destination = Path(output_path)
            if destination.exists() and (not allow_overwrite):
                raise FileExistsError(f"output already exists: {destination}")
            return destination
        default_dir = Path.cwd() / "tmp" / "downloads"
        default_dir.mkdir(parents=True, exist_ok=True)
        destination = default_dir / remote_file_name
        if destination.exists():
            destination = _unique_local_path(destination)
        return destination

    async def run_task_and_wait(
        self,
        *,
        target_node_id: str,
        task: TaskEnvelope,
        timeout_sec: float = 120.0,
        terminal_grace_sec: float = 0.6,
        event_handler: EventHandler | None = None,
    ) -> dict:
        done = asyncio.Event()
        terminal_event: dict | None = None
        user_messages: list[dict] = []
        events: list[dict] = []
        terminal_deadline: float | None = None
        logger.info(
            "run task wait start client_id=%s node_id=%s task_id=%s timeout_sec=%.2f",
            self.client_id,
            target_node_id,
            task.task_id,
            timeout_sec,
        )

        async def _on_event(event: Event) -> None:
            nonlocal terminal_event
            nonlocal terminal_deadline
            if event.task_id != task.task_id:
                return
            event_dict = event.to_dict()
            events.append(event_dict)
            if event_handler is not None:
                await event_handler(event)
            if event.type == "task.user_message":
                user_messages.append(dict(event.payload))
                logger.info(
                    "task user message task_id=%s payload=%s",
                    task.task_id,
                    event.payload,
                )
                if terminal_deadline is not None:
                    done.set()
                return
            if event.type in {"adapter.completed", "adapter.error"}:
                terminal_event = event_dict
                logger.info(
                    "task terminal event task_id=%s type=%s",
                    task.task_id,
                    event.type,
                )
                if terminal_grace_sec <= 0:
                    done.set()
                else:
                    terminal_deadline = monotonic() + terminal_grace_sec
                return

        async def _wait_terminal() -> None:
            while True:
                if done.is_set():
                    return
                if terminal_deadline is not None and monotonic() >= terminal_deadline:
                    done.set()
                    return
                await asyncio.sleep(0.05)

        sub = await self.subscribe_task_events(node_id=target_node_id, handler=_on_event, task_id=task.task_id)
        try:
            await self.submit_task(target_node_id=target_node_id, task=task)
            await asyncio.wait_for(_wait_terminal(), timeout=timeout_sec)
        finally:
            await sub.unsubscribe()

        if terminal_event is None:
            logger.warning("task wait timeout task_id=%s", task.task_id)
            return {
                "ok": False,
                "task_id": task.task_id,
                "status": "timeout",
                "user_messages": user_messages,
                "events": events,
                "assistant_text": _extract_assistant_text(events),
                "terminal_event": None,
            }

        terminal_type = terminal_event.get("type")
        if terminal_type == "adapter.completed":
            status = "succeeded"
            ok = True
            logger.info("task finished task_id=%s status=%s", task.task_id, status)
        else:
            status = "failed"
            ok = False
            logger.error("task finished task_id=%s status=%s", task.task_id, status)
            payload = terminal_event.get("payload", {})
            if isinstance(payload, dict):
                msg = payload.get("message")
                if isinstance(msg, str):
                    code = payload.get("code")
                    duplicated = False
                    for item in user_messages:
                        if (
                            isinstance(item, dict)
                            and item.get("level") == "error"
                            and item.get("message") == msg
                            and item.get("code") == code
                        ):
                            duplicated = True
                            break
                    if not duplicated:
                        user_messages.append({"level": "error", "message": msg, "code": code})

        return {
            "ok": ok,
            "task_id": task.task_id,
            "status": status,
            "user_messages": user_messages,
            "events": events,
            "assistant_text": _extract_assistant_text(events),
            "terminal_event": terminal_event,
        }


def _safe_download_name(source_path: str, download_id: str) -> str:
    normalized = source_path.replace("\\", "/").strip("/")
    if normalized:
        name = normalized.split("/")[-1].strip()
        if name:
            return name
    return f"download-{download_id}"


def _extract_assistant_text(events: list[dict]) -> str:
    for event in reversed(events):
        if event.get("type") == "agent.end":
            text = _text_from_agent_end(event.get("payload"))
            if text:
                return text
    for event in reversed(events):
        if event.get("type") == "agent.turn_end":
            text = _text_from_payload(event.get("payload", {}).get("message"))
            if text:
                return text
    token_text = "".join(
        _token_text_from_payload(event.get("payload", {}).get("text"))
        for event in events
        if event.get("type") == "agent.token"
    ).strip()
    if token_text:
        return token_text
    for event in reversed(events):
        if event.get("type") == "adapter.completed":
            text = _text_from_payload(event.get("payload", {}).get("output"))
            if text:
                return text
    return ""


def _text_from_agent_end(payload: object) -> str:
    if not isinstance(payload, dict):
        return ""
    messages = payload.get("messages")
    if not isinstance(messages, list):
        return ""
    for item in reversed(messages):
        if not isinstance(item, dict):
            continue
        role = str(item.get("role", "")).lower()
        if role and role != "assistant":
            continue
        text = _text_from_payload(item.get("content") or item.get("message") or item.get("text"))
        if text:
            return text
    return ""


def _text_from_payload(value: object) -> str:
    if isinstance(value, str):
        return value.strip()
    if isinstance(value, list):
        return "\n".join(filter(None, (_text_from_payload(item) for item in value))).strip()
    if isinstance(value, dict):
        return _text_from_payload(
            value.get("text")
            or value.get("content")
            or value.get("message")
            or value.get("output")
        )
    return ""


def _token_text_from_payload(value: object) -> str:
    if isinstance(value, str):
        return value
    return _text_from_payload(value)


def _unique_local_path(path: Path) -> Path:
    stem = path.stem
    suffix = path.suffix
    for i in range(1, 10000):
        candidate = path.with_name(f"{stem}-{i}{suffix}")
        if not candidate.exists():
            return candidate
    raise RuntimeError("too_many_local_name_collisions")


def _safe_relative_download_path(raw: str) -> Path:
    normalized = raw.strip().replace("\\", "/")
    if not normalized:
        raise ValueError("empty_relative_path")
    parts = [part for part in normalized.split("/") if part not in {"", "."}]
    if not parts:
        raise ValueError("invalid_relative_path")
    if any(part == ".." for part in parts):
        raise ValueError("path_traversal_not_allowed")
    if any(":" in part for part in parts):
        raise ValueError("drive_prefix_not_allowed")
    return Path(*parts)
