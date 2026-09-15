"""Real QML runtime test; only Commons theme values and the panel owner are mocked.

Copies the installed WidgetButton unchanged, never imports the live shell, and
extracts the shipped recovery control rather than duplicating its signal API.
All fixture writes are confined to a test-owned temporary directory.
"""

from pathlib import Path
import re
import tempfile
import unittest

try:
    from PySide6.QtCore import Qt, QUrl
    from PySide6.QtGui import QGuiApplication
    from PySide6.QtQml import QQmlComponent, QQmlEngine
    from PySide6.QtQuick import QQuickItem
except ImportError:
    QGuiApplication = None


HOST_BUTTON = Path("/usr/share/omarchy/shell/Ui/WidgetButton.qml")
PANEL = Path(__file__).resolve().parents[1] / "Panel.qml"


def recovery_control():
    source = PANEL.read_text()
    marker = source.index('text: "Review layout"')
    start = source.rfind("WidgetButton {", 0, marker)
    if start < 0:
        raise AssertionError("Review layout WidgetButton not found")
    # Ignore braces inside strings/comments while finding the complete block.
    tokens = re.finditer(r'"(?:\\.|[^"\\])*"|//[^\n]*|/\*[\s\S]*?\*/|[{}]', source[start:])
    depth = 0
    for token in tokens:
        if token.group() == "{":
            depth += 1
        elif token.group() == "}":
            depth -= 1
            if depth == 0:
                return source[start:start + token.end()]
    raise AssertionError("Unterminated recovery control")


@unittest.skipIf(QGuiApplication is None, "PySide6 unavailable: no real QML runtime evidence")
@unittest.skipUnless(HOST_BUTTON.is_file(), "Installed host WidgetButton unavailable: no host API evidence")
class PopupRecoveryControlTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.app = QGuiApplication.instance() or QGuiApplication([])

    def test_host_control_instantiates_and_only_left_press_opens_arrange(self):
        with tempfile.TemporaryDirectory(prefix="popup-controls-") as directory:
            fixture = Path(directory)
            commons = fixture / "qs" / "Commons"
            commons.mkdir(parents=True)
            (fixture / "WidgetButton.qml").write_bytes(HOST_BUTTON.read_bytes())
            (commons / "qmldir").write_text(
                "module qs.Commons\nsingleton Style 1.0 Style.qml\n"
                "singleton Color 1.0 Color.qml\n"
            )
            (commons / "Style.qml").write_text('''pragma Singleton
import QtQml
QtObject {
    readonly property var font: ({family: "sans-serif", body: 14})
    readonly property var bar: ({sizeHorizontal: 30})
    function spaceReal(value) { return value }
}
''')
            (commons / "Color.qml").write_text('''pragma Singleton
import QtQuick
QtObject {
    readonly property color foreground: "white"
    readonly property color urgent: "red"
}
''')
            engine = QQmlEngine()
            engine.addImportPath(str(fixture))
            warnings = []
            engine.warnings.connect(lambda errors: warnings.extend(error.toString() for error in errors))
            component = QQmlComponent(engine)
            component.setData(('''import QtQuick
Item {
    id: root
    property bool barMovePending: true
    property bool arrangeOpen: false
    property color contentForeground: "white"
    property string contentFontFamily: "sans-serif"
    property int arrangeCalls: 0
    function openArrange() { arrangeCalls += 1; arrangeOpen = true }
''' + recovery_control() + "\n}").encode(), QUrl.fromLocalFile(str(fixture / "Recovery.qml")))
            self.assertEqual(component.status(), QQmlComponent.Ready,
                             "\n".join(error.toString() for error in component.errors()))
            owner = component.create()
            self.assertIsNotNone(owner, "\n".join(error.toString() for error in component.errors()))
            try:
                control = owner.childItems()[0]
                self.assertEqual(control.property("text"), "Review layout")
                self.assertTrue(control.isVisible())
                owner.setProperty("barMovePending", False)
                self.assertFalse(control.isVisible())
                owner.setProperty("barMovePending", True)
                self.assertTrue(control.isVisible())
                for button in (Qt.RightButton, Qt.MiddleButton):
                    control.triggerPress(button.value)
                    self.assertEqual(owner.property("arrangeCalls"), 0)
                    self.assertFalse(owner.property("arrangeOpen"))
                control.triggerPress(Qt.LeftButton.value)
                self.assertEqual(owner.property("arrangeCalls"), 1)
                self.assertTrue(owner.property("arrangeOpen"))
                self.assertFalse(control.isVisible())
                self.assertEqual(warnings, [])
            finally:
                owner.deleteLater()
                self.app.sendPostedEvents(None, 0)


if __name__ == "__main__":
    unittest.main()
