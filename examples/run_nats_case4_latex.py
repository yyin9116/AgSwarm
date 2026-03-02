from __future__ import annotations

import asyncio
import json
import os

from workflow_control_client import WorkflowControlClient
from workflow_runtime import AdapterConfig, TaskEnvelope
from workflow_transport import NatsTransportProvider


DEFAULT_CASE_DIR = r"D:\yin\project\test_flie\case4_progress_report_20260228_102104"
DEFAULT_LATEX_MCP_DIR = r"D:\yin\project\latex-mcp"
DEFAULT_LATEX_BIN_DIR = r"C:\Users\21598\AppData\Local\Programs\MiKTeX\miktex\bin\x64"
DEFAULT_MAIN_TEX = "case4_paper_progress_report_20260228_102104.tex"


async def main() -> None:
    nats_url = os.getenv("WORKFLOW_NATS_URL", "nats://127.0.0.1:4222")
    target_node = os.getenv("WORKFLOW_TARGET_NODE", "node-a")
    case_dir = os.getenv("WORKFLOW_CASE4_DIR", DEFAULT_CASE_DIR)
    latex_mcp_dir = os.getenv("WORKFLOW_LATEX_MCP_DIR", DEFAULT_LATEX_MCP_DIR)
    latex_bin_dir = os.getenv("WORKFLOW_LATEX_BIN_DIR", DEFAULT_LATEX_BIN_DIR)
    main_tex = os.getenv("WORKFLOW_CASE4_MAIN_TEX", DEFAULT_MAIN_TEX)
    engine = os.getenv("WORKFLOW_CASE4_ENGINE", "pdflatex")

    transport = NatsTransportProvider(server_url=nats_url)
    client = WorkflowControlClient(client_id="client-case4", transport=transport)
    await client.connect()

    done = asyncio.Event()
    result_payload: dict = {}

    async def on_event(event) -> None:
        nonlocal result_payload
        if event.task_id != task.task_id:
            return
        print("event:", json.dumps(event.to_dict(), ensure_ascii=False))
        if event.type == "adapter.completed":
            result_payload = dict(event.payload)
            done.set()
        elif event.type == "adapter.error":
            result_payload = dict(event.payload)
            done.set()

    await client.subscribe_task_events(node_id=target_node, handler=on_event, task_id=None)

    options = {
        "workspace": case_dir,
        "server_cwd": latex_mcp_dir,
        "latex_bin_dir": latex_bin_dir,
        "tool": "compile_and_preview",
        "file_list": [main_tex],
        "main_tex": main_tex,
        "engine": engine,
        "output_subdir": "build_case4_nats",
        "tool_args": {
            "preview_page": 1,
            "preview_dpi": 160,
            "timeout_sec": 360,
        },
    }
    task = TaskEnvelope(
        adapter=AdapterConfig(name="latex_mcp", options=options),
        input_text=f"Compile case4 latex file {main_tex} and generate preview.",
        controls={"stream": True, "timeout_ms": 600000, "max_steps": 64},
        metadata={"scenario": "case4_latex_compile"},
    )
    await client.submit_task(target_node_id=target_node, task=task)
    print(f"submitted latex task_id={task.task_id} to node={target_node}")

    try:
        await asyncio.wait_for(done.wait(), timeout=900)
    except TimeoutError:
        print("timeout waiting for latex task completion")
    finally:
        await client.close()

    print("final:", json.dumps(result_payload, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    asyncio.run(main())
