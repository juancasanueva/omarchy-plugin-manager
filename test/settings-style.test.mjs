import { readFileSync } from "node:fs"
import { runInNewContext } from "node:vm"
import { test } from "node:test"
import assert from "node:assert/strict"

// Inspect QML object ownership, not indentation. Mask strings/comments so their
// braces cannot masquerade as objects; retain offsets into the original source.
function objects(source) {
  const masked = source.replace(/"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|\/\/[^\n]*|\/\*[\s\S]*?\*\//g,
    text => text.replace(/[^\n]/g, " "))
  const stack = []
  const result = []
  for (let i = 0; i < masked.length; i++) {
    if (masked[i] === "{") {
      const type = masked.slice(0, i).match(/\b(\w+)\s*$/)?.[1]
      stack.push({ type, start: i + 1, parent: stack.at(-1) })
    } else if (masked[i] === "}") {
      const object = stack.pop()
      object.body = source.slice(object.start, i)
      result.push(object)
    }
  }
  return result
}

function byId(all, id) {
  const match = all.find(object => new RegExp(`^\\s*id:\\s*${id}\\s*$`, "m").test(object.body)
    && !all.some(child => child.parent === object
      && new RegExp(`^\\s*id:\\s*${id}\\s*$`, "m").test(child.body)))
  assert.ok(match, `QML object ${id} exists`)
  return match
}

test("SettingsInfo shares safe, content-sized Info and About cards", () => {
  const source = readFileSync(new URL("../SettingsInfo.qml", import.meta.url), "utf8")
  const all = objects(source)
  for (const heading of ["Info", "About"])
    assert.match(source, new RegExp(`text: "${heading}"`))
  for (const id of ["infoCard", "aboutCard"]) {
    const card = byId(all, id)
    assert.match(card.body, /color: Style\.normalFill/)
    assert.match(card.body, /radius: Style\.cornerRadius/)
    assert.match(card.body, /border\.width: 1/)
    assert.match(card.body, /border\.color: Qt\.alpha\(root\.secondaryForeground, 0\.35\)/)
    assert.match(card.body, /height: \w+\.implicitHeight \+ Style\.space\(12\) \* 2/)
  }
  for (const text of all.filter(object => object.type === "Text")) {
    assert.match(text.body, /textFormat: Text\.PlainText/)
    assert.match(text.body, /wrapMode: Text\.WrapAnywhere/)
  }
  assert.match(source, /"Plugins installed in " \+ /)
  assert.match(source, /"Plugin Manager Updates are in " \+ /)
  assert.match(source, /text: root\.updateDataCount/)
  assert.match(source, /objectName: "deleteUpdateDataButton"/)
  assert.match(source, /bordered: true/)
  assert.match(source, /enabled: root\.cleanupEnabled/)
  assert.match(source, /onClicked: root\.cleanupRequested\(\)/)
  assert.match(source, /text: root\.cleanupOutcome/)
  assert.match(source, /text: "Plugin Manager"/)
  assert.match(source, /text: "Juan Casanueva"/)
  assert.doesNotMatch(source, /Process\s*\{|FileView|XMLHttpRequest|execDetached|openUrlExternally|1\.10\.0/)
})

const switches = [
  ["unverifiedSwitch", "unverifiedText"],
  ["unverifiedInstallSwitch", "unverifiedInstallText"],
  ["tiledPanelSwitch", "tiledPanelText"]
]

for (const file of ["Panel.qml", "Expanded.qml"]) {
  const source = readFileSync(new URL(`../${file}`, import.meta.url), "utf8")
  const all = objects(source)

  test(`${file}: shared metadata follows Restart Shell in the scroll content`, () => {
    const info = all.find(object => object.type === "SettingsInfo")
    assert.ok(info, "shared SettingsInfo exists")
    assert.equal(info.parent, byId(all, "settingsContent"))
    assert.ok(info.start > byId(all, "restartShellButton").start)
    assert.match(info.body, /width: parent\.width/)
    assert.match(info.body, /pluginsBasePath: store\.updateDataPaths \? store\.updateDataPaths\.plugins : ""/)
    assert.match(info.body, /updateDataPath: store\.updateDataPaths \? store\.updateDataPaths\.active : ""/)
    assert.match(info.body, /Model\.findRow\(store\.rows, store\.selfId\)/)
    assert.match(info.body, /selfRow \? selfRow\.localVersion : ""/)
    assert.doesNotMatch(info.body, /XDG|manifest/)
  })

  test(`${file}: every setting has a filled, bordered, padded card`, () => {
    for (const id of [...switches.map(([id]) => id), "restartShellButton"]) {
      const control = byId(all, id)
      const card = control.parent
      assert.equal(card.type, "Rectangle", `${id} has a row background`)
      assert.match(card.body, /color:\s*Style\.normalFill\b/)
      assert.match(card.body, /radius:\s*Style\.cornerRadius\b/)
      assert.match(card.body, /border\.width:\s*1\b/)
      assert.match(card.body, /border\.color:\s*Qt\.alpha\(root\.secondaryForeground,\s*0\.35\)/)
      assert.match(control.body, /anchors\.right:\s*parent\.right\b/)
      assert.match(control.body, /anchors\.rightMargin:\s*Style\.space\(12\)/)
      const height = card.body.match(/^\s*height:\s*(.+)$/m)?.[1]
      assert.ok(height, `${id} has content-driven height`)
      const context = { Style: { space: n => n } }
      for (const [switchId, textId] of switches) {
        context[switchId] = { implicitHeight: 24 }
        context[textId] = { implicitHeight: 80 }
      }
      context.restartShellButton = { implicitHeight: 30 }
      assert.equal(runInNewContext(height, context), id === "restartShellButton" ? 54 : 104)
    }
  })

  test(`${file}: wrapped descriptions can grow without clipping controls`, () => {
    for (const [id, textId] of switches) {
      const control = byId(all, id)
      const label = byId(all, textId)
      assert.equal(label.parent, control.parent, "label and toggle share the card")
      assert.match(label.body, /anchors\.leftMargin:\s*Style\.space\(12\)/)
      assert.match(label.body, new RegExp(`anchors\\.right:\\s*${id}\\.left\\b`))
      assert.equal((label.body.match(/wrapMode:\s*Text\.WordWrap/g) || []).length, 2)
      const height = control.parent.body.match(/^\s*height:\s*(.+)$/m)?.[1]
      for (const textHeight of [18, 240]) {
        assert.equal(runInNewContext(height, {
          Style: { space: n => n * 1.5 },
          [id]: { implicitHeight: 36 }, [textId]: { implicitHeight: textHeight }
        }), Math.max(36, textHeight) + 36)
      }
    }
    const scroll = byId(all, "settingsScroll")
    assert.equal(scroll.type, "Flickable")
    assert.match(scroll.body, /anchors\.bottom:\s*parent\.bottom/)
    assert.match(scroll.body, /clip:\s*true/)
    assert.match(scroll.body, /contentHeight:\s*settingsContent\.implicitHeight/)
    assert.match(scroll.body, /interactive:\s*contentHeight\s*>\s*height/)
    const content = byId(all, "settingsContent")
    assert.match(content.body, /parent:\s*settingsScroll\.contentItem/)
    assert.match(content.body, /width:\s*settingsScroll\.width/)
  })
}
