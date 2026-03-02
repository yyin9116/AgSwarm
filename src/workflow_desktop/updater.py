from __future__ import annotations

import fnmatch
import json
import re
from dataclasses import dataclass
from importlib.metadata import PackageNotFoundError, version
from typing import Any
from urllib.request import Request, urlopen


@dataclass(slots=True)
class UpdateInfo:
    current_version: str
    latest_version: str
    release_name: str
    release_url: str
    download_url: str
    asset_name: str
    available: bool


def current_app_version() -> str:
    # package name follows pyproject [project].name
    try:
        return version("workflow-runtime")
    except PackageNotFoundError:
        return "0.0.0"


def _normalize_tag(tag: str) -> str:
    text = tag.strip()
    if text.lower().startswith("v"):
        text = text[1:]
    return text


def _version_key(text: str) -> tuple[int, ...]:
    raw = _normalize_tag(text)
    nums = re.findall(r"\d+", raw)
    if not nums:
        return (0,)
    return tuple(int(x) for x in nums)


def _is_newer(latest: str, current: str) -> bool:
    return _version_key(latest) > _version_key(current)


def _choose_asset(assets: list[dict[str, Any]], asset_pattern: str) -> tuple[str, str]:
    if not assets:
        return "", ""
    pattern = asset_pattern.strip()
    if pattern:
        for item in assets:
            name = str(item.get("name", "")).strip()
            if not name:
                continue
            if fnmatch.fnmatch(name, pattern):
                return name, str(item.get("browser_download_url", "")).strip()
    first = assets[0]
    return str(first.get("name", "")).strip(), str(first.get("browser_download_url", "")).strip()


def check_for_update(
    *,
    feed_url: str,
    current_version_text: str,
    asset_pattern: str = "",
    timeout_sec: float = 6.0,
) -> UpdateInfo:
    url = feed_url.strip()
    if not url:
        return UpdateInfo(
            current_version=current_version_text,
            latest_version=current_version_text,
            release_name="",
            release_url="",
            download_url="",
            asset_name="",
            available=False,
        )

    req = Request(
        url,
        headers={
            "User-Agent": "workflow-desktop-updater",
            "Accept": "application/vnd.github+json",
        },
    )
    with urlopen(req, timeout=max(1.0, timeout_sec)) as resp:
        raw = resp.read()
    payload = json.loads(raw.decode("utf-8"))
    latest_tag = str(payload.get("tag_name", "")).strip()
    latest_version = _normalize_tag(latest_tag) or current_version_text
    release_name = str(payload.get("name", "")).strip() or latest_tag
    release_url = str(payload.get("html_url", "")).strip()
    assets = payload.get("assets")
    if not isinstance(assets, list):
        assets = []
    asset_name, download_url = _choose_asset(assets, asset_pattern)
    available = _is_newer(latest_version, current_version_text)
    return UpdateInfo(
        current_version=current_version_text,
        latest_version=latest_version,
        release_name=release_name,
        release_url=release_url,
        download_url=download_url,
        asset_name=asset_name,
        available=available,
    )
