import test from "node:test"
import assert from "node:assert/strict"
import { readFileSync, readdirSync } from "node:fs"

// The search box is the plugin's only text input, and a Qt Quick text input
// subscribes to the system clipboard for its whole lifetime: on the Wayland
// path every clipboard change makes the shell read the foreign offer. The
// popup is kept loaded for the shell's lifetime, so the field may only exist
// while its surface is open. These tests pin that structure in both surfaces.

const read = name => readFileSync(new URL(`../${name}`, import.meta.url), "utf8")

// The complete `{ ... }` block opened by the first brace at or after `from`,
// skipping braces inside strings and comments.
function block(source, from) {
  const start = source.indexOf("{", from)
  const tokens = /"(?:\\.|[^"\\])*"|\/\/[^\n]*|\/\*[\s\S]*?\*\/|[{}]/g
  tokens.lastIndex = start
  let depth = 0
  for (let m; (m = tokens.exec(source));) {
    if (m[0] === "{") depth += 1
    else if (m[0] === "}" && --depth === 0) return { start: source.lastIndexOf("\n", from) + 1, end: m.index + 1 }
  }
  throw new Error("unterminated block")
}

const stripComments = source => source.replace(/\/\/[^\n]*/g, match => " ".repeat(match.length))

const searchFieldEdit = new Function(read("Model.js") + "\nreturn searchFieldEdit")()

// The search box is read-only to Qt, because an editable Qt Quick text input
// reads every clipboard offer's text to keep canPaste current. SearchField.qml
// applies the edits itself through Model.searchFieldEdit.
const field = (text, cursor, selection = [cursor, cursor], max = 256) => ({
  text, cursorPosition: cursor, selectionStart: selection[0], selectionEnd: selection[1], maximumLength: max
})

test("searchFieldEdit inserts typed text at the cursor", () => {
  assert.deepEqual(searchFieldEdit(field("abd", 2), { key: "text", text: "c" }),
    { start: 2, end: 2, insert: "c", cursor: 3 })
  assert.deepEqual(searchFieldEdit(field("", 0), { key: "text", text: "é" }),
    { start: 0, end: 0, insert: "é", cursor: 1 })
})

test("searchFieldEdit replaces the selection with typed text", () => {
  assert.deepEqual(searchFieldEdit(field("hello", 5, [1, 4]), { key: "text", text: "X" }),
    { start: 1, end: 4, insert: "X", cursor: 2 })
})

test("searchFieldEdit ignores text that is not printable", () => {
  for (const text of ["", "\n", "\r", "\t", "\u001b", "\u007f", "\b"]) {
    assert.equal(searchFieldEdit(field("ab", 2), { key: "text", text }), null, JSON.stringify(text))
  }
  // Control characters are dropped from a mixed event, printable ones kept.
  assert.deepEqual(searchFieldEdit(field("", 0), { key: "text", text: "a\nb" }),
    { start: 0, end: 0, insert: "ab", cursor: 2 })
})

test("searchFieldEdit keeps the text within the maximum length", () => {
  const full = "x".repeat(256)
  // A full field takes no more text, but the key is still the field's.
  assert.deepEqual(searchFieldEdit(field(full, 256), { key: "text", text: "y" }),
    { start: 256, end: 256, insert: "", cursor: 256 })
  // Replacing a selection frees its room.
  assert.deepEqual(searchFieldEdit(field(full, 256, [0, 2]), { key: "text", text: "yz" }),
    { start: 0, end: 2, insert: "yz", cursor: 2 })
  assert.deepEqual(searchFieldEdit(field("abc", 3, [3, 3], 4), { key: "text", text: "def" }),
    { start: 3, end: 3, insert: "d", cursor: 4 })
})

test("searchFieldEdit deletes with Backspace and Delete", () => {
  assert.deepEqual(searchFieldEdit(field("abc", 2), { key: "backspace" }),
    { start: 1, end: 2, insert: "", cursor: 1 })
  assert.deepEqual(searchFieldEdit(field("abc", 1), { key: "delete" }),
    { start: 1, end: 2, insert: "", cursor: 1 })
  // At either edge the key does nothing but stays the field's.
  assert.deepEqual(searchFieldEdit(field("abc", 0), { key: "backspace" }),
    { start: 0, end: 0, insert: "", cursor: 0 })
  assert.deepEqual(searchFieldEdit(field("abc", 3), { key: "delete" }),
    { start: 3, end: 3, insert: "", cursor: 3 })
  // A selection is what either key removes.
  for (const key of ["backspace", "delete"]) {
    assert.deepEqual(searchFieldEdit(field("abcdef", 4, [1, 4]), { key }),
      { start: 1, end: 4, insert: "", cursor: 1 }, key)
  }
})

test("searchFieldEdit deletes a word with Ctrl+Backspace and Ctrl+Delete", () => {
  assert.deepEqual(searchFieldEdit(field("foo bar  ", 9), { key: "backspace", word: true }),
    { start: 4, end: 9, insert: "", cursor: 4 })
  assert.deepEqual(searchFieldEdit(field("foo bar", 5), { key: "backspace", word: true }),
    { start: 4, end: 5, insert: "", cursor: 4 })
  assert.deepEqual(searchFieldEdit(field("foo bar", 3), { key: "delete", word: true }),
    { start: 3, end: 7, insert: "", cursor: 3 })
  assert.deepEqual(searchFieldEdit(field("foo bar", 1), { key: "delete", word: true }),
    { start: 1, end: 3, insert: "", cursor: 1 })
})

test("searchFieldEdit leaves other keys to Qt", () => {
  assert.equal(searchFieldEdit(field("abc", 1), { key: "left" }), null)
  assert.equal(searchFieldEdit(field("abc", 1), {}), null)
  assert.equal(searchFieldEdit(null, { key: "backspace" }), null)
})

test("SearchField.qml: the field is read-only to Qt and edits through the model", () => {
  const source = read("SearchField.qml")
  const code = stripComments(source)
  assert.match(code, /^TextField \{\s*id: field\b/m)
  assert.match(code, /\n {2}readOnly: true\n/)
  // Nothing may make it editable again, even for a moment.
  assert.equal((code.match(/readOnly/g) || []).length, 1)
  // A read-only input neither takes focus on press nor shows its own cursor.
  assert.match(code, /onPressed: function\(event\) \{ field\.forceActiveFocus\(\) \}/)
  assert.match(code, /cursorVisible: field\.activeFocus/)
  assert.match(code, /cursorDelegate: Rectangle \{/)
  assert.match(code, /Model\.searchFieldEdit\(field, /)
  assert.match(code, /signal edited\(\)/)
  assert.match(code, /signal escaped\(\)/)
  // Paste is not implemented, so nothing reads the clipboard.
  assert.doesNotMatch(code, /clipboard|paste\(|canPaste|mimeData/i)
})

test("plugin QML: SearchField.qml holds the plugin's only text input", () => {
  const files = readdirSync(new URL("..", import.meta.url)).filter(name => name.endsWith(".qml"))
  const owners = files.filter(name => /\b(TextField|TextInput|TextEdit|TextArea)\s*\{/.test(stripComments(read(name))))
  assert.deepEqual(owners, ["SearchField.qml"])
  assert.equal((stripComments(read("SearchField.qml")).match(/\b(TextField|TextInput|TextEdit|TextArea)\s*\{/g) || []).length, 1)
})

for (const [file, button] of [["Panel.qml", "clearFiltersButton"], ["Expanded.qml", "clearSearchButton"]]) {
  const source = read(file)
  const loaderAt = source.search(/Loader \{\s*id: searchFieldLoader/)

  test(`${file}: the search field is created only while the surface is open`, () => {
    assert.notEqual(loaderAt, -1, "searchFieldLoader missing")
    const { start, end } = block(source, loaderAt)
    const loader = source.slice(start, end)
    assert.match(loader, /^\s*Loader \{\s*id: searchFieldLoader[\s\S]*?\n\s*active: root\.opened\n/)
    assert.match(loader, /sourceComponent: Component \{\s*(?:\/\/[^\n]*\s*)?SearchField \{\s*id: searchField/)
    // The only search box in the file lives inside the loader.
    const fields = [...stripComments(source).matchAll(/\bSearchField\s*\{/g)]
    assert.equal(fields.length, 1)
    assert.ok(fields[0].index > start && fields[0].index < end)
    // Edits arrive as the field's own signals, not the native text input's.
    assert.doesNotMatch(loader, /onTextEdited|Keys\./)
    assert.match(loader, /onEscaped: \{/)
  })

  test(`${file}: nothing outside the loader reaches the field by id`, () => {
    const { start, end } = block(source, loaderAt)
    const outside = stripComments(source.slice(0, start) + source.slice(end))
    assert.doesNotMatch(outside, /\bsearchField\b/)
    // Focus questions are false-safe while the field does not exist.
    assert.match(source, /readonly property bool searchFieldFocused: searchFieldLoader\.item !== null && searchFieldLoader\.item\.activeFocus/)
    assert.match(source, /function focusSearchField\(\) \{\s*var field = searchFieldLoader\.item\s*if \(!field\) return\s*field\.forceActiveFocus\(\)/)
  })

  test(`${file}: the field caps what it accepts`, () => {
    const { start, end } = block(source, loaderAt)
    // Typed or pasted input is bounded at the field, before it reaches the filter.
    assert.match(source.slice(start, end), /id: searchField[\s\S]*?\n\s*maximumLength: 256\n/)
  })

  test(`${file}: the query lives on the root and the field mirrors it`, () => {
    assert.match(source, /property string searchText: ""/)
    assert.match(source, /onSearchTextChanged: \{\s*if \(searchText === ""\) flushSearch\(\)\s*else searchDebounce\.restart\(\)\s*\}/)
    assert.match(source, /id: searchDebounce[\s\S]*?onTriggered: root\.searchQuery = root\.searchText/)
    assert.match(source, /function flushSearch\(\) \{\s*searchDebounce\.stop\(\)\s*searchQuery = searchText\s*\}/)
    const { start, end } = block(source, loaderAt)
    const loader = source.slice(start, end)
    // A field created on open starts from the term it showed before closing.
    assert.match(loader, /id: searchField\s*text: root\.searchText/)
    assert.match(loader, /onTextChanged: root\.searchText = text/)
    assert.doesNotMatch(loader, /searchDebounce/)
    assert.match(loader, /if \(root\.searchText !== ""\) root\.clearSearch\(\)/)
    assert.match(source, /function clearSearch\(\) \{[^}]*?searchText = ""\s*\}/)
    // The clear button follows the root term, not the transient field.
    const buttonAt = source.indexOf(`id: ${button}`)
    const buttonBlock = source.slice(buttonAt, block(source, buttonAt).end)
    assert.match(buttonBlock, /root\.searchText !== ""/)
  })
}

test("Panel.qml: the loader takes the field's geometry and restores and snapshots the root term", () => {
  const source = read("Panel.qml")
  const at = source.search(/Loader \{\s*id: searchFieldLoader/)
  const loader = source.slice(at, block(source, at).end)
  assert.match(loader, /id: searchFieldLoader\s*anchors\.left: parent\.left\s*anchors\.right: clearFiltersButton\.visible \? clearFiltersButton\.left : parent\.right\s*anchors\.rightMargin: clearFiltersButton\.visible \? Style\.space\(4\) : 0\s*y: filterControls\.filterRowHeight \+ Style\.space\(8\)\s*height: filterControls\.controlHeight/)
  assert.match(source, /query: searchText, group: groupFilter/)
  assert.match(source, /searchText = origin\.query\s*flushSearch\(\)/)
  assert.match(source, /searchText = cleared\.query/)
  assert.match(source, /\|\| root\.searchFieldFocused\n/)
  assert.match(source, /function focusSearchField\(\) \{[\s\S]*?field\.selectAll\(\)\s*\}/)
})

test("Expanded.qml: the loader takes the field's geometry and the keys ask the false-safe focus", () => {
  const source = read("Expanded.qml")
  const at = source.search(/Loader \{\s*id: searchFieldLoader/)
  const loader = source.slice(at, block(source, at).end)
  assert.match(loader, /id: searchFieldLoader\s*anchors\.left: parent\.left[\s\S]*?anchors\.right: clearSearchButton\.visible \? clearSearchButton\.left : parent\.right\s*anchors\.rightMargin: clearSearchButton\.visible \? Style\.space\(4\) : 0\s*anchors\.bottom: parent\.bottom\s*height: Style\.spacing\.controlHeight\s*active: root\.opened/)
  assert.match(source, /anchors\.verticalCenter: searchFieldLoader\.verticalCenter/)
  assert.equal((source.match(/!root\.searchFieldFocused/g) || []).length, 3)
  assert.match(source, /text === "\/"\) \{ root\.focusSearchField\(\); event\.accepted = true \}/)
})
