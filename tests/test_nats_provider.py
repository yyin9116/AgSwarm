from __future__ import annotations

import pytest

from workflow_transport.nats_provider import mask_nats_server_url, normalize_nats_server_url


def test_normalize_nats_server_url_strips_trailing_parts() -> None:
    raw = " nats://workflow:secret@192.168.0.103:4222/path?q=1#x "
    got = normalize_nats_server_url(raw)
    assert got == "nats://workflow:secret@192.168.0.103:4222"


def test_normalize_nats_server_url_rejects_invalid_inputs() -> None:
    with pytest.raises(ValueError):
        normalize_nats_server_url("")
    with pytest.raises(ValueError):
        normalize_nats_server_url("http://127.0.0.1:4222")
    with pytest.raises(ValueError):
        normalize_nats_server_url("nats://127.0.0.1")
    with pytest.raises(ValueError):
        normalize_nats_server_url("nats://127.0.0.1:abc")


def test_mask_nats_server_url_hides_password() -> None:
    raw = "nats://workflow:ChangeMe_123456@192.168.0.103:4222"
    got = mask_nats_server_url(raw)
    assert got == "nats://workflow:***@192.168.0.103:4222"

