from __future__ import annotations

import logging
import os
from logging.handlers import RotatingFileHandler
from pathlib import Path

_CONFIGURED = False


def _coerce_level(raw: str | None) -> int:
    if not raw:
        return logging.INFO
    value = str(raw).strip().upper()
    if value == "WARNING":
        value = "WARN"
    mapping = {
        "CRITICAL": logging.CRITICAL,
        "ERROR": logging.ERROR,
        "WARN": logging.WARNING,
        "INFO": logging.INFO,
        "DEBUG": logging.DEBUG,
        "NOTSET": logging.NOTSET,
    }
    return mapping.get(value, logging.INFO)


def setup_logging(
    *,
    level: str | None = None,
    log_file: str | None = None,
    force: bool = False,
) -> None:
    global _CONFIGURED
    if _CONFIGURED and not force:
        return

    resolved_level = _coerce_level(level or os.getenv("WORKFLOW_LOG_LEVEL"))
    handlers: list[logging.Handler] = []

    stream_handler = logging.StreamHandler()
    handlers.append(stream_handler)

    resolved_log_file = log_file or os.getenv("WORKFLOW_LOG_FILE")
    if resolved_log_file:
        path = Path(resolved_log_file)
        path.parent.mkdir(parents=True, exist_ok=True)
        file_handler = RotatingFileHandler(
            filename=str(path),
            maxBytes=5 * 1024 * 1024,
            backupCount=3,
            encoding="utf-8",
        )
        handlers.append(file_handler)

    logging.basicConfig(
        level=resolved_level,
        format="%(asctime)s %(levelname)s [%(name)s] %(message)s",
        datefmt="%Y-%m-%d %H:%M:%S",
        handlers=handlers,
        force=True,
    )
    _CONFIGURED = True
