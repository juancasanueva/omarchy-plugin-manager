"""Real QML runtime test; only Commons theme values and the panel owner are mocked.

Copies the installed WidgetButton unchanged, never imports the live shell, and
extracts the shipped recovery control rather than duplicating its signal API.
SettingsInfo uses the actual host Button, BorderSurface, BorderOverlay and Border;
only Color/Style theme values are mocked, never the button's behavior.
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
            ui = fixture / "qs" / "Ui"
            ui.mkdir(parents=True)
            host = Path("/usr/share/omarchy/shell")
            for name in ("Button.qml", "BorderSurface.qml", "BorderOverlay.qml"):
                self.assertTrue((host / "Ui" / name).is_file(), f"Actual host {name} required")
                (ui / name).write_bytes((host / "Ui" / name).read_bytes())
            for name in ("Border.qml", "BorderGeometry.js"):
                (commons / name).write_bytes((host / "Commons" / name).read_bytes())
            (ui / "qmldir").write_text("module qs.Ui\nButton 1.0 Button.qml\n"
                                      "BorderSurface 1.0 BorderSurface.qml\nBorderOverlay 1.0 BorderOverlay.qml\n")
            (commons / "qmldir").write_text("module qs.Commons\nsingleton Style 1.0 Style.qml\n"
                                           "singleton Color 1.0 Color.qml\nsingleton Border 1.0 Border.qml\n")
            (commons / "Color.qml").write_text('''pragma Singleton
import QtQuick
QtObject {
    readonly property color foreground: "white"
    readonly property color background: "#222222"
    readonly property color accent: "#aabbcc"
    readonly property color urgent: "#ff4444"
    readonly property var shellValues: ({})
    readonly property var tooltip: ({background: "#222222", text: "white", border: "#888888"})
}
''')
            (commons / "Style.qml").write_text('''pragma Singleton
import QtQuick
QtObject {
    readonly property var font: ({family: "sans-serif", body: 14, title: 18, caption: 12, icon: 16, bodySmall: 12})
    readonly property var spacing: ({controlPaddingX: 8, controlPaddingY: 6, controlGap: 6})
    readonly property var styleOverrides: ({})
    readonly property color normalFill: "#222222"
    readonly property int cornerRadius: 8
    readonly property int normalBorderWidth: 1
    readonly property int focusBorderWidth: 1
    readonly property int hoverBorderWidth: 1
    readonly property int selectedBorderWidth: 1
    readonly property real normalBorderAlpha: 0.4
    readonly property real focusBorderAlpha: 1
    readonly property real hoverBorderAlpha: 1
    readonly property real selectedBorderAlpha: 1
    function normalStateColor(fg, accent) { return fg }
    function focusStateColor(fg, accent) { return accent }
    function hoverStateColor(fg, accent) { return accent }
    function selectedStateColor(fg, accent) { return accent }
    function pressedFillFor(fg, accent) { return "#444444" }
    function focusFillFor(fg, accent) { return "#333333" }
    function hoverFillFor(fg, accent) { return "#333333" }
    function selectedFillFor(fg, accent) { return "#333333" }
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
                "pluginsBasePath": path, "updateDataPath": path + "-updates",
                "updateDataCount": "12/32", "cleanupEnabled": True, "foreground": "white",
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
                self.assertEqual(path_text.property("text"), "Plugins installed in " + path)
                update_path = owner.findChild(QQuickItem, "updateDataPathText")
                self.assertEqual(update_path.property("text"), "Plugin Manager Updates are in " + path + "-updates")
                counter = owner.findChild(QQuickItem, "updateDataCounter")
                self.assertEqual(counter.property("text"), "12/32")
                delete_button = owner.findChild(QQuickItem, "deleteUpdateDataButton")
                self.assertIsNotNone(delete_button)
                self.assertTrue(delete_button.property("bordered"))
                cleanup_events = []
                owner.cleanupRequested.connect(lambda: cleanup_events.append(True))
                click(delete_button, Qt.RightButton)
                self.assertEqual(cleanup_events, [])
                click(delete_button)
                self.assertEqual(cleanup_events, [True])
                owner.setProperty("cleanupEnabled", False)
                click(delete_button)
                self.assertEqual(cleanup_events, [True])
                owner.setProperty("cleanupOutcome", "Cleanup partial. Sampled entries: removed 1; preserved 2. Inspect retained history.")
                outcome = owner.findChild(QQuickItem, "cleanupOutcomeText")
                settle()
                self.assertTrue(outcome.isVisible())
                self.assertIn("removed 1; preserved 2", outcome.property("text"))
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
                for width in (420, 220, 140):
                    owner.setWidth(width)
                    settle()
                    heights.append(owner.implicitHeight())
                    for text in owner.findChildren(QQuickItem):
                        if text.isVisible() and text.metaObject().indexOfProperty("textFormat") >= 0:
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
                self.assertGreater(heights[2], heights[1])
                self.assertLessEqual(delete_button.width(), owner.width() - 24)
                owner.setProperty("pluginsBasePath", "")
                owner.setProperty("updateDataPath", "")
                owner.setProperty("updateDataLoading", True)
                settle()
                self.assertEqual(path_text.property("text"), "Plugins installed in Loading…")
                owner.setProperty("updateDataLoading", False)
                settle()
                self.assertEqual(update_path.property("text"), "Plugin Manager Updates are in Unavailable")
                self.assertEqual(warnings, [])
            finally:
                window.close()
                owner.deleteLater()
                window.deleteLater()
                self.app.sendPostedEvents(None, 0)


@unittest.skipIf(QGuiApplication is None, "PySide6 unavailable: no real QML runtime evidence")
class UpdateDataStoreRuntimeTest(unittest.TestCase):
    """Shipped store and Model in Qt; process/file transports are inert doubles.

    This checks QML bindings, dynamically created Process objects and deferred
    callbacks without loading the live shell or invoking any real helper.
    """

    @classmethod
    def setUpClass(cls):
        cls.app = QGuiApplication.instance() or QGuiApplication([])

    def test_store_bindings_confirmation_and_deferred_process_lifecycle(self):
        with tempfile.TemporaryDirectory(prefix="update-data-qml-") as directory:
            fixture = Path(directory)
            for name in ("PluginStore.qml", "Model.js"):
                (fixture / name).write_bytes((PANEL.parent / name).read_bytes())
            quickshell = fixture / "Quickshell"
            io = quickshell / "Io"
            io.mkdir(parents=True)
            (quickshell / "qmldir").write_text("module Quickshell\nsingleton Quickshell 1.0 Quickshell.qml\n")
            (quickshell / "Quickshell.qml").write_text('''pragma Singleton
import QtQml
QtObject {
    function env(name) { return "" }
    function execDetached(command) { throw new Error("No detached work allowed in this fixture") }
}
''')
            (io / "qmldir").write_text("module Quickshell.Io\nProcess 1.0 Process.qml\n"
                "SplitParser 1.0 SplitParser.qml\nStdioCollector 1.0 StdioCollector.qml\nFileView 1.0 FileView.qml\n")
            (io / "Process.qml").write_text('''import QtQuick
Item {
    property bool running: false
    property var command: []
    property bool clearEnvironment: false
    property bool stdinEnabled: false
    property var stdout: null
    property var stderr: null
    property int termSignals: 0
    signal exited(int code, int status)
    signal started()
    function signal(number) { if (number !== 15) throw new Error("Only TERM allowed"); termSignals++ }
    function write(data) {}
    function closeWriteChannel() {}
}
''')
            (io / "SplitParser.qml").write_text('''import QtQml
QtObject { property string splitMarker: ""; signal read(string data) }
''')
            (io / "StdioCollector.qml").write_text('''import QtQml
QtObject { property bool waitForEnd: false; property string text: ""; signal streamFinished() }
''')
            (io / "FileView.qml").write_text('''import QtQml
QtObject {
    property string path: ""
    property bool preload: false
    property bool blockAllReads: true
    property bool watchChanges: false
    property bool printErrors: false
    signal fileChanged()
}
''')
            engine = QQmlEngine()
            engine.addImportPath(str(fixture))
            warnings = []
            engine.warnings.connect(lambda errors: warnings.extend(error.toString() for error in errors))
            component = QQmlComponent(engine, QUrl.fromLocalFile(str(fixture / "PluginStore.qml")))
            self.assertEqual(component.status(), QQmlComponent.Ready,
                             "\n".join(error.toString() for error in component.errors()))
            owner = component.create()
            self.assertIsNotNone(owner, "\n".join(error.toString() for error in component.errors()))

            def js(source):
                expression = QQmlExpression(engine.rootContext(), owner, source)
                value = expression.evaluate()[0]
                self.assertFalse(expression.hasError(), expression.error().toString())
                return value

            def settle():
                QTest.qWait(30)

            ready = '''({schemaVersion: 1, available: true, activeCount: 0, lowerBound: false,
                limit: 32, error: "", paths: {plugins: "/home/test/.config/omarchy/plugins",
                active: "/home/test/.config/omarchy/plugin-manager-updates",
                archive: "/home/test/.config/omarchy/plugin-manager-updates-archive"}})'''
            try:
                self.assertFalse(owner.property("cleanupEnabled"))
                js("refreshUpdateData()")
                settle()
                self.assertTrue(owner.property("updateDataLoading"))
                self.assertTrue(js("updateDataProcess.running"))
                # Exit before the final raw chunk, but both in the same event
                # turn: interpretation is deferred and consumes that final data.
                js("updateDataProcess.running = false; updateDataProcess.exited(0, 0); "
                   "updateDataProcess.stdout.read(JSON.stringify(" + ready + "))")
                settle()
                self.assertEqual(owner.property("updateDataCount"), "0/32")
                self.assertTrue(owner.property("cleanupEnabled"), "archive can contain completed data")
                js("askCleanupUpdateData(); cancelPending(); confirmPending()")
                self.assertTrue(js("cleanupProcess === null"))
                js("askCleanupUpdateData(); externalBusy = true; confirmPending()")
                self.assertTrue(js("cleanupProcess === null"))
                js("externalBusy = false; askCleanupUpdateData(); confirmPending(); confirmPending()")
                settle()
                self.assertTrue(owner.property("busy"))
                self.assertTrue(owner.property("actionRunning"))
                self.assertFalse(owner.property("cleanupEnabled"))
                self.assertEqual(js("cleanupProcess.command[10]"), "--cleanup-completed")
                js('''cleanupProcess.stdout.read(JSON.stringify({schemaVersion: 1, status: "complete",
                    discovered: 2, visited: 2, removed: 1, preserved: 1, partial: 0,
                    removedUnsynced: 0, unknown: 0, discoveryComplete: true,
                    refreshRequired: true, error: ""}));
                    cleanupProcess.running = false; cleanupProcess.exited(0, 0)''')
                settle()
                self.assertFalse(owner.property("busy"))
                self.assertTrue(owner.property("updateDataLoading"))
                self.assertEqual(js("updateDataProcess.command[10]"), "--update-data-status")
                self.assertIn("removed 1; preserved 1", owner.property("cleanupOutcome"))
                js("refreshUpdateData()")
                self.assertGreater(js("updateDataProcess.termSignals"), 0)
                js("updateDataProcess.stdout.read(JSON.stringify(" + ready + ")); "
                   "updateDataProcess.running = false; updateDataProcess.exited(0, 0)")
                settle()
                self.assertTrue(owner.property("updateDataLoading"), "retired response never restores count")
                self.assertEqual(owner.property("updateDataCount"), "Loading…")
                js("stopUpdateDataProcesses()")
                self.assertEqual(js("updateDataProcess.termSignals"), 1)
                self.assertEqual(warnings, [])
            finally:
                owner.deleteLater()
                self.app.sendPostedEvents(None, 0)


if __name__ == "__main__":
    unittest.main()
