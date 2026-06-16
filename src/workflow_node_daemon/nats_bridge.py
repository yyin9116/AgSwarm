from __future__ import annotations

import asyncio
import base64
import hashlib
import json
import logging
from dataclasses import asdict
from datetime import datetime
from pathlib import Path
from time import monotonic
from typing import Any
from uuid import uuid4

from workflow_node_daemon.daemon import WorkflowNodeDaemon
from workflow_node_daemon.peer import PeerNodeHost
from workflow_runtime.protocol import TaskEnvelope
from workflow_transport import Subscription, TransportProvider, subjects

logger = logging.getLogger(__name__)


class _FileTransferSession:
    def __init__(
        self,
        *,
        transfer_id: str,
        file_name: str,
        total_chunks: int,
        chunk_size: int,
        expected_size_bytes: int,
        declared_sha256: str,
        meta_path: Path,
        chunks_dir: Path,
        temp_path: Path,
        final_path: Path,
        received_indexes: set[int] | None = None,
    ) -> None:
        self.transfer_id = transfer_id
        self.file_name = file_name
        self.total_chunks = total_chunks
        self.chunk_size = chunk_size
        self.expected_size_bytes = expected_size_bytes
        self.declared_sha256 = declared_sha256
        self.meta_path = meta_path
        self.chunks_dir = chunks_dir
        self.temp_path = temp_path
        self.final_path = final_path
        self.received_indexes = received_indexes or set()

    @property
    def received_chunks(self) -> int:
        return len(self.received_indexes)


class _FileDownloadSession:
    def __init__(
        self,
        *,
        download_id: str,
        source_path: Path,
        file_name: str,
        size_bytes: int,
        sha256: str,
        chunk_size: int,
        total_chunks: int,
        created_monotonic: float,
    ) -> None:
        self.download_id = download_id
        self.source_path = source_path
        self.file_name = file_name
        self.size_bytes = size_bytes
        self.sha256 = sha256
        self.chunk_size = chunk_size
        self.total_chunks = total_chunks
        self.created_monotonic = created_monotonic
        self.last_access_monotonic = created_monotonic


class NatsDaemonBridge:
    def __init__(
        self,
        *,
        node_id: str,
        daemon: WorkflowNodeDaemon,
        transport: TransportProvider,
        status_interval_sec: float = 1.0,
        event_poll_interval_sec: float = 0.2,
        incoming_root: str | None = None,
        manage_transport: bool = True,
    ) -> None:
        self.node_id = node_id
        self.daemon = daemon
        self.transport = transport
        self.status_interval_sec = status_interval_sec
        self.event_poll_interval_sec = event_poll_interval_sec
        root = Path(incoming_root) if incoming_root else Path(".workflow_node_data")
        self.incoming_root = root / self.node_id / "incoming"
        self.config_root = root / self.node_id / "config"
        self.manage_transport = manage_transport

        self._running = False
        self._subscriptions: list[Subscription] = []
        self._tasks: list[asyncio.Task[None]] = []
        self._last_sequence_by_task: dict[str, int] = {}
        self._transfer_sessions: dict[str, _FileTransferSession] = {}
        self._transfer_lock = asyncio.Lock()
        self._download_sessions: dict[str, _FileDownloadSession] = {}
        self._download_lock = asyncio.Lock()
        self._config_sync_lock = asyncio.Lock()
        self._config_sync_state: dict[str, Any] = {
            "config_sync_revision": 0,
            "config_synced_at": None,
            "config_synced_by": None,
            "config_sync_digest": None,
            "config_sync_sections": [],
        }
        self._peer_host = PeerNodeHost(self.daemon.peer_config)

    async def start(self) -> None:
        if self._running:
            return
        self._running = True
        logger.info(
            "bridge start node_id=%s status_interval=%.2fs event_poll_interval=%.2fs incoming_root=%s manage_transport=%s",
            self.node_id,
            self.status_interval_sec,
            self.event_poll_interval_sec,
            str(self.incoming_root),
            self.manage_transport,
        )
        if self.manage_transport:
            await self.transport.connect()

        self._subscriptions.append(
            await self.transport.subscribe(subjects.task_submit(self.node_id), self._on_submit)
        )
        self._subscriptions.append(
            await self.transport.subscribe(
                subjects.node_snapshot_request(self.node_id),
                self._on_snapshot_request,
            )
        )
        self._subscriptions.append(
            await self.transport.subscribe(
                subjects.node_config_sync_request(self.node_id),
                self._on_config_sync_request,
            )
        )
        self._subscriptions.append(
            await self.transport.subscribe(
                subjects.peer_command_request(self.node_id),
                self._on_peer_command_request,
            )
        )
        self._subscriptions.append(
            await self.transport.subscribe(
                subjects.file_prepare_request(self.node_id),
                self._on_file_prepare_request,
            )
        )
        self._subscriptions.append(
            await self.transport.subscribe(
                subjects.file_chunk_wildcard(self.node_id),
                self._on_file_chunk,
            )
        )
        self._subscriptions.append(
            await self.transport.subscribe(
                subjects.file_commit_request(self.node_id),
                self._on_file_commit_request,
            )
        )
        self._subscriptions.append(
            await self.transport.subscribe(
                subjects.file_download_prepare_request(self.node_id),
                self._on_file_download_prepare_request,
            )
        )
        self._subscriptions.append(
            await self.transport.subscribe(
                subjects.file_download_chunk_request(self.node_id),
                self._on_file_download_chunk_request,
            )
        )
        self._subscriptions.append(
            await self.transport.subscribe(
                subjects.file_download_list_request(self.node_id),
                self._on_file_download_list_request,
            )
        )

        self._tasks.append(asyncio.create_task(self._status_loop(), name="bridge-status-loop"))
        self._tasks.append(asyncio.create_task(self._event_loop(), name="bridge-event-loop"))
        logger.info("bridge started node_id=%s subscriptions=%d", self.node_id, len(self._subscriptions))

    async def stop(self) -> None:
        if not self._running:
            return
        self._running = False
        logger.info("bridge stop node_id=%s", self.node_id)

        for task in self._tasks:
            task.cancel()
        await asyncio.gather(*self._tasks, return_exceptions=True)
        self._tasks.clear()

        for sub in self._subscriptions:
            await sub.unsubscribe()
        self._subscriptions.clear()

        if self.manage_transport:
            await self.transport.close()

    async def _on_submit(self, _: str, payload: dict, __: str | None) -> None:
        task_payload = payload.get("task")
        if not isinstance(task_payload, dict):
            logger.warning("bridge submit ignored node_id=%s reason=invalid_task_payload", self.node_id)
            return
        envelope = TaskEnvelope.from_dict(task_payload)
        logger.info(
            "bridge submit received node_id=%s task_id=%s adapter=%s",
            self.node_id,
            envelope.task_id,
            envelope.adapter.name,
        )
        await self.daemon.submit(envelope)

    async def _on_snapshot_request(self, _: str, __: dict, reply_subject: str | None) -> None:
        if not reply_subject:
            return
        snapshot = asdict(self.daemon.get_node_snapshot())
        snapshot["node_id"] = self.node_id
        snapshot.update(self._config_sync_state)
        snapshot["peer_node"] = self._peer_host.config.describe(adapters=self.daemon.runtime.adapter_names())
        await self.transport.publish(reply_subject, snapshot)

    async def _on_config_sync_request(self, _: str, payload: dict, reply_subject: str | None) -> None:
        if not reply_subject:
            return
        config_payload = payload.get("config_payload")
        from_client_id = str(payload.get("from_client_id", "")).strip() or "unknown-client"
        if not isinstance(config_payload, dict):
            await self.transport.publish(
                reply_subject,
                {"ok": False, "error": "invalid_config_payload"},
            )
            return

        self.config_root.mkdir(parents=True, exist_ok=True)
        normalized = json.dumps(config_payload, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
        digest = hashlib.sha256(normalized.encode("utf-8")).hexdigest()
        now_iso = datetime.now().isoformat(timespec="seconds")

        async with self._config_sync_lock:
            next_revision = int(self._config_sync_state.get("config_sync_revision", 0)) + 1
            latest_path = self.config_root / "node-config-sync.latest.json"
            revision_path = self.config_root / f"node-config-sync.r{next_revision:04d}.json"
            envelope = {
                "node_id": self.node_id,
                "revision": next_revision,
                "synced_at": now_iso,
                "synced_by": from_client_id,
                "digest": digest,
                "config_payload": config_payload,
            }
            revision_path.write_text(json.dumps(envelope, ensure_ascii=False, indent=2), encoding="utf-8")
            latest_path.write_text(json.dumps(envelope, ensure_ascii=False, indent=2), encoding="utf-8")
            self._config_sync_state = {
                "config_sync_revision": next_revision,
                "config_synced_at": now_iso,
                "config_synced_by": from_client_id,
                "config_sync_digest": digest,
                "config_sync_sections": sorted(str(x) for x in config_payload.keys()),
            }

        logger.info(
            "config sync applied node_id=%s revision=%d synced_by=%s digest=%s",
            self.node_id,
            next_revision,
            from_client_id,
            digest,
        )
        await self.transport.publish(
            reply_subject,
            {
                "ok": True,
                "node_id": self.node_id,
                "config_sync_revision": next_revision,
                "config_synced_at": now_iso,
                "config_synced_by": from_client_id,
                "config_sync_digest": digest,
                "saved_path": str(latest_path.resolve()),
            },
        )

    async def _on_peer_command_request(
        self,
        _: str,
        payload: dict,
        reply_subject: str | None,
    ) -> None:
        if not reply_subject:
            return
        command = str(payload.get("command") or "")
        if not command.strip():
            await self.transport.publish(
                reply_subject,
                {"ok": False, "error": "missing_peer_command"},
            )
            return
        command_payload = payload.get("payload")
        if not isinstance(command_payload, dict):
            command_payload = {}
        response = await self._peer_host.handle_command(
            command=command,
            payload=command_payload,
            adapters=self.daemon.runtime.adapter_names(),
        )
        response["node_id"] = self.node_id
        await self.transport.publish(reply_subject, response)

    async def _on_file_prepare_request(
        self,
        _: str,
        payload: dict,
        reply_subject: str | None,
    ) -> None:
        if not reply_subject:
            return

        try:
            transfer_id = str(payload["transfer_id"])
            file_name = str(payload["file_name"])
            total_chunks = int(payload["total_chunks"])
            chunk_size = int(payload["chunk_size"])
            size_bytes = int(payload["size_bytes"])
            declared_sha256 = str(payload["sha256"])
        except (KeyError, TypeError, ValueError):
            await self.transport.publish(
                reply_subject,
                {"accepted": False, "error": "invalid_prepare_payload"},
            )
            logger.warning("file prepare rejected node_id=%s reason=invalid_prepare_payload", self.node_id)
            return

        if total_chunks < 0 or size_bytes < 0 or chunk_size <= 0:
            await self.transport.publish(
                reply_subject,
                {"accepted": False, "error": "invalid_size_or_chunks"},
            )
            logger.warning("file prepare rejected node_id=%s reason=invalid_size_or_chunks", self.node_id)
            return

        try:
            safe_rel_path = self._safe_relative_path(file_name)
        except ValueError:
            await self.transport.publish(
                reply_subject,
                {"accepted": False, "error": "invalid_file_name"},
            )
            logger.warning("file prepare rejected node_id=%s transfer_id=%s reason=invalid_file_name", self.node_id, transfer_id)
            return
        safe_name = safe_rel_path.as_posix()
        self.incoming_root.mkdir(parents=True, exist_ok=True)
        meta_path = self.incoming_root / f"{transfer_id}.meta.json"
        chunks_dir = self.incoming_root / f"{transfer_id}.chunks"
        temp_path = self.incoming_root / f"{transfer_id}.part"
        final_path = self.incoming_root / safe_rel_path

        async with self._transfer_lock:
            existing = self._transfer_sessions.get(transfer_id)
            if existing is not None:
                if not self._metadata_matches(existing, safe_name, total_chunks, chunk_size, size_bytes, declared_sha256):
                    await self.transport.publish(
                        reply_subject,
                        {"accepted": False, "error": "transfer_metadata_mismatch"},
                    )
                    logger.warning(
                        "file prepare rejected node_id=%s transfer_id=%s reason=transfer_metadata_mismatch",
                        self.node_id,
                        transfer_id,
                    )
                    return
                missing = self._missing_indexes(existing.total_chunks, existing.received_indexes)
                await self.transport.publish(
                    reply_subject,
                    {
                        "accepted": True,
                        "transfer_id": transfer_id,
                        "incoming_dir": str(self.incoming_root.resolve()),
                        "resume": True,
                        "received_chunks": existing.received_chunks,
                        "missing_indexes": missing,
                    },
                )
                logger.info(
                    "file prepare resume node_id=%s transfer_id=%s received=%d total=%d",
                    self.node_id,
                    transfer_id,
                    existing.received_chunks,
                    existing.total_chunks,
                )
                return

            if meta_path.exists():
                try:
                    meta = json.loads(meta_path.read_text(encoding="utf-8"))
                except Exception:
                    await self.transport.publish(
                        reply_subject,
                        {"accepted": False, "error": "invalid_transfer_meta"},
                    )
                    logger.warning(
                        "file prepare rejected node_id=%s transfer_id=%s reason=invalid_transfer_meta",
                        self.node_id,
                        transfer_id,
                    )
                    return
                if not self._meta_matches_payload(meta, safe_name, total_chunks, chunk_size, size_bytes, declared_sha256):
                    await self.transport.publish(
                        reply_subject,
                        {"accepted": False, "error": "transfer_metadata_mismatch"},
                    )
                    logger.warning(
                        "file prepare rejected node_id=%s transfer_id=%s reason=transfer_metadata_mismatch",
                        self.node_id,
                        transfer_id,
                    )
                    return
                received = self._read_received_indexes(chunks_dir, total_chunks)
                session = _FileTransferSession(
                    transfer_id=transfer_id,
                    file_name=safe_name,
                    total_chunks=total_chunks,
                    chunk_size=chunk_size,
                    expected_size_bytes=size_bytes,
                    declared_sha256=declared_sha256,
                    meta_path=meta_path,
                    chunks_dir=chunks_dir,
                    temp_path=temp_path,
                    final_path=final_path,
                    received_indexes=received,
                )
                self._transfer_sessions[transfer_id] = session
                missing = self._missing_indexes(total_chunks, received)
                await self.transport.publish(
                    reply_subject,
                    {
                        "accepted": True,
                        "transfer_id": transfer_id,
                        "incoming_dir": str(self.incoming_root.resolve()),
                        "resume": True,
                        "received_chunks": session.received_chunks,
                        "missing_indexes": missing,
                    },
                )
                logger.info(
                    "file prepare resumed-from-meta node_id=%s transfer_id=%s received=%d total=%d",
                    self.node_id,
                    transfer_id,
                    session.received_chunks,
                    session.total_chunks,
                )
                return

            chunks_dir.mkdir(parents=True, exist_ok=True)
            meta = {
                "transfer_id": transfer_id,
                "file_name": safe_name,
                "total_chunks": total_chunks,
                "chunk_size": chunk_size,
                "size_bytes": size_bytes,
                "sha256": declared_sha256,
            }
            meta_path.write_text(json.dumps(meta, ensure_ascii=False), encoding="utf-8")
            session = _FileTransferSession(
                transfer_id=transfer_id,
                file_name=safe_name,
                total_chunks=total_chunks,
                chunk_size=chunk_size,
                expected_size_bytes=size_bytes,
                declared_sha256=declared_sha256,
                meta_path=meta_path,
                chunks_dir=chunks_dir,
                temp_path=temp_path,
                final_path=final_path,
            )
            self._transfer_sessions[transfer_id] = session

        await self.transport.publish(
            reply_subject,
            {
                "accepted": True,
                "transfer_id": transfer_id,
                "incoming_dir": str(self.incoming_root.resolve()),
                "resume": False,
                "received_chunks": 0,
                "missing_indexes": list(range(total_chunks)),
            },
        )
        logger.info(
            "file prepare accepted node_id=%s transfer_id=%s file=%s total_chunks=%d chunk_size=%d size=%d",
            self.node_id,
            transfer_id,
            safe_name,
            total_chunks,
            chunk_size,
            size_bytes,
        )

    async def _on_file_chunk(self, _: str, payload: dict, __: str | None) -> None:
        try:
            transfer_id = str(payload["transfer_id"])
            index = int(payload["index"])
            total_chunks = int(payload["total_chunks"])
            data_b64 = str(payload["data_b64"])
        except (KeyError, TypeError, ValueError):
            logger.debug("file chunk ignored node_id=%s reason=invalid_chunk_payload", self.node_id)
            return

        async with self._transfer_lock:
            session = self._transfer_sessions.get(transfer_id)
            if session is None:
                return
            if total_chunks != session.total_chunks:
                return
            if index < 0 or index >= session.total_chunks:
                return
            if index in session.received_indexes:
                return
            try:
                chunk = base64.b64decode(data_b64.encode("ascii"))
            except Exception:
                logger.debug("file chunk ignored node_id=%s transfer_id=%s reason=invalid_base64", self.node_id, transfer_id)
                return
            session.chunks_dir.mkdir(parents=True, exist_ok=True)
            chunk_path = session.chunks_dir / f"{index}.chunk"
            with chunk_path.open("wb") as f:
                f.write(chunk)
            session.received_indexes.add(index)
            logger.debug(
                "file chunk received node_id=%s transfer_id=%s index=%d/%d",
                self.node_id,
                transfer_id,
                index + 1,
                session.total_chunks,
            )

    async def _on_file_commit_request(
        self,
        _: str,
        payload: dict,
        reply_subject: str | None,
    ) -> None:
        if not reply_subject:
            return

        transfer_id = payload.get("transfer_id")
        if not isinstance(transfer_id, str):
            await self.transport.publish(reply_subject, {"ok": False, "error": "missing_transfer_id"})
            logger.warning("file commit rejected node_id=%s reason=missing_transfer_id", self.node_id)
            return

        expected_sha256 = payload.get("expected_sha256")
        expected_size_bytes = payload.get("expected_size_bytes")

        async with self._transfer_lock:
            session = self._transfer_sessions.get(transfer_id)
            if session is None:
                await self.transport.publish(
                    reply_subject,
                    {"ok": False, "error": "transfer_not_found"},
                )
                logger.warning(
                    "file commit rejected node_id=%s transfer_id=%s reason=transfer_not_found",
                    self.node_id,
                    transfer_id,
                )
                return

            try:
                if session.received_chunks != session.total_chunks:
                    raise ValueError("incomplete_chunks")
                hasher = hashlib.sha256()
                received_size = 0
                with session.temp_path.open("wb") as out:
                    for idx in range(session.total_chunks):
                        chunk_path = session.chunks_dir / f"{idx}.chunk"
                        if not chunk_path.exists():
                            raise ValueError("missing_chunk_file")
                        data = chunk_path.read_bytes()
                        out.write(data)
                        hasher.update(data)
                        received_size += len(data)
                if int(expected_size_bytes) != received_size:
                    raise ValueError("size_mismatch")
                actual_sha256 = hasher.hexdigest()
                if str(expected_sha256) != actual_sha256:
                    raise ValueError("sha256_mismatch")

                final_path = self._unique_target_path(session.final_path)
                final_path.parent.mkdir(parents=True, exist_ok=True)
                if not session.temp_path.exists():
                    raise FileNotFoundError(f"temp_file_missing:{session.temp_path}")
                last_replace_error: Exception | None = None
                for retry in range(3):
                    try:
                        session.temp_path.replace(final_path)
                        last_replace_error = None
                        break
                    except (PermissionError, FileNotFoundError) as exc:
                        last_replace_error = exc
                        if retry < 2:
                            await asyncio.sleep(0.05 * (retry + 1))
                            continue
                        break
                if last_replace_error is not None:
                    raise last_replace_error
                self._cleanup_transfer_storage(session)
                self._transfer_sessions.pop(transfer_id, None)
                await self.transport.publish(
                    reply_subject,
                    {
                        "ok": True,
                        "transfer_id": transfer_id,
                        "saved_path": str(final_path.resolve()),
                        "saved_rel_path": final_path.relative_to(self.incoming_root).as_posix(),
                        "size_bytes": received_size,
                        "sha256": actual_sha256,
                    },
                )
                logger.info(
                    "file commit success node_id=%s transfer_id=%s saved_rel_path=%s size=%d",
                    self.node_id,
                    transfer_id,
                    final_path.relative_to(self.incoming_root).as_posix(),
                    received_size,
                )
            except Exception as exc:
                session.temp_path.unlink(missing_ok=True)
                self._transfer_sessions.pop(transfer_id, None)
                await self.transport.publish(
                    reply_subject,
                    {"ok": False, "transfer_id": transfer_id, "error": str(exc)},
                )
                logger.exception(
                    "file commit failed node_id=%s transfer_id=%s error=%s",
                    self.node_id,
                    transfer_id,
                    exc,
                )

    async def _on_file_download_prepare_request(
        self,
        _: str,
        payload: dict,
        reply_subject: str | None,
    ) -> None:
        if not reply_subject:
            return
        source_raw = payload.get("source_path")
        if not isinstance(source_raw, str) or not source_raw.strip():
            await self.transport.publish(reply_subject, {"ok": False, "error": "missing_source_path"})
            return
        try:
            chunk_size = int(payload.get("chunk_size", 256 * 1024))
        except (TypeError, ValueError):
            await self.transport.publish(reply_subject, {"ok": False, "error": "invalid_chunk_size"})
            return
        if chunk_size <= 0 or chunk_size > 4 * 1024 * 1024:
            await self.transport.publish(reply_subject, {"ok": False, "error": "invalid_chunk_size"})
            return

        download_id = payload.get("download_id")
        if not isinstance(download_id, str) or not download_id.strip():
            download_id = str(uuid4())
        source_path = self._resolve_download_source_path(source_raw.strip())
        if source_path is None:
            await self.transport.publish(reply_subject, {"ok": False, "error": "invalid_source_path"})
            return
        if not source_path.exists():
            await self.transport.publish(reply_subject, {"ok": False, "error": "source_not_found"})
            return
        if not source_path.is_file():
            await self.transport.publish(reply_subject, {"ok": False, "error": "source_not_file"})
            return

        file_size = source_path.stat().st_size
        sha256 = self._sha256_of_file(source_path)
        total_chunks = (file_size + chunk_size - 1) // chunk_size if file_size else 0
        now_ts = monotonic()

        async with self._download_lock:
            self._prune_download_sessions(now_ts)
            self._download_sessions[download_id] = _FileDownloadSession(
                download_id=download_id,
                source_path=source_path,
                file_name=source_path.name,
                size_bytes=file_size,
                sha256=sha256,
                chunk_size=chunk_size,
                total_chunks=total_chunks,
                created_monotonic=now_ts,
            )

        await self.transport.publish(
            reply_subject,
            {
                "ok": True,
                "download_id": download_id,
                "source_path": str(source_path),
                "file_name": source_path.name,
                "size_bytes": file_size,
                "sha256": sha256,
                "chunk_size": chunk_size,
                "total_chunks": total_chunks,
            },
        )
        logger.info(
            "file download prepare node_id=%s download_id=%s source=%s size=%d chunk_size=%d total_chunks=%d",
            self.node_id,
            download_id,
            str(source_path),
            file_size,
            chunk_size,
            total_chunks,
        )

    async def _on_file_download_chunk_request(
        self,
        _: str,
        payload: dict,
        reply_subject: str | None,
    ) -> None:
        if not reply_subject:
            return
        download_id = payload.get("download_id")
        if not isinstance(download_id, str) or not download_id.strip():
            await self.transport.publish(reply_subject, {"ok": False, "error": "missing_download_id"})
            return
        try:
            index = int(payload.get("index"))
        except (TypeError, ValueError):
            await self.transport.publish(reply_subject, {"ok": False, "error": "invalid_index"})
            return

        async with self._download_lock:
            session = self._download_sessions.get(download_id)
            if session is None:
                await self.transport.publish(reply_subject, {"ok": False, "error": "download_session_not_found"})
                return
            if index < 0 or index >= session.total_chunks:
                await self.transport.publish(
                    reply_subject,
                    {
                        "ok": False,
                        "error": "index_out_of_range",
                        "total_chunks": session.total_chunks,
                    },
                )
                return
            session.last_access_monotonic = monotonic()

        offset = index * session.chunk_size
        with session.source_path.open("rb") as f:
            f.seek(offset)
            chunk = f.read(session.chunk_size)
        await self.transport.publish(
            reply_subject,
            {
                "ok": True,
                "download_id": download_id,
                "index": index,
                "total_chunks": session.total_chunks,
                "data_b64": base64.b64encode(chunk).decode("ascii"),
                "chunk_size": len(chunk),
            },
        )

    async def _on_file_download_list_request(
        self,
        _: str,
        payload: dict,
        reply_subject: str | None,
    ) -> None:
        if not reply_subject:
            return
        source_raw = payload.get("source_path")
        if not isinstance(source_raw, str) or not source_raw.strip():
            await self.transport.publish(reply_subject, {"ok": False, "error": "missing_source_path"})
            return
        source_path = self._resolve_download_source_path(source_raw.strip())
        if source_path is None:
            await self.transport.publish(reply_subject, {"ok": False, "error": "invalid_source_path"})
            return
        if not source_path.exists():
            await self.transport.publish(reply_subject, {"ok": False, "error": "source_not_found"})
            return
        if not source_path.is_dir():
            await self.transport.publish(reply_subject, {"ok": False, "error": "source_not_directory"})
            return
        try:
            max_files = int(payload.get("max_files", 2000))
        except (TypeError, ValueError):
            max_files = 2000
        max_files = max(1, min(max_files, 20000))
        try:
            cursor = int(payload.get("cursor", 0))
        except (TypeError, ValueError):
            cursor = 0
        cursor = max(0, cursor)
        try:
            page_size = int(payload.get("page_size", min(max_files, 500)))
        except (TypeError, ValueError):
            page_size = min(max_files, 500)
        page_size = max(1, min(page_size, 5000))

        files, has_more = self._iter_download_files_page(
            source_path,
            cursor=cursor,
            page_size=page_size,
            max_files=max_files,
        )
        next_cursor = (cursor + len(files)) if has_more else None
        await self.transport.publish(
            reply_subject,
            {
                "ok": True,
                "source_path": str(source_path),
                "file_count": len(files),
                "files": files,
                "cursor": cursor,
                "page_size": page_size,
                "next_cursor": next_cursor,
                "has_more": has_more,
                "truncated": has_more,
            },
        )
        logger.info(
            "file download list node_id=%s source=%s cursor=%d page_size=%d file_count=%d has_more=%s",
            self.node_id,
            str(source_path),
            cursor,
            page_size,
            len(files),
            has_more,
        )

    async def _status_loop(self) -> None:
        while self._running:
            payload = asdict(self.daemon.get_node_snapshot())
            payload["node_id"] = self.node_id
            payload.update(self._config_sync_state)
            payload["peer_node"] = self._peer_host.config.describe(adapters=self.daemon.runtime.adapter_names())
            await self.transport.publish(subjects.node_status(self.node_id), payload)
            await asyncio.sleep(self.status_interval_sec)

    async def _event_loop(self) -> None:
        while self._running:
            snapshots = self.daemon.list_snapshots()
            for snapshot in snapshots:
                events = self.daemon.get_task_events(snapshot.task_id)
                last_seen = self._last_sequence_by_task.get(snapshot.task_id, 0)
                for event in events:
                    seq = int(event.get("sequence", 0))
                    if seq <= last_seen:
                        continue
                    await self.transport.publish(
                        subjects.task_events(self.node_id, snapshot.task_id),
                        event,
                    )
                    self._last_sequence_by_task[snapshot.task_id] = seq
                    logger.debug(
                        "event published node_id=%s task_id=%s seq=%d type=%s",
                        self.node_id,
                        snapshot.task_id,
                        seq,
                        event.get("type"),
                    )
            await asyncio.sleep(self.event_poll_interval_sec)

    def _resolve_download_source_path(self, source: str) -> Path | None:
        candidate = Path(source)
        if candidate.is_absolute():
            return candidate.resolve()
        try:
            safe_rel = self._safe_relative_path(source)
        except ValueError:
            return None
        return (self.incoming_root / safe_rel).resolve()

    def _sha256_of_file(self, path: Path) -> str:
        hasher = hashlib.sha256()
        with path.open("rb") as f:
            for block in iter(lambda: f.read(1024 * 1024), b""):
                hasher.update(block)
        return hasher.hexdigest()

    def _iter_download_files_page(
        self,
        source_dir: Path,
        *,
        cursor: int,
        page_size: int,
        max_files: int,
    ) -> tuple[list[dict[str, Any]], bool]:
        items: list[dict[str, Any]] = []
        file_index = 0
        has_more = False
        for path in sorted(source_dir.rglob("*")):
            if not path.is_file():
                continue
            if file_index >= max_files:
                has_more = False
                break
            if file_index < cursor:
                file_index += 1
                continue
            if len(items) >= page_size:
                has_more = True
                break
            rel_path = path.relative_to(source_dir).as_posix()
            try:
                size_bytes = path.stat().st_size
            except OSError:
                size_bytes = -1
            items.append(
                {
                    "source_path": str(path.resolve()),
                    "relative_path": rel_path,
                    "size_bytes": size_bytes,
                }
            )
            file_index += 1
        return items, has_more

    def _prune_download_sessions(self, now_ts: float, *, max_age_sec: float = 1800.0, max_items: int = 256) -> None:
        stale = [
            key
            for key, session in self._download_sessions.items()
            if (now_ts - session.last_access_monotonic) > max_age_sec
        ]
        for key in stale:
            self._download_sessions.pop(key, None)
        if len(self._download_sessions) <= max_items:
            return
        sorted_items = sorted(
            self._download_sessions.items(),
            key=lambda item: item[1].last_access_monotonic,
        )
        overflow = len(self._download_sessions) - max_items
        for key, _ in sorted_items[:overflow]:
            self._download_sessions.pop(key, None)

    def _safe_relative_path(self, file_name: str) -> Path:
        raw = file_name.strip().replace("\\", "/")
        if not raw:
            return Path(f"file-{uuid4().hex}")
        parts = [part for part in raw.split("/") if part not in {"", "."}]
        if not parts:
            return Path(f"file-{uuid4().hex}")
        if any(part == ".." for part in parts):
            raise ValueError("path traversal is not allowed")
        if any(":" in part for part in parts):
            raise ValueError("drive prefix is not allowed")
        return Path(*parts)

    def _unique_target_path(self, path: Path) -> Path:
        if not path.exists():
            return path
        stem = path.stem
        suffix = path.suffix
        for i in range(1, 10000):
            candidate = path.with_name(f"{stem}-{i}{suffix}")
            if not candidate.exists():
                return candidate
        raise RuntimeError("too_many_name_collisions")

    def _metadata_matches(
        self,
        session: _FileTransferSession,
        file_name: str,
        total_chunks: int,
        chunk_size: int,
        size_bytes: int,
        sha256: str,
    ) -> bool:
        return (
            session.file_name == file_name
            and session.total_chunks == total_chunks
            and session.chunk_size == chunk_size
            and session.expected_size_bytes == size_bytes
            and session.declared_sha256 == sha256
        )

    def _meta_matches_payload(
        self,
        meta: dict[str, Any],
        file_name: str,
        total_chunks: int,
        chunk_size: int,
        size_bytes: int,
        sha256: str,
    ) -> bool:
        try:
            return (
                str(meta.get("file_name")) == file_name
                and int(meta.get("total_chunks")) == total_chunks
                and int(meta.get("chunk_size")) == chunk_size
                and int(meta.get("size_bytes")) == size_bytes
                and str(meta.get("sha256")) == sha256
            )
        except (TypeError, ValueError):
            return False

    def _read_received_indexes(self, chunks_dir: Path, total_chunks: int) -> set[int]:
        if not chunks_dir.exists():
            return set()
        indexes: set[int] = set()
        for path in chunks_dir.glob("*.chunk"):
            try:
                idx = int(path.stem)
            except ValueError:
                continue
            if 0 <= idx < total_chunks:
                indexes.add(idx)
        return indexes

    def _missing_indexes(self, total_chunks: int, received_indexes: set[int]) -> list[int]:
        return [idx for idx in range(total_chunks) if idx not in received_indexes]

    def _cleanup_transfer_storage(self, session: _FileTransferSession) -> None:
        try:
            session.meta_path.unlink(missing_ok=True)
        except OSError:
            logger.debug("cleanup ignored meta unlink error path=%s", session.meta_path, exc_info=True)
        if session.chunks_dir.exists():
            for chunk_file in session.chunks_dir.glob("*.chunk"):
                try:
                    chunk_file.unlink(missing_ok=True)
                except OSError:
                    logger.debug("cleanup ignored chunk unlink error path=%s", chunk_file, exc_info=True)
            try:
                session.chunks_dir.rmdir()
            except OSError:
                pass
