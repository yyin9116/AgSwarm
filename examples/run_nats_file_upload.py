from __future__ import annotations

import asyncio
import json
import os
import tempfile
from pathlib import Path

from workflow_control_client import WorkflowControlClient
from workflow_transport import NatsTransportProvider


async def main() -> None:
    nats_url = os.getenv("WORKFLOW_NATS_URL", "nats://127.0.0.1:4222")
    target_node = os.getenv("WORKFLOW_TARGET_NODE", "node-a")

    with tempfile.TemporaryDirectory() as td:
        temp_file = Path(td) / "sample.txt"
        temp_file.write_text("workflow data-plane upload demo\n" * 1000, encoding="utf-8")

        transport = NatsTransportProvider(server_url=nats_url)
        client = WorkflowControlClient(client_id="client-file-demo", transport=transport)
        await client.connect()
        try:
            result = await client.upload_file(
                target_node_id=target_node,
                source_path=str(temp_file),
                remote_name="sample-upload.txt",
                chunk_size=64 * 1024,
            )
            print(json.dumps(result, ensure_ascii=False, indent=2))
        finally:
            await client.close()


if __name__ == "__main__":
    asyncio.run(main())
