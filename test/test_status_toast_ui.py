"""Real QML runtime test of the status toast.

The shipped StatusToast.qml and Model.js run in a real Qt Quick window; only
the theme singletons are mocked. A notice slides in, leaves on its own, shows
again when the same text is posted twice, holds while hovered, goes on a
click, and is dropped at once when its surface closes.
"""

from pathlib import Path
import shutil
import tempfile
import unittest

try:
    from PySide6.QtCore import Q_ARG, QMetaObject, QPoint, QUrl, Qt
    from PySide6.QtGui import QGuiApplication
    from PySide6.QtQml import QQmlComponent, QQmlEngine
    from PySide6.QtQuick import QQuickItem, QQuickWindow
    from PySide6.QtTest import QTest
except ImportError:
    QGuiApplication = None


ROOT = Path(__file__).resolve().parents[1]

STYLE = '''pragma Singleton
import QtQml
QtObject {
    readonly property var font: ({family: "sans-serif", body: 14, caption: 12})
    readonly property int cornerRadius: 6
    function space(value) { return value }
}
'''
COLOR = '''pragma Singleton
import QtQuick
QtObject {
    readonly property color foreground: "white"
    readonly property color background: "black"
    readonly property color accent: "cyan"
    readonly property color urgent: "red"
}
'''
UTIL = '''pragma Singleton
import QtQuick
QtObject {
    function alpha(color, value) { return Qt.rgba(color.r, color.g, color.b, value) }
}
'''


@unittest.skipIf(QGuiApplication is None, "PySide6 unavailable: no real QML runtime evidence")
class StatusToastTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.app = QGuiApplication.instance() or QGuiApplication([])

    def setUp(self):
        self.directory = tempfile.TemporaryDirectory(prefix="status-toast-")
        fixture = Path(self.directory.name)
        commons = fixture / "qs" / "Commons"
        commons.mkdir(parents=True)
        (commons / "qmldir").write_text("module qs.Commons\nsingleton Style 1.0 Style.qml\n"
                                        "singleton Color 1.0 Color.qml\nsingleton Util 1.0 Util.qml\n")
        (commons / "Style.qml").write_text(STYLE)
        (commons / "Color.qml").write_text(COLOR)
        (commons / "Util.qml").write_text(UTIL)
        ui = fixture / "qs" / "Ui"
        ui.mkdir()
        (ui / "qmldir").write_text("module qs.Ui\n")
        for name in ("StatusToast.qml", "Model.js"):
            shutil.copy(ROOT / name, fixture / name)
        (fixture / "Fixture.qml").write_text('''import QtQuick
Item {
    width: 400
    height: 300
    StatusToast {
        id: toast
        objectName: "toast"
        anchors.horizontalCenter: parent.horizontalCenter
        anchors.bottom: parent.bottom
        anchors.bottomMargin: 10
    }
}
''')
        self.engine = QQmlEngine()
        self.engine.addImportPath(str(fixture))
        self.warnings = []
        self.engine.warnings.connect(lambda errors: self.warnings.extend(e.toString() for e in errors))
        self.component = component = QQmlComponent(self.engine, QUrl.fromLocalFile(str(fixture / "Fixture.qml")))
        self.assertEqual(component.status(), QQmlComponent.Ready,
                         "\n".join(e.toString() for e in component.errors()))
        self.owner = component.create()
        self.toast = self.owner.findChild(QQuickItem, "toast")
        self.assertIsNotNone(self.toast)
        self.window = QQuickWindow()
        self.window.resize(400, 300)
        self.owner.setParentItem(self.window.contentItem())
        self.window.show()
        QTest.qWait(30)

    def tearDown(self):
        self.window.hide()
        self.owner.deleteLater()
        self.app.sendPostedEvents(None, 0)
        self.directory.cleanup()

    def show(self, text, error=False):
        QMetaObject.invokeMethod(self.toast, "show", Q_ARG("QVariant", text), Q_ARG("QVariant", error))

    def on_screen(self):
        return self.toast.property("visible") and self.toast.property("shown")

    def center(self):
        x = self.toast.property("x") + self.toast.property("width") / 2
        y = self.toast.property("y") + self.toast.property("height") / 2
        return QPoint(int(x), int(y))

    def test_slides_in_and_leaves_on_its_own(self):
        self.assertFalse(self.toast.property("visible"))
        self.show("Watching Weather")
        QTest.qWait(60)
        # Mid-animation: on its way in, not yet settled.
        self.assertTrue(self.toast.property("visible"))
        self.assertLess(self.toast.property("reveal"), 1)
        QTest.qWait(500)
        self.assertAlmostEqual(self.toast.property("reveal"), 1, places=3)
        self.assertEqual(self.toast.property("text"), "Watching Weather")
        self.assertFalse(self.toast.property("isError"))
        QTest.qWait(4000)
        self.assertFalse(self.toast.property("shown"))
        QTest.qWait(300)
        self.assertFalse(self.toast.property("visible"))
        self.assertEqual(self.warnings, [])

    def test_the_same_notice_twice_is_seen_twice_and_errors_are_marked(self):
        self.show("Could not save the watch list", True)
        QTest.qWait(400)
        self.assertTrue(self.toast.property("isError"))
        QMetaObject.invokeMethod(self.toast, "hide")
        QTest.qWait(300)
        self.assertFalse(self.toast.property("visible"))
        self.show("Could not save the watch list", True)
        QTest.qWait(400)
        self.assertTrue(self.on_screen())

    def test_hover_holds_it_and_a_click_dismisses_it(self):
        self.show("Enabled Weather")
        QTest.qWait(400)
        QTest.mouseMove(self.window, self.center())
        QTest.qWait(4300)
        self.assertTrue(self.on_screen(), "hovering holds the notice past its time")
        QTest.mouseClick(self.window, Qt.LeftButton, Qt.NoModifier, self.center())
        QTest.qWait(300)
        self.assertFalse(self.toast.property("visible"))

    def test_a_closed_surface_drops_it_at_once_and_ignores_new_notices(self):
        self.show("Removed Weather")
        QTest.qWait(400)
        self.toast.setProperty("active", False)
        QTest.qWait(10)
        self.assertFalse(self.toast.property("visible"))
        self.show("Installed Weather")
        QTest.qWait(400)
        self.assertFalse(self.toast.property("visible"))
        self.toast.setProperty("active", True)
        self.show("Installed Weather")
        QTest.qWait(400)
        self.assertTrue(self.on_screen())


if __name__ == "__main__":
    unittest.main()
