from __future__ import annotations

import json
import logging
from urllib.parse import SplitResult, urlsplit, urlunsplit
from typing import Any

from workflow_transport.base import MessageHandler, Subscription, TransportProvider

logger = logging.getLogger(__name__)


class NatsSubscription(Subscription):
    def __init__(self, subscription: Any) -> None:
        self._subscription = subscription

    async def unsubscribe(self) -> None:
        await self._subscription.unsubscribe()


class NatsTransportProvider(TransportProvider):
    def __init__(self, server_url: str = "nats://127.0.0.1:4222") -> None:
        self.server_url = normalize_nats_server_url(server_url)
        self._nc: Any | None = None

    async def connect(self) -> None:
        if self._nc is not None:
            return
        try:
            from nats.aio.client import Client as NatsClient
        except ImportError as exc:  # pragma: no cover
            raise RuntimeError(
                "nats-py is not installed. Install with: pip install 'workflow-runtime[nats]'"
            ) from exc

        logger.info("connecting to nats server_url=%s", mask_nats_server_url(self.server_url))
        nc = NatsClient()

        async def _error_cb(exc: Exception) -> None:
            logger.error("nats async error: %s", exc)

        async def _disconnected_cb() -> None:
            logger.warning("nats disconnected server_url=%s", self.server_url)

        async def _reconnected_cb() -> None:
            logger.info("nats reconnected server_url=%s", self.server_url)

        async def _closed_cb() -> None:
            logger.info("nats connection closed server_url=%s", self.server_url)

        connect_kwargs = {
            "servers": [self.server_url],
            "connect_timeout": 3,
            "max_reconnect_attempts": 2,
            "reconnect_time_wait": 0.5,
            "error_cb": _error_cb,
            "disconnected_cb": _disconnected_cb,
            "reconnected_cb": _reconnected_cb,
            "closed_cb": _closed_cb,
        }
        try:
            await nc.connect(**connect_kwargs)
        except TypeError:
            # Backward compatibility for older nats-py versions that do not
            # support reconnect tuning kwargs.
            connect_kwargs.pop("max_reconnect_attempts", None)
            connect_kwargs.pop("reconnect_time_wait", None)
            await nc.connect(**connect_kwargs)
        self._nc = nc
        logger.info("nats connected server_url=%s", mask_nats_server_url(self.server_url))

    async def close(self) -> None:
        if self._nc is None:
            return
        logger.info("closing nats transport")
        await self._nc.drain()
        await self._nc.close()
        self._nc = None

    async def publish(self, subject: str, payload: dict[str, Any]) -> None:
        nc = self._require_client()
        raw = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        await nc.publish(subject, raw)
        logger.debug("published subject=%s bytes=%d", subject, len(raw))

    async def subscribe(self, subject: str, handler: MessageHandler) -> Subscription:
        nc = self._require_client()

        async def _on_message(msg: Any) -> None:
            payload: dict[str, Any] = {}
            if msg.data:
                try:
                    payload = json.loads(msg.data.decode("utf-8"))
                except Exception:
                    logger.exception("invalid message payload subject=%s", msg.subject)
                    return
            reply_subject = msg.reply if msg.reply else None
            await handler(msg.subject, payload, reply_subject)

        sub = await nc.subscribe(subject, cb=_on_message)
        logger.info("subscribed subject=%s", subject)
        return NatsSubscription(sub)

    async def request(
        self,
        subject: str,
        payload: dict[str, Any],
        timeout_sec: float = 2.0,
    ) -> dict[str, Any]:
        nc = self._require_client()
        raw = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        logger.debug("request subject=%s timeout=%.2fs bytes=%d", subject, timeout_sec, len(raw))
        msg = await nc.request(subject, raw, timeout=timeout_sec)
        if not msg.data:
            return {}
        data = json.loads(msg.data.decode("utf-8"))
        logger.debug("response subject=%s keys=%s", subject, sorted(data.keys()))
        return data

    def _require_client(self) -> Any:
        if self._nc is None:
            raise RuntimeError("Transport is not connected.")
        return self._nc


def normalize_nats_server_url(server_url: str) -> str:
    text = str(server_url or "").strip()
    if not text:
        raise ValueError("NATS server URL is empty.")
    parsed = urlsplit(text)
    if parsed.scheme not in {"nats", "tls"}:
        raise ValueError(f"Unsupported NATS URL scheme: {parsed.scheme or '<empty>'}")
    if not parsed.hostname:
        raise ValueError("NATS URL host is missing.")
    try:
        port = parsed.port
    except ValueError as exc:
        raise ValueError("NATS URL port is invalid.") from exc
    if port is None:
        raise ValueError("NATS URL port is missing.")
    normalized = SplitResult(
        scheme=parsed.scheme,
        netloc=parsed.netloc,
        path="",
        query="",
        fragment="",
    )
    return urlunsplit(normalized)


def mask_nats_server_url(server_url: str) -> str:
    parsed = urlsplit(server_url)
    if parsed.password is None:
        return server_url
    username = parsed.username or ""
    host = parsed.hostname or ""
    port = parsed.port
    masked_auth = f"{username}:***@" if username else "***@"
    host_port = f"{host}:{port}" if port is not None else host
    masked = SplitResult(
        scheme=parsed.scheme,
        netloc=f"{masked_auth}{host_port}",
        path="",
        query="",
        fragment="",
    )
    return urlunsplit(masked)
