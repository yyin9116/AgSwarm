from __future__ import annotations

import tempfile
import sys
import textwrap
import unittest
from pathlib import Path
from unittest.mock import patch

from workflow_control_client import WorkflowControlClient
from workflow_control_client.client import _extract_assistant_text
from workflow_cli.__main__ import _build_pi_task, build_parser
from workflow_node_daemon import PeerNodeConfig, PeerNodeHost, WorkflowNodeDaemon
from workflow_runtime.adapters.pi_adapter import PiAdapter
from workflow_runtime.adapters.base import Adapter
from workflow_runtime.event_sink import EventSink
from workflow_runtime.protocol import AdapterConfig, TaskEnvelope
from workflow_runtime.runtime import InMemoryEventSink, Runtime
from workflow_transport import Subscription, TransportProvider


class _NoopAdapter(Adapter):
    def __init__(self, name: str) -> None:
        self.name = name

    async def run(self, task: TaskEnvelope, sink: EventSink) -> None:
        await sink.emit("adapter.completed", {"output": task.input_text})


class _FakeSubscription(Subscription):
    def __init__(self) -> None:
        self.unsubscribed = False

    async def unsubscribe(self) -> None:
        self.unsubscribed = True


class _StatusTransport(TransportProvider):
    def __init__(self, statuses: list[dict]) -> None:
        self.statuses = statuses
        self.requests: list[tuple[str, dict, float]] = []

    async def connect(self) -> None:
        pass

    async def close(self) -> None:
        pass

    async def publish(self, subject: str, payload: dict) -> None:
        pass

    async def subscribe(self, subject: str, handler):
        for payload in self.statuses:
            await handler(subject, payload, None)
        return _FakeSubscription()

    async def request(self, subject: str, payload: dict, timeout_sec: float = 2.0) -> dict:
        self.requests.append((subject, payload, timeout_sec))
        return {"ok": True, "subject": subject, "payload": payload}


class PiCliIntegrationTests(unittest.IsolatedAsyncioTestCase):
    def test_submit_pi_parser_and_task_builder(self) -> None:
        parser = build_parser()
        args = parser.parse_args(
            [
                "submit-pi",
                "--node-id",
                "node-pi",
                "--device-id",
                "pi-01",
                "--prompt",
                "index uploaded files",
                "--model",
                "anthropic/claude-sonnet-4",
                "--skills",
                "safe_default,file_ops",
                "--session-label",
                "sync-job",
                "--file-root",
                "/srv/work",
                "--max-steps",
                "42",
                "--timeout-ms",
                "345000",
            ]
        )

        task = _build_pi_task(args)

        self.assertEqual(task.adapter.name, "pi")
        self.assertEqual(task.adapter.model, "anthropic/claude-sonnet-4")
        self.assertEqual(task.adapter.options["device_id"], "pi-01")
        self.assertEqual(task.adapter.options["file_root"], "/srv/work")
        self.assertTrue(task.adapter.options["no_session"])
        self.assertEqual(task.controls["max_steps"], 42)
        self.assertEqual(task.controls["timeout_ms"], 345000)
        self.assertEqual(task.context, {})
        self.assertEqual(task.metadata["target_device"], "pi-01")
        self.assertEqual(task.metadata["target_host_layer"], "agswarm_peer")
        self.assertEqual(task.metadata["target_transport"], "nats")
        self.assertEqual(task.metadata["session_label"], "sync-job")
        self.assertEqual(task.metadata["skills"], ["safe_default", "file_ops"])

    def test_pi_adapter_uses_shell_style_quoting_for_command_parts(self) -> None:
        adapter = PiAdapter(pi_cli='"/tmp/pi tools/pi"')
        task = TaskEnvelope(adapter=AdapterConfig(name=adapter.name), input_text="unused")
        self.assertEqual(task.adapter.name, "pi")
        self.assertEqual(adapter.pi_cli, '"/tmp/pi tools/pi"')

    def test_pi_adapter_resolves_local_cli_with_absolute_node(self) -> None:
        with tempfile.TemporaryDirectory() as tmp_dir:
            home = Path(tmp_dir)
            local_cli = home / "test" / "pi" / "packages" / "coding-agent" / "dist" / "cli.js"
            local_cli.parent.mkdir(parents=True)
            local_cli.write_text("#!/usr/bin/env node\n", encoding="utf-8")

            with patch("workflow_runtime.adapters.pi_adapter.Path.home", return_value=home), patch(
                "workflow_runtime.adapters.pi_adapter.shutil.which",
                side_effect=lambda command, path=None: None if command == "pi" else "/usr/local/bin/node",
            ):
                command = PiAdapter._resolve_pi_cli({"PATH": ""})

        self.assertEqual(command, f"/usr/local/bin/node {local_cli}")
        self.assertNotRegex(command, r"^node\s")

    def test_pi_adapter_extracts_text_delta_from_message_update(self) -> None:
        adapter = PiAdapter(pi_cli='"/tmp/pi"')

        event_type, payload = adapter._map_pi_event(
            {
                "type": "message_update",
                "message": {
                    "role": "assistant",
                    "content": [{"type": "text", "text": "hello"}],
                },
                "assistantMessageEvent": {},
            }
        )
        _, next_payload = adapter._map_pi_event(
            {
                "type": "message_update",
                "message": {
                    "role": "assistant",
                    "content": [{"type": "text", "text": "hello world"}],
                },
                "assistantMessageEvent": {},
            }
        )

        self.assertEqual(event_type, "agent.token")
        self.assertEqual(payload["text"], "hello")
        self.assertEqual(next_payload["text"], " world")

    def test_pi_adapter_extracts_thinking_delta_from_cumulative_message_update(self) -> None:
        adapter = PiAdapter(pi_cli='"/tmp/pi"')

        event_type, payload = adapter._map_pi_event(
            {
                "type": "message_update",
                "assistantMessageEvent": {
                    "thinking": "Finding files for a task",
                },
            }
        )
        _, next_payload = adapter._map_pi_event(
            {
                "type": "message_update",
                "assistantMessageEvent": {
                    "thinking": "Finding files for a task\nI need to provide an answer in Chinese",
                },
            }
        )
        _, duplicate_payload = adapter._map_pi_event(
            {
                "type": "message_update",
                "assistantMessageEvent": {
                    "thinking": "Finding files for a task\nI need to provide an answer in Chinese",
                },
            }
        )

        self.assertEqual(event_type, "agent.token")
        self.assertEqual(payload["thinking"], "Finding files for a task")
        self.assertEqual(next_payload["thinking"], "\nI need to provide an answer in Chinese")
        self.assertEqual(duplicate_payload["thinking"], "")

    def test_pi_adapter_ignores_commentary_text_for_assistant_body(self) -> None:
        adapter = PiAdapter(pi_cli='"/tmp/pi"')

        _, commentary_payload = adapter._map_pi_event(
            {
                "type": "message_update",
                "assistantMessageEvent": {
                    "text": "我会先查天气。",
                    "textSignature": '{"phase":"commentary"}',
                },
            }
        )
        _, final_payload = adapter._map_pi_event(
            {
                "type": "message_update",
                "assistantMessageEvent": {
                    "text": "上海明天有阵雨。",
                    "textSignature": '{"phase":"final_answer"}',
                },
            }
        )

        self.assertEqual(commentary_payload["text"], "")
        self.assertEqual(final_payload["text"], "上海明天有阵雨。")

    async def test_pi_adapter_closes_rpc_process_after_agent_end(self) -> None:
        with tempfile.TemporaryDirectory() as tmp_dir:
            fake_pi = Path(tmp_dir) / "fake_pi.py"
            fake_pi.write_text(
                textwrap.dedent(
                    """
                    import json
                    import sys

                    sys.stdin.readline()
                    print(json.dumps({"type": "response", "command": "prompt", "success": True}), flush=True)
                    print(json.dumps({"type": "agent_start"}), flush=True)
                    print(json.dumps({"type": "agent_end", "messages": []}), flush=True)
                    sys.stdin.read()
                    """
                ).lstrip(),
                encoding="utf-8",
            )

            adapter = PiAdapter(pi_cli=f"{sys.executable} {fake_pi}")
            task = TaskEnvelope(
                adapter=AdapterConfig(name=adapter.name),
                input_text="hello",
                controls={"timeout_ms": 200},
            )
            sink = InMemoryEventSink(task.task_id)

            await adapter.run(task, sink)

        self.assertEqual([event.type for event in sink.events][-1], "adapter.completed")
        self.assertIn("agent.end", [event.type for event in sink.events])

    async def test_pi_adapter_marks_agent_end_error_as_adapter_error(self) -> None:
        with tempfile.TemporaryDirectory() as tmp_dir:
            fake_pi = Path(tmp_dir) / "fake_pi.py"
            fake_pi.write_text(
                textwrap.dedent(
                    """
                    import json
                    import sys

                    sys.stdin.readline()
                    print(json.dumps({"type": "response", "command": "prompt", "success": True}), flush=True)
                    print(json.dumps({
                        "type": "agent_end",
                        "messages": [
                            {
                                "role": "assistant",
                                "content": [],
                                "stopReason": "error",
                                "errorMessage": "provider unavailable",
                            }
                        ],
                    }), flush=True)
                    sys.stdin.read()
                    """
                ).lstrip(),
                encoding="utf-8",
            )

            adapter = PiAdapter(pi_cli=f"{sys.executable} {fake_pi}")
            task = TaskEnvelope(
                adapter=AdapterConfig(name=adapter.name),
                input_text="hello",
                controls={"timeout_ms": 200},
            )
            sink = InMemoryEventSink(task.task_id)

            await adapter.run(task, sink)

        event_types = [event.type for event in sink.events]
        self.assertIn("adapter.error", event_types)
        self.assertNotIn("adapter.completed", event_types)

    def test_pi_result_extracts_assistant_text_from_agent_events(self) -> None:
        events = [
            {
                "type": "agent.token",
                "payload": {"text": "partial"},
            },
            {
                "type": "agent.end",
                "payload": {
                    "messages": [
                        {"role": "user", "content": "hello"},
                        {"role": "assistant", "content": "final pi response"},
                    ]
                },
            },
            {
                "type": "adapter.completed",
                "payload": {"output": "pi agent finished"},
            },
        ]

        self.assertEqual(_extract_assistant_text(events), "final pi response")

    def test_pi_result_can_reconstruct_assistant_text_from_tokens(self) -> None:
        events = [
            {"type": "agent.token", "payload": {"text": "hello "}},
            {"type": "agent.token", "payload": {"text": "from pi"}},
            {"type": "adapter.completed", "payload": {"output": "pi agent finished"}},
        ]

        self.assertEqual(_extract_assistant_text(events), "hello from pi")

    def test_peer_node_snapshot_exposes_pi_capability(self) -> None:
        runtime = Runtime(adapters=[_NoopAdapter("echo"), _NoopAdapter("pi")])
        daemon = WorkflowNodeDaemon(
            runtime,
            peer_config=PeerNodeConfig(
                endpoint="nats://127.0.0.1:4222",
                device_id="node-pi",
                device_label="Pi Worker",
                device_tags=["lab", "edge"],
                capabilities=["file-transfer"],
            ),
        )

        snapshot = daemon.get_node_snapshot()

        self.assertIn("pi", snapshot.adapters)
        self.assertEqual(snapshot.peer_node["host_layer"], "agswarm_peer")
        self.assertEqual(snapshot.peer_node["endpoint"], "nats://127.0.0.1:4222")
        self.assertEqual(snapshot.peer_node["device_id"], "node-pi")
        self.assertEqual(snapshot.peer_node["device_label"], "Pi Worker")
        self.assertEqual(snapshot.peer_node["device_tags"], ["lab", "edge"])
        self.assertIn("task-dispatch", snapshot.peer_node["capabilities"])
        self.assertIn("interactive-file-stream", snapshot.peer_node["capabilities"])
        self.assertIn("pi-agent", snapshot.peer_node["capabilities"])


class PeerDiscoveryTests(unittest.IsolatedAsyncioTestCase):
    async def test_resolve_peer_device_node_selects_matching_pi_node(self) -> None:
        client = WorkflowControlClient(
            client_id="test-client",
            transport=_StatusTransport(
                [
                    {
                        "node_id": "node-echo",
                        "peer_node": {
                            "device_id": "echo-01",
                            "capabilities": ["task-dispatch"],
                        },
                    },
                    {
                        "node_id": "node-pi",
                        "peer_node": {
                            "device_id": "pi-01",
                            "capabilities": ["task-dispatch", "pi-agent"],
                        },
                    },
                ]
            ),
        )

        resolved = await client.resolve_peer_device_node(
            device_id="pi-01",
            timeout_sec=0.001,
            require_capabilities=["pi-agent"],
        )

        self.assertEqual(resolved["node_id"], "node-pi")

    async def test_resolve_peer_device_node_rejects_missing_capability(self) -> None:
        client = WorkflowControlClient(
            client_id="test-client",
            transport=_StatusTransport(
                [
                    {
                        "node_id": "node-pi",
                        "peer_node": {
                            "device_id": "pi-01",
                            "capabilities": ["task-dispatch"],
                        },
                    },
                ]
            ),
        )

        with self.assertRaises(LookupError):
            await client.resolve_peer_device_node(
                device_id="pi-01",
                timeout_sec=0.001,
                require_capabilities=["pi-agent"],
            )

    async def test_request_peer_command_uses_node_command_subject(self) -> None:
        transport = _StatusTransport([])
        client = WorkflowControlClient(client_id="test-client", transport=transport)

        response = await client.request_peer_command(
            node_id="node-pi",
            command="ping",
            payload={"hello": "world"},
            timeout_sec=4.0,
        )

        self.assertTrue(response["ok"])
        self.assertEqual(transport.requests[0][0], "workflow.nodes.node-pi.peer.command")
        self.assertEqual(transport.requests[0][1]["command"], "ping")
        self.assertEqual(transport.requests[0][1]["payload"], {"hello": "world"})
        self.assertEqual(transport.requests[0][2], 4.0)

    async def test_peer_host_ping_returns_device_description(self) -> None:
        host = PeerNodeHost(
            PeerNodeConfig(
                endpoint="nats://127.0.0.1:4222",
                device_id="pi-01",
                capabilities=["file-transfer"],
            )
        )

        response = await host.handle_command(
            command="ping",
            payload={"probe": True},
            adapters=["pi"],
        )

        self.assertTrue(response["ok"])
        self.assertEqual(response["message"], "pong")
        self.assertEqual(response["echo"], {"probe": True})
        self.assertEqual(response["peer_node"]["device_id"], "pi-01")
        self.assertIn("pi-agent", response["peer_node"]["capabilities"])


if __name__ == "__main__":
    unittest.main()
