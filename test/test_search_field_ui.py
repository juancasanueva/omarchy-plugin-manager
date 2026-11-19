"""Real QML runtime test of the search field's lifetime in both surfaces.

The shipped search plumbing (root term, debounce, flush, clear, focus accessor)
and the shipped Loader block are extracted from Panel.qml and Expanded.qml and
run against a real Qt Quick Controls TextField. Only theme values, the sibling
clear button and the surrounding layout item are mocked. A Qt Quick text input
subscribes to the system clipboard for as long as it exists, so the field must
not exist at all while its surface is closed.
"""

from pathlib import Path
import re
import tempfile
import unittest

try:
    from PySide6.QtCore import QMetaObject, QObject, Qt, QUrl
    from PySide6.QtGui import QGuiApplication
    from PySide6.QtQml import QQmlComponent, QQmlEngine
    from PySide6.QtQuick import QQuickItem, QQuickWindow
    from PySide6.QtTest import QTest
except ImportError:
    QGuiApplication = None


ROOT = Path(__file__).resolve().parents[1]


def balanced(source, start):
    """The complete block opened by the first brace at or after start."""
    tokens = re.finditer(r'"(?:\\.|[^"\\])*"|//[^\n]*|/\*[\s\S]*?\*/|[{}]', source[start:])
    depth = 0
    for token in tokens:
        if token.group() == "{":
            depth += 1
        elif token.group() == "}":
            depth -= 1
            if depth == 0:
                return source[start:start + token.end()]
    raise AssertionError("Unterminated block")


def shipped(source, pattern):
    match = re.search(pattern, source)
    if not match:
        raise AssertionError(f"{pattern} not found")
    return match


def plumbing(source):
    """The root-side search state, exactly as shipped."""
    parts = [
        shipped(source, r'property string searchText: ""').group(),
        shipped(source, r'property string searchQuery: ""').group(),
        shipped(source, r'readonly property bool searchFieldFocused: [^\n]*').group(),
    ]
    for pattern in (r'onSearchTextChanged: \{', r'Timer \{\s*id: searchDebounce',
                    r'function flushSearch\(\) \{', r'function clearSearch\(\) \{',
                    r'function focusSearchField\(\) \{'):
        parts.append(balanced(source, shipped(source, pattern).start()))
    return "\n".join(parts)


def loader_block(source):
    return balanced(source, shipped(source, r'Loader \{\s*id: searchFieldLoader').start())


SURFACES = {
    "Panel.qml": "clearFiltersButton",
    "Expanded.qml": "clearSearchButton",
}


@unittest.skipIf(QGuiApplication is None, "PySide6 unavailable: no real QML runtime evidence")
class SearchFieldLifetimeTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.app = QGuiApplication.instance() or QGuiApplication([])

    def fixture(self, directory, surface):
        source = (ROOT / surface).read_text()
        fixture = Path(directory)
        commons = fixture / "qs" / "Commons"
        commons.mkdir(parents=True)
        (commons / "qmldir").write_text("module qs.Commons\nsingleton Style 1.0 Style.qml\n")
        (commons / "Style.qml").write_text('''pragma Singleton
import QtQml
QtObject {
    readonly property var font: ({family: "sans-serif", body: 14, caption: 12})
    readonly property var spacing: ({xs: 2, controlHeight: 26})
    function space(value) { return value }
}
''')
        # The host Ui TextField is a Qt Quick Controls TextField with a few
        # theme properties; the real control keeps the real QQuickTextInput.
        ui = fixture / "qs" / "Ui"
        ui.mkdir(parents=True)
        (ui / "qmldir").write_text("module qs.Ui\nTextField 1.0 TextField.qml\n")
        (ui / "TextField.qml").write_text('''import QtQuick
import QtQuick.Controls.Basic as C
C.TextField {
    property color foreground: "white"
    property real verticalPadding: 0
}
''')
        # The shipped search box and the model it edits through, unchanged.
        for name in ("SearchField.qml", "Model.js"):
            (fixture / name).write_text((ROOT / name).read_text())
        button = SURFACES[surface]
        return source, fixture, f'''import QtQuick
import qs.Commons
import qs.Ui
Item {{
    id: root
    width: 600
    height: 200
    property bool opened: false
    property bool browsing: false
    property bool catalogFiltered: false
    property color contentForeground: "white"
    property color secondaryForeground: "gray"
    property color foreground: "white"
    property string contentFontFamily: "sans-serif"
    property string fontFamily: "sans-serif"
    property int arrangeCloses: 0
    property int listReturns: 0
    function closeArrange() {{ arrangeCloses += 1 }}
    function returnFocusToList() {{ listReturns += 1 }}
{plumbing(source)}
    Item {{
        id: filterControls
        anchors.fill: parent
        property real filterRowHeight: 30
        property real controlHeight: 26
{loader_block(source)}
        Item {{
            id: {button}
            anchors.right: parent.right
            width: 20
            height: 20
            visible: root.searchText !== ""
        }}
    }}
}}
'''

    def text_inputs(self, owner):
        return [item for item in owner.findChildren(QObject) if item.inherits("QQuickTextInput")]

    def test_field_exists_only_while_open_and_keeps_the_term(self):
        for surface in SURFACES:
            with self.subTest(surface=surface), tempfile.TemporaryDirectory(prefix="search-field-") as directory:
                source, fixture, qml = self.fixture(directory, surface)
                engine = QQmlEngine()
                engine.addImportPath(str(fixture))
                warnings = []
                engine.warnings.connect(lambda errors: warnings.extend(e.toString() for e in errors))
                component = QQmlComponent(engine)
                component.setData(qml.encode(), QUrl.fromLocalFile(str(fixture / "Fixture.qml")))
                self.assertEqual(component.status(), QQmlComponent.Ready,
                                 "\n".join(e.toString() for e in component.errors()))
                owner = component.create()
                self.assertIsNotNone(owner, "\n".join(e.toString() for e in component.errors()))
                window = QQuickWindow()
                window.resize(600, 200)
                owner.setParentItem(window.contentItem())
                window.show()
                try:
                    def settle(ms=30):
                        QTest.qWait(ms)

                    def type_text(text):
                        # QTest.keyClicks takes only widgets; a QQuickWindow gets one key per character.
                        for ch in text:
                            key = Qt.Key_Space if ch == " " else getattr(Qt, f"Key_{ch.upper()}")  # lowercase text only
                            QTest.keyClick(window, key)

                    def field():
                        inputs = self.text_inputs(owner)
                        self.assertLessEqual(len(inputs), 1)
                        return inputs[0] if inputs else None

                    settle()
                    # Closed: no text input exists, so nothing subscribes to the clipboard.
                    self.assertIsNone(field())
                    self.assertFalse(owner.property("searchFieldFocused"))
                    QMetaObject.invokeMethod(owner, "focusSearchField")
                    self.assertIsNone(field())

                    # A term set while closed (a restored placement origin) is shown on open.
                    owner.setProperty("searchText", "ab")
                    owner.setProperty("opened", True)
                    settle()
                    self.assertIsNotNone(field())
                    self.assertEqual(field().property("text"), "ab")

                    # Typing updates the root term at once and the query after the debounce.
                    QMetaObject.invokeMethod(owner, "focusSearchField")
                    settle()
                    self.assertTrue(owner.property("searchFieldFocused"))
                    for key in (Qt.Key_C, Qt.Key_D):
                        QTest.keyClick(window, key)
                    settle(10)
                    # The popup selects the term on focus, so typing replaces it; the
                    # window's field keeps it and appends.
                    self.assertEqual(owner.property("searchText"), "cd" if surface == "Panel.qml" else "abcd")
                    typed = owner.property("searchText")
                    settle(250)
                    self.assertEqual(owner.property("searchQuery"), typed)
                    if surface == "Panel.qml":
                        # Typing over the popup closes its arrange pane, as before.
                        self.assertGreater(owner.property("arrangeCloses"), 0)

                    # Closing destroys the field and keeps the term; reopening shows it again.
                    owner.setProperty("opened", False)
                    settle()
                    self.assertIsNone(field())
                    self.assertFalse(owner.property("searchFieldFocused"))
                    self.assertEqual(owner.property("searchText"), typed)
                    self.assertEqual(owner.property("searchQuery"), typed)
                    owner.setProperty("opened", True)
                    settle()
                    self.assertEqual(field().property("text"), typed)

                    # Escape clears first, then hands the keyboard back to the list.
                    QMetaObject.invokeMethod(owner, "focusSearchField")
                    settle()
                    QTest.keyClick(window, Qt.Key_Escape)
                    settle()
                    self.assertEqual(owner.property("searchText"), "")
                    self.assertEqual(owner.property("searchQuery"), "")
                    self.assertEqual(field().property("text"), "")
                    returns = owner.property("listReturns")
                    QTest.keyClick(window, Qt.Key_Escape)
                    settle()
                    self.assertEqual(owner.property("listReturns"), returns + 1)

                    # The box is read-only to Qt, so no clipboard offer is ever read:
                    # canPaste stays false and no paste route inserts anything.
                    clipboard = QGuiApplication.clipboard()
                    clipboard.setText("pasted")
                    settle()
                    self.assertTrue(field().property("readOnly"))
                    self.assertFalse(field().property("canPaste"))
                    QMetaObject.invokeMethod(owner, "focusSearchField")
                    settle()
                    for key, modifier in ((Qt.Key_V, Qt.ControlModifier), (Qt.Key_Insert, Qt.ShiftModifier),
                                          (Qt.Key_Paste, Qt.NoModifier)):
                        QTest.keyClick(window, key, modifier)
                    QMetaObject.invokeMethod(field(), "paste")
                    settle()
                    self.assertEqual(field().property("text"), "")
                    self.assertEqual(owner.property("searchText"), "")
                    self.assertFalse(field().property("canPaste"))

                    # The box applies its own edits: typing, Backspace, Delete and
                    # word deletion, at the cursor Qt keeps.
                    arrangeCloses = owner.property("arrangeCloses")
                    type_text("foo bar")
                    self.assertEqual(owner.property("searchText"), "foo bar")
                    QTest.keyClick(window, Qt.Key_Backspace)
                    QTest.keyClick(window, Qt.Key_Home)
                    QTest.keyClick(window, Qt.Key_Delete)
                    self.assertEqual(owner.property("searchText"), "oo ba")
                    self.assertEqual(field().property("cursorPosition"), 0)
                    QTest.keyClick(window, Qt.Key_End)
                    QTest.keyClick(window, Qt.Key_Backspace, Qt.ControlModifier)
                    self.assertEqual(owner.property("searchText"), "oo ")
                    QTest.keyClick(window, Qt.Key_Left)
                    type_text("x")
                    self.assertEqual(owner.property("searchText"), "oox ")
                    if surface == "Panel.qml":
                        self.assertGreater(owner.property("arrangeCloses"), arrangeCloses)

                    # Typing replaces a selection, and select-all then typing starts over.
                    QTest.keyClick(window, Qt.Key_A, Qt.ControlModifier)
                    type_text("z")
                    self.assertEqual(owner.property("searchText"), "z")
                    # Cut copies the selection out, which writes the clipboard but never reads it.
                    QTest.keyClick(window, Qt.Key_A, Qt.ControlModifier)
                    QTest.keyClick(window, Qt.Key_X, Qt.ControlModifier)
                    self.assertEqual(owner.property("searchText"), "")
                    self.assertEqual(clipboard.text(), "z")

                    # The cap holds for typed text.
                    type_text("y" * 300)
                    self.assertEqual(len(owner.property("searchText")), 256)

                    # Enter still accepts the term and hands the keyboard back.
                    returns = owner.property("listReturns")
                    QTest.keyClick(window, Qt.Key_Return)
                    settle()
                    self.assertEqual(owner.property("searchQuery"), "y" * 256)
                    self.assertEqual(owner.property("listReturns"), returns + 1)
                    QMetaObject.invokeMethod(owner, "clearSearch")

                    # A click focuses the read-only box, which then shows a cursor.
                    owner.forceActiveFocus()
                    settle()
                    self.assertFalse(owner.property("searchFieldFocused"))
                    centre = field().mapToScene(field().boundingRect().center()).toPoint()
                    QTest.mouseClick(window, Qt.LeftButton, Qt.NoModifier, centre)
                    settle()
                    self.assertTrue(owner.property("searchFieldFocused"))
                    self.assertTrue(field().property("cursorVisible"))

                    # Clearing while closed applies at once and the next open shows it empty.
                    owner.setProperty("searchText", "zz")
                    settle(250)
                    owner.setProperty("opened", False)
                    settle()
                    QMetaObject.invokeMethod(owner, "clearSearch")
                    self.assertEqual(owner.property("searchQuery"), "")
                    owner.setProperty("opened", True)
                    settle()
                    self.assertEqual(field().property("text"), "")
                    self.assertEqual(warnings, [])
                finally:
                    window.hide()
                    owner.deleteLater()
                    self.app.sendPostedEvents(None, 0)


if __name__ == "__main__":
    unittest.main()
