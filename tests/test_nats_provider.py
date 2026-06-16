from __future__ import annotations

import unittest

from workflow_transport.nats_provider import mask_nats_server_url, normalize_nats_server_url


class NatsProviderTests(unittest.TestCase):
    def test_normalize_nats_server_url_strips_trailing_parts(self) -> None:
        raw = " nats://workflow:secret@192.168.0.103:4222/path?q=1#x "
        got = normalize_nats_server_url(raw)
        self.assertEqual(got, "nats://workflow:secret@192.168.0.103:4222")

    def test_normalize_nats_server_url_rejects_invalid_inputs(self) -> None:
        with self.assertRaises(ValueError):
            normalize_nats_server_url("")
        with self.assertRaises(ValueError):
            normalize_nats_server_url("http://127.0.0.1:4222")
        with self.assertRaises(ValueError):
            normalize_nats_server_url("nats://127.0.0.1")
        with self.assertRaises(ValueError):
            normalize_nats_server_url("nats://127.0.0.1:abc")

    def test_mask_nats_server_url_hides_password(self) -> None:
        raw = "nats://workflow:ChangeMe_123456@192.168.0.103:4222"
        got = mask_nats_server_url(raw)
        self.assertEqual(got, "nats://workflow:***@192.168.0.103:4222")


if __name__ == "__main__":
    unittest.main()
