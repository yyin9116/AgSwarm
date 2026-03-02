from __future__ import annotations

ROOT = "workflow"


def task_submit(node_id: str) -> str:
    return f"{ROOT}.nodes.{node_id}.task.submit"


def task_events(node_id: str, task_id: str | None = None) -> str:
    if task_id:
        return f"{ROOT}.nodes.{node_id}.task.events.{task_id}"
    return f"{ROOT}.nodes.{node_id}.task.events.*"


def node_status(node_id: str | None = None) -> str:
    if node_id:
        return f"{ROOT}.nodes.{node_id}.status"
    return f"{ROOT}.nodes.*.status"


def node_snapshot_request(node_id: str) -> str:
    return f"{ROOT}.nodes.{node_id}.snapshot.request"


def node_config_sync_request(node_id: str) -> str:
    return f"{ROOT}.nodes.{node_id}.config.sync"


def file_prepare_request(node_id: str) -> str:
    return f"{ROOT}.nodes.{node_id}.files.prepare"


def file_chunk(node_id: str, transfer_id: str) -> str:
    return f"{ROOT}.nodes.{node_id}.files.chunk.{transfer_id}"


def file_chunk_wildcard(node_id: str) -> str:
    return f"{ROOT}.nodes.{node_id}.files.chunk.*"


def file_commit_request(node_id: str) -> str:
    return f"{ROOT}.nodes.{node_id}.files.commit"


def file_download_prepare_request(node_id: str) -> str:
    return f"{ROOT}.nodes.{node_id}.files.download.prepare"


def file_download_chunk_request(node_id: str) -> str:
    return f"{ROOT}.nodes.{node_id}.files.download.chunk"


def file_download_list_request(node_id: str) -> str:
    return f"{ROOT}.nodes.{node_id}.files.download.list"
