from __future__ import annotations

import unittest

from workflow_control_client import WorkflowControlClient
from workflow_desktop.service import DesktopControlService
from workflow_transport import Subscription, TransportProvider, subjects


class _FakeSubscription(Subscription):
    async def unsubscribe(self) -> None:
        pass


class _FakeTransport(TransportProvider):
    def __init__(self) -> None:
        self.published: list[tuple[str, dict]] = []
        self.subscribed: list[str] = []

    async def connect(self) -> None:
        pass

    async def close(self) -> None:
        pass

    async def publish(self, subject: str, payload: dict) -> None:
        self.published.append((subject, payload))

    async def subscribe(self, subject: str, handler):
        self.subscribed.append(subject)
        return _FakeSubscription()

    async def request(self, subject: str, payload: dict, timeout_sec: float = 2.0) -> dict:
        return {"subject": subject, "payload": payload}


class ClientMessagingTests(unittest.IsolatedAsyncioTestCase):
    def test_client_subjects(self) -> None:
        self.assertEqual(subjects.client_presence(), "workflow.clients.*.presence")
        self.assertEqual(subjects.client_presence("desktop-a"), "workflow.clients.desktop-a.presence")
        self.assertEqual(subjects.client_inbox("desktop-b"), "workflow.clients.desktop-b.inbox")

    async def test_control_client_sends_client_message_to_target_inbox(self) -> None:
        transport = _FakeTransport()
        client = WorkflowControlClient(client_id="desktop-a", transport=transport)

        message = await client.send_client_message(
            target_client_id="desktop-b",
            message_type="task.request",
            conversation_id="desktop-a:desktop-b",
            payload={"instruction": "write script"},
        )

        self.assertEqual(transport.published[0][0], "workflow.clients.desktop-b.inbox")
        self.assertEqual(message["from_client_id"], "desktop-a")
        self.assertEqual(message["target_client_id"], "desktop-b")
        self.assertEqual(message["type"], "task.request")
        self.assertEqual(message["payload"]["instruction"], "write script")

    async def test_desktop_service_executes_python_script(self) -> None:
        service = DesktopControlService(client_id="desktop-a", nats_url="nats://127.0.0.1:4222")

        result = await service.execute_python_script(script="print('SCRIPT_OK')", timeout_sec=5.0)

        self.assertTrue(result["ok"])
        self.assertEqual(result["returncode"], 0)
        self.assertIn("SCRIPT_OK", result["stdout"])


if __name__ == "__main__":
    unittest.main()
