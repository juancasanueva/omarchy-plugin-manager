"""Real QML runtime test; only Commons theme values and the panel owner are mocked.

Copies the installed WidgetButton unchanged, never imports the live shell, and
extracts the shipped recovery control rather than duplicating its signal API.
SettingsInfo uses the shipped component and Model with a theme-only fixture.
All fixture writes are confined to a test-owned temporary directory.
"""

from pathlib import Path
import re
import tempfile
import unittest

try:
    from PySide6.QtCore import QPointF, Qt, QUrl
    from PySide6.QtGui import QGuiApplication
    from PySide6.QtQml import QQmlComponent, QQmlEngine, QQmlExpression
    from PySide6.QtQuick import QQuickItem, QQuickWindow
    from PySide6.QtTest import QTest
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


@unittest.skipIf(QGuiApplication is None, "PySide6 unavailable: no real QML runtime evidence")
class SettingsInfoTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.app = QGuiApplication.instance() or QGuiApplication([])

    def test_metadata_wraps_and_navigation_stays_signal_only(self):
        with tempfile.TemporaryDirectory(prefix="settings-info-") as directory:
            fixture = Path(directory)
            commons = fixture / "qs" / "Commons"
            commons.mkdir(parents=True)
            for name in ("SettingsInfo.qml", "Model.js"):
                (fixture / name).write_bytes((PANEL.parent / name).read_bytes())
            (commons / "qmldir").write_text("module qs.Commons\nsingleton Style 1.0 Style.qml\n")
            (commons / "Style.qml").write_text('''pragma Singleton
import QtQuick
QtObject {
    readonly property var font: ({body: 14, title: 18})
    readonly property color normalFill: "#222222"
    readonly property int cornerRadius: 8
    function space(value) { return value }
}
''')
            engine = QQmlEngine()
            engine.addImportPath(str(fixture))
            warnings = []
            engine.warnings.connect(lambda errors: warnings.extend(error.toString() for error in errors))
            component = QQmlComponent(engine, QUrl.fromLocalFile(str(fixture / "SettingsInfo.qml")))
            self.assertEqual(component.status(), QQmlComponent.Ready,
                             "\n".join(error.toString() for error in component.errors()))
            path = "/home/" + "long-home-name" * 12 + "/.config/omarchy/plugins"
            owner = component.createWithInitialProperties({
                "pluginsBasePath": path, "foreground": "white",
                "secondaryForeground": "#bbbbbb", "fontFamily": "sans-serif", "width": 420,
            })
            self.assertIsNotNone(owner, "\n".join(error.toString() for error in component.errors()))
            window = QQuickWindow()
            window.resize(500, 1200)
            owner.setParentItem(window.contentItem())
            window.show()
            try:
                repository = "https://github.com/juancasanueva/omarchy-plugin-manager"
                repo_events, version_events = [], []
                owner.repositoryNavigationRequested.connect(repo_events.append)
                owner.githubNavigationRequested.connect(
                    lambda candidates, fallback: version_events.append((candidates.toVariant(), fallback)))
                repo_link = owner.findChild(QQuickItem, "repositoryLink")
                version_link = owner.findChild(QQuickItem, "versionLink")
                path_text = owner.findChild(QQuickItem, "installationPath")

                def settle():
                    QTest.qWait(30)

                def click(item, button=Qt.LeftButton):
                    point = item.mapToScene(QPointF(item.width() / 2, item.height() / 2)).toPoint()
                    QTest.mouseClick(window, button, Qt.NoModifier, point)
                    settle()

                settle()
                self.assertEqual(path_text.property("text"), "Installed in " + path)
                self.assertEqual(version_link.property("text"), "Version unavailable")
                self.assertFalse(version_link.isEnabled())
                click(version_link)
                self.assertEqual(version_events, [])
                click(repo_link, Qt.RightButton)
                self.assertEqual(repo_events, [])
                click(repo_link)
                self.assertEqual(repo_events, [repository])
                owner.setProperty("installedVersion", "2.3.4")
                settle()
                self.assertEqual(version_link.property("text"), "Version v2.3.4")
                self.assertTrue(version_link.isEnabled())
                click(version_link)
                candidates, fallback = version_events[0]
                self.assertEqual(fallback, repository)
                self.assertEqual([item["preferredUrl"] for item in candidates],
                                 [repository + "/releases/tag/v2.3.4", repository + "/releases/tag/2.3.4"])
                for version in ("", "vvv", "x" * 101):
                    owner.setProperty("installedVersion", version)
                    settle()
                    self.assertFalse(version_link.isEnabled())
                    click(version_link)
                self.assertEqual(len(version_events), 1)
                owner.setProperty("installedVersion", "1." + "2" * 90)
                heights = []
                for width in (420, 220):
                    owner.setWidth(width)
                    settle()
                    heights.append(owner.implicitHeight())
                    for text in owner.findChildren(QQuickItem):
                        if text.property("text") is not None:
                            plain = QQmlExpression(engine.rootContext(), text, "textFormat === 0")
                            self.assertTrue(plain.evaluate()[0])  # PlainText
                            self.assertLessEqual(text.property("contentWidth"), text.width() + 1)
                            self.assertLessEqual(text.property("contentHeight"), text.height() + 1)
                    sections = owner.childItems()
                    self.assertEqual(len(sections), 4)  # Info, path card, About, identity card
                    for previous, following in zip(sections, sections[1:]):
                        self.assertAlmostEqual(following.y() - previous.y() - previous.height(), 14)
                    self.assertAlmostEqual(sections[-1].y() + sections[-1].height(), owner.implicitHeight())
                self.assertGreater(heights[1], heights[0])
                self.assertEqual(warnings, [])
            finally:
                window.close()
                owner.deleteLater()
                window.deleteLater()
                self.app.sendPostedEvents(None, 0)


if __name__ == "__main__":
    unittest.main()
