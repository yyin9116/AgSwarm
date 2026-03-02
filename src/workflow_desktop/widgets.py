from __future__ import annotations

from pathlib import Path

from PySide6.QtCore import Qt, Signal
from PySide6.QtWidgets import QListWidget, QListWidgetItem


class DropPathListWidget(QListWidget):
    paths_dropped = Signal(list)

    def __init__(self) -> None:
        super().__init__()
        self.setAcceptDrops(True)
        self.setAlternatingRowColors(True)
        self.setSelectionMode(QListWidget.ExtendedSelection)
        self.setToolTip("Drag files/folders here.")

    def dragEnterEvent(self, event) -> None:  # type: ignore[override]
        if event.mimeData().hasUrls():
            event.acceptProposedAction()
            return
        super().dragEnterEvent(event)

    def dropEvent(self, event) -> None:  # type: ignore[override]
        if not event.mimeData().hasUrls():
            super().dropEvent(event)
            return
        incoming: list[str] = []
        for url in event.mimeData().urls():
            if not url.isLocalFile():
                continue
            path = url.toLocalFile()
            if path:
                incoming.append(path)
        if incoming:
            self.add_paths(incoming)
            self.paths_dropped.emit(incoming)
        event.acceptProposedAction()

    def add_paths(self, paths: list[str]) -> None:
        existing = set(self.iter_paths())
        for raw in paths:
            value = str(Path(raw))
            if value in existing:
                continue
            item = QListWidgetItem(value)
            item.setToolTip(value)
            self.addItem(item)
            existing.add(value)

    def iter_paths(self) -> list[str]:
        values: list[str] = []
        for i in range(self.count()):
            item = self.item(i)
            if item is not None:
                values.append(item.text())
        return values

    def remove_selected(self) -> None:
        rows = sorted((index.row() for index in self.selectedIndexes()), reverse=True)
        for row in rows:
            self.takeItem(row)
