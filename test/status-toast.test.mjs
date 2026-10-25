import { readFileSync } from "node:fs"
import { test } from "node:test"
import assert from "node:assert/strict"

const read = name => readFileSync(new URL(`../${name}`, import.meta.url), "utf8")
const Model = new Function(read("Model.js") + `
  return { isStatusNotice, noticeDuration }`)()

test("an outcome posted with no action running is a notice", () => {
  // Watch, star, enable, disable, settings, and every finished action.
  assert.equal(Model.isStatusNotice("Watching Weather", "", ""), true)
  assert.equal(Model.isStatusNotice("Could not save the watch list", "", ""), true)
  assert.equal(Model.isStatusNotice("Cleanup complete.", "update-data", ""), true)
})

test("progress, bar moves and an empty status stay in the status line", () => {
  // Progress is set while the action that owns it is still running.
  assert.equal(Model.isStatusNotice("Installing the verified snapshot of Weather", "", "install"), false)
  assert.equal(Model.isStatusNotice("Updating 3 plugins", "", "bulk-update"), false)
  // A bar move waits on the host and carries a Review layout button.
  assert.equal(Model.isStatusNotice("Moving bar entry; waiting for the host layout", "layout", ""), false)
  assert.equal(Model.isStatusNotice("Move refused: layout changed", "layout", ""), false)
  assert.equal(Model.isStatusNotice("", "", ""), false)
  assert.equal(Model.isStatusNotice(undefined, undefined, undefined), false)
})

test("errors stay on screen longer than successes", () => {
  assert.equal(Model.noticeDuration(false), 4000)
  assert.equal(Model.noticeDuration(true), 7000)
})

test("the store classifies every status and announces notices", () => {
  const store = read("PluginStore.qml")
  assert.match(store, /property bool statusIsNotice: false/)
  assert.match(store, /signal noticePosted\(string text, bool isError\)/)
  const setStatus = store.slice(store.indexOf("function setStatus("), store.indexOf("function setStatus(") + 400)
  assert.match(setStatus, /statusIsNotice = Model\.isStatusNotice\(text, statusSource, busyKind\)/)
  assert.match(setStatus, /if \(statusIsNotice\) noticePosted\(text, statusIsError\)/)
})

test("both surfaces show notices in a toast, not the status line", () => {
  for (const name of ["Panel.qml", "Expanded.qml"]) {
    const surface = read(name)
    assert.match(surface, /StatusToast \{\s+id: statusToast/, name)
    assert.match(surface, /function onNoticePosted\(text, isError\) \{\s+if \(root\.opened\) statusToast\.show\(text, isError\)/, name)
    assert.match(surface, /StatusToast \{[^}]*active: root\.opened/, name)
    const line = surface.slice(surface.indexOf("// ---- Status:"), surface.indexOf("// ---- Key hints"))
    // Every branch that shows the raw status skips notices, except the bulk
    // update's progress, which is only ever posted while it runs.
    const shown = line.split("\n").filter(l => /root\.status\b(?!Source|IsError|IsNotice)/.test(l))
    for (const l of shown)
      assert.ok(/statusIsNotice|bulk-update/.test(l), `${name}: unguarded status in ${l.trim()}`)
    assert.ok(shown.length >= 2, name)
  }
})
