"""Real QML runtime test of the Tab cycle in both surfaces.

Tab must reach the plugin list, not only the filter dropdowns and the search
box. The shipped key catcher declarations are extracted from Panel.qml and
Expanded.qml and run in a real Qt Quick window; the dropdowns and the search
box are stand-ins that join the focus chain the way the host controls do (a
trigger with activeFocusOnTab, and a Qt Quick Controls TextField).
"""

from pathlib import Path
import re
import tempfile
import unittest

try:
    from PySide6.QtCore import QObject, Qt, QUrl
    from PySide6.QtGui import QGuiApplication
    from PySide6.QtQml import QQmlComponent, QQmlEngine
    from PySide6.QtQuick import QQuickWindow
    from PySide6.QtTest import QTest
except ImportError:
    QGuiApplication = None

from test_search_field_ui import balanced, shipped


ROOT = Path(__file__).resolve().parents[1]


def catcher_lines(source, surface):
    """The keyCatcher's own Tab wiring, exactly as shipped."""
    block = balanced(source, shipped(source, r"(?:PanelKeyCatcher|Item) \{\s*id: keyCatcher").start())
    parts = [shipped(block, r"activeFocusOnTab: [^\n]*").group()]
    if surface == "Panel.qml":
        parts.append(balanced(block, shipped(block, r"onTabRequested: function").start()))
    else:
        parts.append(balanced(block, shipped(block, r"Keys.onPressed: function").start()))
    return "\n".join(parts)


# The popup's catcher is the host's PanelKeyCatcher; this is its Tab contract:
# it takes Tab itself and reports a direction.
PANEL_CATCHER = '''import QtQuick
Item {
    property bool blocked: false
    signal tabRequested(int direction)
    focus: true
    Keys.priority: Keys.BeforeItem
    Keys.onPressed: function(event) {
        if (blocked) return
        if (event.key === Qt.Key_Tab || event.key === Qt.Key_Backtab) {
            tabRequested((event.modifiers & Qt.ShiftModifier) || event.key === Qt.Key_Backtab ? -1 : 1)
            event.accepted = true
        }
    }
}
'''

# The host Dropdown: a plain Item whose trigger is the part that takes focus.
DROPDOWN = '''import QtQuick
Item {
    width: 60
    height: 20
    readonly property alias triggerFocused: trigger.activeFocus
    Rectangle {
        id: trigger
        anchors.fill: parent
        activeFocusOnTab: true
        Keys.onPressed: function(event) {
            if (event.key === Qt.Key_Return || event.key === Qt.Key_Space) event.accepted = true
        }
    }
}
'''


@unittest.skipIf(QGuiApplication is None, "PySide6 unavailable: no real QML runtime evidence")
class TabFocusCycleTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.app = QGuiApplication.instance() or QGuiApplication([])

    def fixture(self, directory, surface):
        source = (ROOT / surface).read_text()
        fixture = Path(directory)
        (fixture / "PanelKeyCatcher.qml").write_text(PANEL_CATCHER)
        (fixture / "Dropdown.qml").write_text(DROPDOWN)
        catcher = "PanelKeyCatcher" if surface == "Panel.qml" else "Item"
        return fixture, f'''import QtQuick
import QtQuick.Controls.Basic as C
Item {{
    id: root
    width: 400
    height: 200
    property bool confirming: false
    property bool placing: false
    property bool arrangeOpen: false
    property bool settingsOpen: false
    property bool detailsOpen: false
    property bool browsing: false
    property bool searchFieldFocused: false
    readonly property bool listFocused: keyCatcher.activeFocus
    readonly property bool firstFocused: first.triggerFocused
    readonly property bool secondFocused: second.triggerFocused
    readonly property bool searchFocused: search.activeFocus
    readonly property bool gridFocused: grid.activeFocus
    function focusList() {{ keyCatcher.forceActiveFocus() }}
    function focusGrid() {{ grid.forceActiveFocus() }}
    {catcher} {{
        id: keyCatcher
        anchors.fill: parent
        focus: true
{catcher_lines(source, surface)}
        Row {{
            Dropdown {{ id: first }}
            Dropdown {{ id: second }}
            C.TextField {{ id: search; width: 100 }}
        }}
        Item {{ id: grid; y: 40; width: 100; height: 100 }}
    }}
}}
'''

    def focused(self, owner):
        names = [name for name in ("listFocused", "firstFocused", "secondFocused", "searchFocused", "gridFocused")
                 if owner.property(name)]
        self.assertEqual(len(names), 1, names)
        return names[0]

    def test_tab_cycles_through_the_list(self):
        for surface in ("Panel.qml", "Expanded.qml"):
            with self.subTest(surface=surface), tempfile.TemporaryDirectory(prefix="tab-focus-") as directory:
                fixture, qml = self.fixture(directory, surface)
                engine = QQmlEngine()
                warnings = []
                engine.warnings.connect(lambda errors: warnings.extend(e.toString() for e in errors))
                component = QQmlComponent(engine)
                component.setData(qml.encode(), QUrl.fromLocalFile(str(fixture / "Fixture.qml")))
                self.assertEqual(component.status(), QQmlComponent.Ready,
                                 "\n".join(e.toString() for e in component.errors()))
                owner = component.create()
                window = QQuickWindow()
                window.resize(400, 200)
                owner.setParentItem(window.contentItem())
                window.show()
                try:
                    def press(key, modifier=Qt.NoModifier):
                        QTest.keyClick(window, key, modifier)
                        QTest.qWait(10)

                    owner.metaObject().invokeMethod(owner, "focusList")
                    QTest.qWait(30)
                    self.assertEqual(self.focused(owner), "listFocused")

                    # Forward: list, each filter, search, and back to the list.
                    order = []
                    for _ in range(4):
                        press(Qt.Key_Tab)
                        order.append(self.focused(owner))
                    self.assertEqual(order, ["firstFocused", "secondFocused", "searchFocused", "listFocused"])

                    # Backward walks the same ring the other way.
                    order = []
                    for _ in range(4):
                        press(Qt.Key_Backtab, Qt.ShiftModifier)
                        order.append(self.focused(owner))
                    self.assertEqual(order, ["searchFocused", "secondFocused", "firstFocused", "listFocused"])

                    # A focused grid inside the list leaves it the same way the list does.
                    owner.metaObject().invokeMethod(owner, "focusGrid")
                    QTest.qWait(10)
                    press(Qt.Key_Tab)
                    self.assertEqual(self.focused(owner), "firstFocused")
                    self.assertEqual(warnings, [])
                finally:
                    window.hide()
                    owner.deleteLater()
                    self.app.sendPostedEvents(None, 0)


if __name__ == "__main__":
    unittest.main()
