from __future__ import annotations

import unittest

from workflow_desktop.i18n import normalize_language, translate_text


class DesktopI18nTests(unittest.TestCase):
    def test_normalize_language(self) -> None:
        self.assertEqual(normalize_language("zh"), "zh-CN")
        self.assertEqual(normalize_language("zh-CN"), "zh-CN")
        self.assertEqual(normalize_language("en-US"), "en-US")
        self.assertEqual(normalize_language("anything"), "en-US")

    def test_translate_text_bidirectional(self) -> None:
        self.assertEqual(translate_text("Task Center", "zh-CN"), "任务中心")
        self.assertEqual(translate_text("任务中心", "en-US"), "Task Center")


if __name__ == "__main__":
    unittest.main()
