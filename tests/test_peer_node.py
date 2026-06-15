from __future__ import annotations

import unittest

from workflow_control_client import WorkflowControlClient
from workflow_node_daemon import PeerNodeConfig, PeerNodeHost, WorkflowNodeDaemon
from workflow_runtime.adapters.base import Adapter
from workflow_runtime.runtime import Runtime
from workflow_transport.base import Subscription, TransportProvider


class EchoAdapter(Adapter):
    name = "echo"

    async def run(self, task, sink) -> None:  # pragma: no cover - not exercised here
        raise NotImplementedError


class CaptureTransport(TransportProvider):
    def __init__(self, statuses: list[dict] | None = None) -> None:
        self.statuses = statuses or []
        self.requests: list[tuple[str, dict, float]] = []

    async def connect(self) -> None:
        pass

    async def close(self) -> None:
        pass

    async def publish(self, subject: str, payload: dict) -> None:
        pass

    async def request(self, subject: str, payload: dict, timeout_sec: float = 2.0) -> dict:
        self.requests.append((subject, payload, timeout_sec))
        return {"ok": True, "subject": subject}

    async def subscribe(self, subject: str, handler) -> Subscription:
        for payload in self.statuses:
            await handler(subject, payload, None)
        return NoopSubscription()


class NoopSubscription(Subscription):
    async def unsubscribe(self) -> None:
        pass


class PeerNodeTests(unittest.IsolatedAsyncioTestCase):
    def test_node_snapshot_exposes_lightweight_peer_node(self) -> None:
        daemon = WorkflowNodeDaemon(
            Runtime([EchoAdapter()]),
            peer_config=PeerNodeConfig(
                endpoint="nats://127.0.0.1:4222",
                device_id="peer-a",
                device_label="Peer A",
                device_tags=["mac", "local"],
            ),
        )

        snapshot = daemon.get_node_snapshot()

        self.assertEqual(snapshot.peer_node["host_layer"], "agswarm_peer")
        self.assertEqual(snapshot.peer_node["device_id"], "peer-a")
        self.assertEqual(snapshot.peer_node["device_label"], "Peer A")
        self.assertIn("task-dispatch", snapshot.peer_node["capabilities"])
        self.assertIn("interactive-file-stream", snapshot.peer_node["capabilities"])

    async def test_discover_peer_nodes_reads_peer_node_status(self) -> None:
        client = WorkflowControlClient(
            client_id="test-client",
            transport=CaptureTransport(
                [
                    {
                        "node_id": "peer-a",
                        "peer_node": {
                            "device_id": "peer-a",
                            "capabilities": ["task-dispatch"],
                        },
                    },
                    {
                        "node_id": "peer-b",
                        "peer_node": {
                            "device_id": "peer-b",
                            "capabilities": ["interactive-file-stream"],
                        },
                    },
                ]
            ),
        )

        nodes = await client.discover_peer_nodes(
            timeout_sec=0.01,
            require_capabilities=["task-dispatch"],
        )

        self.assertEqual([node["node_id"] for node in nodes], ["peer-a"])

    async def test_request_peer_command_uses_peer_subject(self) -> None:
        transport = CaptureTransport()
        client = WorkflowControlClient(client_id="test-client", transport=transport)

        response = await client.request_peer_command(
            node_id="peer-a",
            command="ping",
            payload={"hello": "world"},
            timeout_sec=3.0,
        )

        self.assertTrue(response["ok"])
        self.assertEqual(transport.requests[0][0], "workflow.nodes.peer-a.peer.command")
        self.assertEqual(transport.requests[0][1]["command"], "ping")

    async def test_peer_host_ping_is_builtin_only(self) -> None:
        host = PeerNodeHost(
            PeerNodeConfig(
                device_id="peer-a",
                device_label="Peer A",
                capabilities=["task-dispatch"],
            )
        )

        response = await host.handle_command(
            command="ping",
            payload={"x": 1},
            adapters=["echo"],
        )

        self.assertEqual(response["message"], "pong")
        self.assertEqual(response["peer_node"]["host_layer"], "agswarm_peer")
        self.assertEqual(response["peer_node"]["device_id"], "peer-a")


if __name__ == "__main__":
    unittest.main()
