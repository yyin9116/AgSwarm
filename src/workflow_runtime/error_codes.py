from __future__ import annotations

from typing import Any

ERROR_CODE_LABELS: dict[str, str] = {
    "task.failed": "Task Failed",
    "task.timeout": "Task Timeout",
    "adapter.error": "Adapter Runtime Error",
    "task.user_message.error": "User Message Error",
    "transfer.failed": "Transfer Failed",
    "mcp_not_available": "MCP Not Available",
    "mcp_call_failed": "MCP Call Failed",
    "latex_compile_failed": "LaTeX Compile Failed",
    "latex_mcp_error": "LaTeX MCP Error",
}


def extract_error_code(result: dict[str, Any]) -> str:
    user_messages = result.get("user_messages")
    if isinstance(user_messages, list):
        for msg in user_messages:
            if not isinstance(msg, dict):
                continue
            code = msg.get("code")
            level = str(msg.get("level", "")).lower()
            if isinstance(code, str) and code.strip():
                return code.strip()
            if level == "error":
                return "task.user_message.error"
    terminal = result.get("terminal_event")
    if isinstance(terminal, dict):
        payload = terminal.get("payload")
        if isinstance(payload, dict):
            code = payload.get("code")
            if isinstance(code, str) and code.strip():
                return code.strip()
        event_type = terminal.get("type")
        if isinstance(event_type, str) and event_type == "adapter.error":
            return "adapter.error"
    if result.get("ok") is False:
        command = str(result.get("command", "")).strip().lower()
        if command.startswith("upload") or command.startswith("download"):
            return "transfer.failed"
    status = str(result.get("status", "")).lower()
    if status == "timeout":
        return "task.timeout"
    if status == "failed":
        return "task.failed"
    if result.get("ok") is False:
        if ("failures" in result) or ("failed" in result) or ("files_failed" in result):
            return "transfer.failed"
        return "task.failed"
    return ""


def extract_error_message(result: dict[str, Any]) -> str:
    user_messages = result.get("user_messages")
    if isinstance(user_messages, list):
        for msg in user_messages:
            if not isinstance(msg, dict):
                continue
            level = str(msg.get("level", "")).lower()
            text = msg.get("message")
            if level == "error" and isinstance(text, str) and text.strip():
                return text.strip()
    terminal = result.get("terminal_event")
    if isinstance(terminal, dict):
        payload = terminal.get("payload")
        if isinstance(payload, dict):
            stderr = payload.get("stderr")
            if isinstance(stderr, str):
                first_line = next((line.strip() for line in stderr.splitlines() if line.strip()), "")
                if first_line:
                    return first_line
            text = payload.get("message")
            if isinstance(text, str) and text.strip():
                return text.strip()
    text = result.get("error")
    if isinstance(text, str) and text.strip():
        return text.strip()
    text = result.get("message")
    if isinstance(text, str) and text.strip():
        return text.strip()
    for key in ("failures", "failed"):
        rows = result.get(key)
        if not isinstance(rows, list):
            continue
        for item in rows:
            if not isinstance(item, dict):
                continue
            msg = item.get("error")
            if isinstance(msg, str) and msg.strip():
                return msg.strip()
            msg = item.get("message")
            if isinstance(msg, str) and msg.strip():
                return msg.strip()
    return ""


def format_user_messages(result: dict[str, Any]) -> list[str]:
    rows: list[str] = []
    user_messages = result.get("user_messages")
    if not isinstance(user_messages, list):
        return rows
    for item in user_messages:
        if not isinstance(item, dict):
            continue
        level = str(item.get("level", "info")).strip().lower() or "info"
        message = str(item.get("message", "")).strip()
        if not message:
            continue
        code = str(item.get("code", "")).strip()
        if code:
            label = ERROR_CODE_LABELS.get(code)
            if label:
                rows.append(f"[{level}] {message} (code={code}, {label})")
            else:
                rows.append(f"[{level}] {message} (code={code})")
        else:
            rows.append(f"[{level}] {message}")
    return rows


def build_error_summary(result: dict[str, Any]) -> dict[str, Any]:
    code = extract_error_code(result)
    message = extract_error_message(result)
    user_messages = format_user_messages(result)
    if (not user_messages) and message:
        user_messages = [f"[error] {message}"]
    label = ERROR_CODE_LABELS.get(code, "Unknown Error") if code else ""
    return {
        "code": code,
        "label": label,
        "message": message,
        "user_messages": user_messages,
    }
