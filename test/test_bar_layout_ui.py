"""Real QtQuick pointer tests; no shell, IPC, or configuration writes."""
import json
import os
from pathlib import Path
import unittest

os.environ["QML_DISABLE_DISK_CACHE"] = "1"

from PySide6.QtCore import QPoint, QUrl, Qt
from PySide6.QtGui import QGuiApplication
from PySide6.QtQml import QQmlComponent, QQmlExpression, QQmlEngine
from PySide6.QtQuick import QQuickView
from PySide6.QtTest import QTest


class BarLayoutUI(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.app = QGuiApplication.instance() or QGuiApplication([])

    def setUp(self):
        self.view = QQuickView()
        self.view.resize(630, 330)
        # Disable disk caching: this fixture never generates files outside its scope.
        self.component = QQmlComponent(self.view.engine())
        self.component.setData(b"""
            import QtQuick
            Item {
                property int dismissCount: 0
                Keys.onEscapePressed: event => {
                    dismissCount += 1;
                    event.accepted = true;
                }
                BarLayoutPane {
                    objectName: "board"
                    anchors.fill: parent
                }
            }
        """, QUrl.fromLocalFile(str(
            Path(__file__).resolve().parents[1] / "KeyPropagationHarness.qml")))
        self.assertFalse(self.component.isError(), self.component.errors())
        self.host = self.component.create()
        self.assertIsNotNone(self.host, self.component.errors())
        self.root = self.item("board", self.host)
        self.assertIsNotNone(self.root)
        self.view.setResizeMode(QQuickView.SizeRootObjectToView)
        self.view.setContent(QUrl(), self.component, self.host)
        self.moves = []
        self.root.moveRequested.connect(lambda snapshot, *args: self.moves.append(
            (snapshot, *args)))
        self.load({"left": ["one", "same", "same"], "center": ["clock"], "right": []})
        self.view.show()
        QTest.qWait(30)

    def tearDown(self):
        self.view.close()
        self.view.deleteLater()
        self.app.processEvents()

    def load(self, layout):
        rows = [{"id": entry, "section": section, "index": index, "entry": entry}
                for section, entries in layout.items() for index, entry in enumerate(entries)]
        self.snapshot = {"layout": layout, "rows": rows, "key": json.dumps(layout)}
        self.root.setProperty("snapshot", self.snapshot)
        self.app.processEvents()

    def item(self, name, parent=None):
        parent = parent or self.root
        if parent.objectName() == name:
            return parent
        for child in parent.childItems():
            found = self.item(name, child)
            if found is not None:
                return found

    def point(self, section, row=0, fraction=0.5):
        column = self.item("viewport-" + section)
        self.assertIsNotNone(column)
        pitch = self.root.property("rowHeight") + self.root.property("spacing")
        return column.mapToScene(QPoint(30, int(row * pitch + fraction *
            self.root.property("rowHeight") - column.property("contentY")))).toPoint()

    def press(self, section="left", row=0):
        point = self.point(section, row)
        QTest.mousePress(self.view, Qt.LeftButton, Qt.NoModifier, point)
        return point

    def drop(self, target):
        QTest.mouseMove(self.view, target, 10)
        QTest.mouseRelease(self.view, Qt.LeftButton, Qt.NoModifier, target)
        self.app.processEvents()

    def test_cross_empty_and_original_snapshot(self):
        self.press(row=2)
        self.drop(self.point("right"))
        self.assertEqual(self.moves, [(self.snapshot, "left", 2, "right", 0)])
        self.assertFalse(self.root.property("dragging"))

    def test_same_section_pre_removal_gap(self):
        self.press()
        self.drop(self.point("left", 2, 0.9))
        self.assertEqual(self.moves[0][1:], ("left", 0, "left", 3))

    def test_duplicate_instances_and_cross_insertion(self):
        self.press(row=1)
        self.drop(self.point("center", 0, 0.1))
        self.assertEqual(self.moves[0][1:], ("left", 1, "center", 0))

    def test_threshold_and_no_op(self):
        start = self.press()
        self.drop(start + QPoint(1, 1))
        self.press()
        self.drop(start + QPoint(20, 0))
        self.assertEqual(self.moves, [])

    def test_cancel_paths_and_busy(self):
        for cancel in ("escape", "outside", "hidden", "snapshot", "busy", "explicit"):
            with self.subTest(cancel=cancel):
                self.root.setProperty("visible", True)
                self.root.setProperty("busy", False)
                self.press()
                target = self.point("center")
                QTest.mouseMove(self.view, target, 10)
                self.assertTrue(self.root.property("dragging"))
                if cancel == "escape":
                    QTest.keyClick(self.view, Qt.Key_Escape)
                elif cancel == "outside":
                    target = QPoint(-10, -10)
                elif cancel == "hidden":
                    self.root.setProperty("visible", False)
                elif cancel == "snapshot":
                    self.load({"left": ["one", "same", "same"], "center": [], "right": []})
                elif cancel == "busy":
                    self.root.setProperty("busy", True)
                else:
                    self.root.cancelDrag()
                self.drop(target)
                self.assertFalse(self.root.property("dragging"))
                self.assertEqual(self.moves, [])
        self.root.setProperty("busy", True)
        self.press()
        self.drop(self.point("right"))
        self.assertEqual(self.moves, [])

    def test_escape_consumes_held_gesture_then_bubbles(self):
        for dragging in (False, True):
            with self.subTest(dragging=dragging):
                self.host.setProperty("dismissCount", 0)
                start = self.press()
                if dragging:
                    QTest.mouseMove(self.view, self.point("center"), 10)
                self.assertEqual(self.root.property("dragging"), dragging)
                self.assertIsNotNone(self.root.property("heldSnapshot"))
                self.assertTrue(self.root.hasActiveFocus())

                QTest.keyClick(self.view, Qt.Key_Escape)
                self.assertIsNone(self.root.property("heldSnapshot"))
                self.assertFalse(self.root.property("dragging"))
                self.assertEqual(self.host.property("dismissCount"), 0)
                self.drop(start)
                self.assertEqual(self.moves, [])
                self.assertTrue(self.root.hasActiveFocus())

                QTest.keyClick(self.view, Qt.Key_Escape)
                self.assertEqual(self.host.property("dismissCount"), 1)

    def test_escape_bubbles_after_drop_or_cancel(self):
        for finish in ("drop", "cancel"):
            with self.subTest(finish=finish):
                self.host.setProperty("dismissCount", 0)
                self.moves.clear()
                self.press()
                target = self.point("center")
                QTest.mouseMove(self.view, target, 10)
                self.assertTrue(self.root.property("dragging"))
                if finish == "cancel":
                    self.root.cancelDrag()
                self.drop(target)
                self.assertEqual(len(self.moves), 1 if finish == "drop" else 0)
                self.assertIsNone(self.root.property("heldSnapshot"))
                self.assertTrue(self.root.hasActiveFocus())

                QTest.keyClick(self.view, Qt.Key_Escape)
                self.assertEqual(self.host.property("dismissCount"), 1)

    def test_scrolled_source_and_destination(self):
        self.load({"left": [str(i) for i in range(20)],
                   "center": [str(i) for i in range(20)], "right": []})
        pitch = self.root.property("rowHeight") + self.root.property("spacing")
        for section in ("left", "center"):
            self.item("viewport-" + section).setProperty("contentY", pitch * 8)
        self.press(row=9)
        self.drop(self.point("center", 10, 0.1))
        self.assertEqual(self.moves[0][1:], ("left", 9, "center", 10))

    def test_timer_edge_scroll_and_drop_gap(self):
        self.load({"left": ["one"], "center": [str(i) for i in range(20)], "right": []})
        view = self.item("viewport-center")
        bottom = view.mapToScene(QPoint(30, int(view.height()) - 2)).toPoint()
        self.press()
        QTest.mouseMove(self.view, bottom, 10)
        QTest.qWait(240)
        self.assertGreater(view.property("contentY"), 0)
        maximum = view.property("contentHeight") - view.height()
        view.setProperty("contentY", maximum - 1)
        QTest.qWait(90)
        self.assertEqual(view.property("contentY"), maximum)
        top = view.mapToScene(QPoint(30, 2)).toPoint()
        QTest.mouseMove(self.view, top, 10)
        QTest.qWait(120)
        self.assertLess(view.property("contentY"), maximum)
        view.setProperty("contentY", 1)
        QTest.qWait(90)
        self.assertEqual(view.property("contentY"), 0)
        QTest.mouseMove(self.view, bottom, 10)
        QTest.qWait(120)
        pitch = self.root.property("rowHeight") + self.root.property("spacing")
        gap = int((bottom.y() - view.mapToScene(QPoint()).y() +
                   view.property("contentY") + self.root.property("spacing") / 2) / pitch + 0.5)
        QTest.mouseRelease(self.view, Qt.LeftButton, Qt.NoModifier, bottom, 0)
        self.assertEqual(self.moves[0][1:], ("left", 0, "center", gap))

    def test_lost_mouse_grab_cancels(self):
        self.press()
        QTest.mouseMove(self.view, self.point("center"), 10)
        self.assertTrue(self.root.property("dragging"))
        self.view.mouseGrabberItem().ungrabMouse()
        self.assertFalse(self.root.property("dragging"))
        self.drop(self.point("center"))
        self.assertEqual(self.moves, [])

    def test_plain_bounded_label_stationary_placeholder_and_ghost(self):
        hostile = "<b>Name</b>\n\u202e" + "x" * 200
        self.root.setProperty("labels", {"one": hostile})
        row, ghost = self.item("row-left-0"), self.item("drag-ghost")
        position = row.position()
        self.assertFalse(ghost.isVisible())
        self.press()
        QTest.mouseMove(self.view, self.point("center"), 10)
        self.assertTrue(ghost.isVisible())
        self.assertEqual(row.position(), position)
        self.assertAlmostEqual(row.opacity(), 0.3)
        self.assertTrue(self.item("insertion-center").isVisible())
        for card in (row, ghost):
            self.assertEqual(card.property("labelText"), hostile[:120].replace("\n", "").replace("\u202e", ""))
            for caption in card.childItems():
                expression = QQmlExpression(QQmlEngine.contextForObject(caption), caption,
                                           "textFormat === Text.PlainText")
                self.assertEqual(expression.evaluate(), (True, False))
        self.root.cancelDrag()
        self.assertFalse(ghost.isVisible())
        self.assertEqual(row.opacity(), 1)
        self.assertFalse(self.item("insertion-center").isVisible())


if __name__ == "__main__":
    unittest.main()
