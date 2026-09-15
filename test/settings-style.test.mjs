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

const switches = [
  ["unverifiedSwitch", "unverifiedText"],
  ["unverifiedInstallSwitch", "unverifiedInstallText"],
  ["tiledPanelSwitch", "tiledPanelText"]
]

for (const file of ["Panel.qml", "Expanded.qml"]) {
  const source = readFileSync(new URL(`../${file}`, import.meta.url), "utf8")
  const all = objects(source)

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
