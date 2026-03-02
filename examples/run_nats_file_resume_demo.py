from __future__ import annotations

import asyncio
import base64
import hashlib
import json
import os
import tempfile
from pathlib import Path
from uuid import uuid4

from workflow_control_client import WorkflowControlClient
from workflow_transport import NatsTransportProvider, subjects


async def main() -> None:
    nats_url = os.getenv("WORKFLOW_NATS_URL", "nats://127.0.0.1:4222")
    target_node = os.getenv("WORKFLOW_TARGET_NODE", "node-a")
    chunk_size = 64 * 1024

    with tempfile.TemporaryDirectory() as td:
        temp_file = Path(td) / "resume-sample.txt"
        temp_file.write_text("resume demo content\n" * 12000, encoding="utf-8")

        data = temp_file.read_bytes()
        size_bytes = len(data)
        sha256 = hashlib.sha256(data).hexdigest()
        total_chunks = (size_bytes + chunk_size - 1) // chunk_size
        transfer_id = str(uuid4())

        transport = NatsTransportProvider(server_url=nats_url)
        client = WorkflowControlClient(client_id="client-resume-demo", transport=transport)
        await client.connect()
        try:
            prepare = await transport.request(
                subjects.file_prepare_request(target_node),
                {
                    "from_client_id": "client-resume-demo",
                    "transfer_id": transfer_id,
                    "file_name": "resume-upload.txt",
                    "size_bytes": size_bytes,
                    "sha256": sha256,
                    "chunk_size": chunk_size,
                    "total_chunks": total_chunks,
                },
                timeout_sec=5,
            )
            print("prepare:", json.dumps(prepare, ensure_ascii=False))

            half = total_chunks // 2
            for idx in range(half):
                chunk = data[idx * chunk_size : (idx + 1) * chunk_size]
                await transport.publish(
                    subjects.file_chunk(target_node, transfer_id),
                    {
                        "transfer_id": transfer_id,
                        "index": idx,
                        "total_chunks": total_chunks,
                        "data_b64": base64.b64encode(chunk).decode("ascii"),
                    },
                )
            print(f"uploaded partial chunks: {half}/{total_chunks}")

            result = await client.resume_file_upload(
                target_node_id=target_node,
                source_path=str(temp_file),
                transfer_id=transfer_id,
                remote_name="resume-upload.txt",
                chunk_size=chunk_size,
                max_parallelism=8,
            )
            print("resume result:", json.dumps(result, ensure_ascii=False, indent=2))
        finally:
            await client.close()


if __name__ == "__main__":
    asyncio.run(main())
