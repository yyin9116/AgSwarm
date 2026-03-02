from __future__ import annotations

import json
import os
import sys
from typing import Any

from workflow_runtime.adapters.base import Adapter
from workflow_runtime.event_sink import EventSink
from workflow_runtime.protocol import TaskEnvelope


def _parse_mcp_result_payload(result: Any) -> dict[str, Any]:
    dumped = result.model_dump()
    for item in dumped.get("content", []):
        if item.get("type") == "text":
            return json.loads(item["text"])
    raise ValueError("No JSON text content found in MCP tool result.")


class LatexMcpAdapter(Adapter):
    name = "latex_mcp"

    def __init__(
        self,
        *,
        default_workspace: str | None = None,
        default_server_cwd: str | None = None,
    ) -> None:
        self.default_workspace = default_workspace
        self.default_server_cwd = default_server_cwd

    async def run(self, task: TaskEnvelope, sink: EventSink) -> None:
        options = dict(task.adapter.options or {})
        workspace = options.get("workspace") or self.default_workspace
        server_cwd = options.get("server_cwd") or self.default_server_cwd or workspace
        if not workspace:
            await sink.emit(
                "adapter.error",
                {
                    "code": "missing_workspace",
                    "message": "latex_mcp adapter requires adapter.options.workspace or default_workspace.",
                },
            )
            return

        tool_name = str(options.get("tool", "compile_and_preview"))
        tool_args = dict(options.get("tool_args", {}))

        if "file_list" in options and "file_list" not in tool_args:
            tool_args["file_list"] = options["file_list"]
        if "main_tex" in options and "main_tex" not in tool_args:
            tool_args["main_tex"] = options["main_tex"]
        if "engine" in options and "engine" not in tool_args:
            tool_args["engine"] = options["engine"]
        if "output_subdir" in options and "output_subdir" not in tool_args:
            tool_args["output_subdir"] = options["output_subdir"]
        if "timeout_sec" in options and "timeout_sec" not in tool_args:
            tool_args["timeout_sec"] = options["timeout_sec"]

        await sink.emit(
            "adapter.started",
            {
                "adapter": self.name,
                "workspace": workspace,
                "tool": tool_name,
                "tool_args_keys": sorted(tool_args.keys()),
            },
        )

        try:
            from mcp import ClientSession
            from mcp.client.stdio import StdioServerParameters, stdio_client
        except ImportError as exc:
            await sink.emit(
                "adapter.error",
                {
                    "code": "missing_dependency",
                    "message": "mcp SDK is not installed",
                    "detail": str(exc),
                },
            )
            return

        command = str(options.get("server_command", sys.executable))
        args = options.get("server_args", ["-m", "latex_mcp.server"])
        if not isinstance(args, list) or not all(isinstance(x, str) for x in args):
            await sink.emit(
                "adapter.error",
                {
                    "code": "invalid_server_args",
                    "message": "server_args must be a list[str].",
                },
            )
            return

        env = os.environ.copy()
        env.update({k: str(v) for k, v in dict(options.get("server_env", {})).items()})
        latex_bin_dir = options.get("latex_bin_dir")
        if latex_bin_dir:
            env["PATH"] = f"{latex_bin_dir}{os.pathsep}{env.get('PATH', '')}"
        env["LATEX_MCP_WORKSPACE"] = str(workspace)

        params = StdioServerParameters(
            command=command,
            args=args,
            env=env,
            cwd=str(server_cwd) if server_cwd else None,
            encoding="utf-8",
            encoding_error_handler="replace",
        )

        try:
            async with stdio_client(params) as (read_stream, write_stream):
                async with ClientSession(read_stream, write_stream) as session:
                    await session.initialize()
                    await sink.emit(
                        "adapter.token",
                        {
                            "step": "latex_env_check",
                            "progress": 10,
                        },
                    )
                    env_result = await session.call_tool("latex_env_check", {})
                    env_payload = _parse_mcp_result_payload(env_result)
                    if not env_payload.get("ok"):
                        await sink.emit(
                            "adapter.error",
                            {
                                "code": "latex_env_check_failed",
                                "message": "latex_env_check returned error.",
                                "detail": env_payload,
                            },
                        )
                        return
                    binaries = env_payload.get("binaries", {}) if isinstance(env_payload.get("binaries"), dict) else {}
                    selected_engine = str(tool_args.get("engine", options.get("engine", "xelatex")))
                    selected_engine_available = bool(binaries.get(selected_engine))
                    if not selected_engine_available:
                        await sink.emit(
                            "adapter.error",
                            {
                                "code": "latex_env_not_ready",
                                "message": f"LaTeX engine '{selected_engine}' is not available on node.",
                                "detail": binaries,
                            },
                        )
                        return

                    await sink.emit(
                        "adapter.token",
                        {
                            "step": tool_name,
                            "progress": 30,
                        },
                    )
                    run_result = await session.call_tool(tool_name, tool_args)
                    payload = _parse_mcp_result_payload(run_result)

                    if not payload.get("ok", False):
                        err = payload.get("error") or {}
                        await sink.emit(
                            "adapter.error",
                            {
                                "code": err.get("code", "latex_mcp_tool_error"),
                                "message": err.get("message", "latex-mcp tool returned error"),
                                "detail": payload,
                            },
                        )
                        return

                    if "success" in payload and not payload.get("success"):
                        err = payload.get("error") or {}
                        await sink.emit(
                            "adapter.error",
                            {
                                "code": err.get("code", "latex_mcp_compile_failed"),
                                "message": err.get("message", "latex compilation failed"),
                                "detail": payload,
                            },
                        )
                        return

                    # Keep event payload compact but useful for downstream UI.
                    summary: dict[str, Any] = {
                        "tool": tool_name,
                        "workspace_root": payload.get("workspace_root"),
                    }
                    compile_payload = payload.get("compile") if isinstance(payload.get("compile"), dict) else None
                    preview_payload = payload.get("preview") if isinstance(payload.get("preview"), dict) else None
                    if compile_payload:
                        summary["pdf_path"] = compile_payload.get("pdf_path")
                        summary["log_path"] = compile_payload.get("log_path")
                        summary["output_dir"] = compile_payload.get("output_dir")
                        diagnostics = compile_payload.get("diagnostics")
                        if isinstance(diagnostics, dict):
                            summary["diagnostics"] = {
                                "error_count": diagnostics.get("error_count"),
                                "warning_count": diagnostics.get("warning_count"),
                                "missing_packages": diagnostics.get("missing_packages"),
                                "top_errors": diagnostics.get("top_errors"),
                            }
                    if preview_payload:
                        summary["preview_image_path"] = preview_payload.get("image_path")

                    await sink.emit(
                        "adapter.token",
                        {
                            "step": "done",
                            "progress": 100,
                            "text": str(summary.get("pdf_path") or "latex task finished"),
                        },
                    )
                    await sink.emit("adapter.completed", {"output": summary, "raw": payload})

        except Exception as exc:  # pragma: no cover
            await sink.emit(
                "adapter.error",
                {
                    "code": "latex_mcp_runtime_exception",
                    "message": str(exc),
                },
            )
