from __future__ import annotations

import asyncio
import json
import logging
import socket
import time
from dataclasses import dataclass
from typing import Any, Callable
from urllib.parse import urlparse, urlunparse

logger = logging.getLogger(__name__)

DISCOVERY_KIND = "agswarm.node.announce.v1"
DISCOVERY_PORT_DEFAULT = 48666
DISCOVERY_BROADCAST_DEFAULT = "255.255.255.255"


def is_loopback_nats_url(url: str) -> bool:
    text = str(url).strip()
    if not text:
        return True
    parsed = urlparse(text)
    host = (parsed.hostname or "").strip().lower()
    return host in {"", "localhost", "127.0.0.1", "::1", "0.0.0.0"}


def _detect_lan_ipv4() -> str:
    candidates: list[str] = []
    try:
        with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as sock:
            sock.connect(("8.8.8.8", 80))
            candidates.append(str(sock.getsockname()[0]))
    except OSError:
        pass
    try:
        host = socket.gethostname()
        candidates.extend(socket.gethostbyname_ex(host)[2])
    except OSError:
        pass
    for ip in candidates:
        if ip and ip not in {"127.0.0.1", "0.0.0.0"}:
            return ip
    return "127.0.0.1"


def resolve_advertise_nats_url(nats_url: str, *, explicit_advertise_url: str | None = None) -> str:
    explicit = str(explicit_advertise_url or "").strip()
    if explicit:
        return explicit
    text = str(nats_url).strip()
    if not text:
        return text
    parsed = urlparse(text)
    if parsed.scheme.lower() != "nats":
        return text
    if not is_loopback_nats_url(text):
        return text
    lan_ip = _detect_lan_ipv4()
    netloc = parsed.netloc
    userinfo = ""
    hostport = netloc
    if "@" in netloc:
        userinfo, hostport = netloc.split("@", 1)
    if ":" in hostport:
        _, port = hostport.rsplit(":", 1)
        hostport = f"{lan_ip}:{port}"
    else:
        hostport = lan_ip
    new_netloc = f"{userinfo}@{hostport}" if userinfo else hostport
    return urlunparse(parsed._replace(netloc=new_netloc))


@dataclass(slots=True)
class DiscoveredNode:
    node_id: str
    nats_url: str
    hostname: str
    source_ip: str
    status: str
    active_tasks: int
    queued_tasks: int
    last_seen_unix: float
    last_seen_monotonic: float


class LanNodeBroadcaster:
    def __init__(
        self,
        *,
        node_id: str,
        nats_url: str,
        hostname: str | None = None,
        port: int = DISCOVERY_PORT_DEFAULT,
        broadcast_addr: str = DISCOVERY_BROADCAST_DEFAULT,
        interval_sec: float = 2.0,
        snapshot_provider: Callable[[], dict[str, Any]] | None = None,
    ) -> None:
        self.node_id = node_id
        self.nats_url = nats_url
        self.hostname = hostname or socket.gethostname()
        self.port = int(port)
        self.broadcast_addr = broadcast_addr
        self.interval_sec = max(0.5, float(interval_sec))
        self.snapshot_provider = snapshot_provider
        self._running = False
        self._task: asyncio.Task[None] | None = None

    async def start(self) -> None:
        if self._running:
            return
        self._running = True
        self._task = asyncio.create_task(self._run_loop(), name=f"lan-discovery-broadcast-{self.node_id}")
        logger.info(
            "lan discovery broadcaster started node_id=%s addr=%s:%d interval=%.2fs nats_url=%s",
            self.node_id,
            self.broadcast_addr,
            self.port,
            self.interval_sec,
            self.nats_url,
        )

    async def stop(self) -> None:
        if not self._running:
            return
        self._running = False
        if self._task is not None:
            self._task.cancel()
            await asyncio.gather(self._task, return_exceptions=True)
            self._task = None
        logger.info("lan discovery broadcaster stopped node_id=%s", self.node_id)

    async def _run_loop(self) -> None:
        sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        try:
            sock.setsockopt(socket.SOL_SOCKET, socket.SO_BROADCAST, 1)
            sock.setblocking(False)
            loop = asyncio.get_running_loop()
            while self._running:
                payload = self._build_payload()
                data = json.dumps(payload, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
                try:
                    await loop.sock_sendto(sock, data, (self.broadcast_addr, self.port))
                except OSError as exc:
                    logger.debug("lan discovery broadcast send failed node_id=%s error=%s", self.node_id, exc)
                await asyncio.sleep(self.interval_sec)
        finally:
            sock.close()

    def _build_payload(self) -> dict[str, Any]:
        snapshot: dict[str, Any] = {}
        if self.snapshot_provider is not None:
            try:
                payload = self.snapshot_provider()
                if isinstance(payload, dict):
                    snapshot = payload
            except Exception:
                logger.debug("lan discovery snapshot provider failed", exc_info=True)
        return {
            "kind": DISCOVERY_KIND,
            "node_id": self.node_id,
            "nats_url": self.nats_url,
            "hostname": self.hostname,
            "status": str(snapshot.get("status", "unknown")),
            "active_tasks": int(snapshot.get("active_tasks", 0)),
            "queued_tasks": int(snapshot.get("queued_tasks", 0)),
            "timestamp": time.time(),
        }


class _LanDiscoveryProtocol(asyncio.DatagramProtocol):
    def __init__(self, on_datagram: Callable[[bytes, tuple[str, int]], None]) -> None:
        self._on_datagram = on_datagram
        self.transport: asyncio.DatagramTransport | None = None

    def connection_made(self, transport: asyncio.BaseTransport) -> None:  # pragma: no cover - loop callback
        self.transport = transport if isinstance(transport, asyncio.DatagramTransport) else None

    def datagram_received(self, data: bytes, addr: tuple[str, int]) -> None:  # pragma: no cover - loop callback
        self._on_datagram(data, addr)


class LanNodeListener:
    def __init__(self, *, port: int = DISCOVERY_PORT_DEFAULT) -> None:
        self.port = int(port)
        self._transport: asyncio.DatagramTransport | None = None
        self._protocol: _LanDiscoveryProtocol | None = None
        self._nodes: dict[str, DiscoveredNode] = {}

    async def start(self) -> None:
        if self._transport is not None:
            return
        loop = asyncio.get_running_loop()
        sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        sock.setsockopt(socket.SOL_SOCKET, socket.SO_BROADCAST, 1)
        try:
            sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        except OSError:
            pass
        if hasattr(socket, "SO_REUSEPORT"):
            try:
                sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEPORT, 1)
            except OSError:
                pass
        sock.bind(("0.0.0.0", self.port))
        sock.setblocking(False)
        transport, protocol = await loop.create_datagram_endpoint(
            lambda: _LanDiscoveryProtocol(self._on_datagram),
            sock=sock,
        )
        self._transport = transport
        self._protocol = protocol
        logger.info("lan discovery listener started port=%d", self.port)

    async def stop(self) -> None:
        if self._transport is not None:
            self._transport.close()
            self._transport = None
        self._protocol = None
        logger.info("lan discovery listener stopped port=%d", self.port)

    def snapshot(self, *, max_age_sec: float = 8.0) -> dict[str, DiscoveredNode]:
        now = time.monotonic()
        stale = [key for key, item in self._nodes.items() if (now - item.last_seen_monotonic) > max_age_sec]
        for key in stale:
            self._nodes.pop(key, None)
        return dict(self._nodes)

    def _on_datagram(self, data: bytes, addr: tuple[str, int]) -> None:
        try:
            payload = json.loads(data.decode("utf-8"))
        except Exception:
            return
        if not isinstance(payload, dict):
            return
        if str(payload.get("kind")) != DISCOVERY_KIND:
            return
        node_id = str(payload.get("node_id", "")).strip()
        nats_url = str(payload.get("nats_url", "")).strip()
        if not node_id or not nats_url:
            return
        now_unix = time.time()
        now_mono = time.monotonic()
        entry = DiscoveredNode(
            node_id=node_id,
            nats_url=nats_url,
            hostname=str(payload.get("hostname", "")).strip(),
            source_ip=str(addr[0]),
            status=str(payload.get("status", "unknown")),
            active_tasks=int(payload.get("active_tasks", 0)),
            queued_tasks=int(payload.get("queued_tasks", 0)),
            last_seen_unix=now_unix,
            last_seen_monotonic=now_mono,
        )
        self._nodes[node_id] = entry
