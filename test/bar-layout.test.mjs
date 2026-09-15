import { readFileSync } from "node:fs"
import { spawnSync } from "node:child_process"
import { test } from "node:test"
import assert from "node:assert/strict"

const source = readFileSync(new URL("../Model.js", import.meta.url), "utf8")
const model = () => Function(source + "; return { barLayoutSnapshot, barLayoutMove }")()
const sectionModel = () => Function(source + "; return { barSectionMovePlan, barLayoutMove }")()
const enabledRow = (id = "same", barSection = "left") => ({ id, barSection,
  enabled: true, kinds: ["bar-widget"] })
const layout = () => ({ left: ["clock", { id: "same", settings: { color: "red" } },
  { id: "same", settings: { color: "blue" } }], center: [], right: ["tray"] })

test("snapshots preserve duplicate instances, raw indexes and immutable settings", () => {
  const { barLayoutSnapshot } = model()
  const raw = layout()
  const snapshot = barLayoutSnapshot(raw)
  assert.deepEqual(snapshot.rows.map(row => [row.id, row.section, row.index]),
    [["clock", "left", 0], ["same", "left", 1], ["same", "left", 2], ["tray", "right", 0]])
  assert.equal(snapshot.rows[1].entry, snapshot.layout.left[1])
  raw.left[1].settings.color = "green"
  assert.equal(snapshot.layout.left[1].settings.color, "red")
  assert.throws(() => { snapshot.layout.left[1].settings.color = "green" }, TypeError)
  assert.throws(() => { snapshot.rows[1].index = 99 }, TypeError)
  assert.equal(barLayoutSnapshot({ ...layout(), left: [{ settings: { color: "red" }, id: "same" }] }).key,
    barLayoutSnapshot({ ...layout(), left: [{ id: "same", settings: { color: "red" } }] }).key)
})

test("drop gaps become post-removal indexes without changing the original entries", () => {
  const { barLayoutSnapshot, barLayoutMove } = model()
  const raw = layout(), snapshot = barLayoutSnapshot(raw)
  const move = (from, section, gap) => barLayoutMove(snapshot, raw, "left", from, section, gap)
  const down = move(1, "left", 3)
  assert.deepEqual(down.command, ["omarchy-bar", "move", "same", "--from-section", "left",
    "--from-index", "1", "--section", "left", "--index", "2"])
  assert.equal(down.expected.layout.left[2].settings.color, "red")
  assert.equal(down.expected.layout.left[1].settings.color, "blue")
  assert.equal(move(2, "left", 0).expected.layout.left[0].settings.color, "blue")
  for (const gap of [1, 2]) assert.equal(move(1, "left", gap).noOp, true)
  assert.deepEqual(move(1, "left", 2).command, [])
  assert.equal(move(2, "right", 1).expected.layout.right[1].settings.color, "blue")
  assert.equal(move(0, "center", 0).expected.layout.center[0], "clock")
  assert.deepEqual(raw, layout())
})

test("malformed or oversized layouts and non-positional inputs fail closed", () => {
  const { barLayoutSnapshot, barLayoutMove } = model()
  const cycle = {}; cycle.self = cycle
  const invalid = [null, [], {}, { ...layout(), extra: [] }, { ...layout(), left: [null] },
    { ...layout(), left: new Array(2) }, { ...layout(), left: [""] },
    { ...layout(), left: ["bad/id"] }, { ...layout(), left: [{ id: "ok", settings: cycle }] },
    { ...layout(), left: [{ id: "ok", value: undefined }] },
    { ...layout(), left: [{ id: "ok", value: Infinity }] },
    { ...layout(), left: Array(129).fill("clock") },
    { ...layout(), left: [{ id: "ok", value: "x".repeat(65537) }] }]
  for (const raw of invalid) assert.equal(barLayoutSnapshot(raw), null)
  const raw = layout(), snapshot = barLayoutSnapshot(raw)
  for (const index of [-1, 0.5, "1", NaN, Infinity, 3])
    assert.equal(barLayoutMove(snapshot, raw, "left", index, "right", 0), null)
  for (const gap of [-1, 0.5, "0", NaN, Infinity, 2])
    assert.equal(barLayoutMove(snapshot, raw, "left", 1, "right", gap), null)
  assert.equal(barLayoutMove(snapshot, raw, "bad", 1, "right", 0), null)
  assert.equal(barLayoutMove(snapshot, raw, "left", 1, "bad", 0), null)
})

test("host-valid IDs retain their exact positional argv, without an ASCII or length filter", () => {
  const { barLayoutSnapshot, barLayoutMove } = model()
  for (const id of ["x".repeat(1024), "reloj.日本語.🕘", "界".repeat(43690), "--help", "-h", "-q", "--", ".",
    "space 'quote' ; $(printf injected)\nnext"]) {
    const raw = { left: [{ id, settings: { retained: true } }], center: [], right: [] }
    const snapshot = barLayoutSnapshot(raw)
    assert.ok(snapshot, id)
    assert.equal(snapshot.rows[0].id, id)
    const moved = barLayoutMove(snapshot, raw, "left", 0, "right", 0)
    // The generic omarchy dispatcher consumes --help/-h even in the ID slot.
    assert.deepEqual(moved.command, ["omarchy-bar", "move", id, "--from-section", "left",
      "--from-index", "0", "--section", "right", "--index", "0"])
    assert.equal(moved.expected.layout.right[0].settings.retained, true)
    // Harmless argv round-trip only: never invoke omarchy or a shell.
    const echoed = spawnSync(process.execPath, ["-e", "process.stdout.write(JSON.stringify(process.argv.slice(1)))", "--", id],
      { encoding: "utf8", timeout: 1000, maxBuffer: 262144, env: {} })
    assert.equal(echoed.status, 0)
    assert.deepEqual(JSON.parse(echoed.stdout), [id])
  }
  for (const id of ["", "/clock", "clock/name", "..", "clock..name"])
    assert.equal(barLayoutSnapshot({ left: [id], center: [], right: [] }), null)
  assert.equal(barLayoutSnapshot({ left: ["x".repeat(65536)], center: [], right: [] }), null)
  assert.equal(barLayoutSnapshot({ left: ["x".repeat(33000), "y".repeat(33000)], center: [], right: [] }), null)
})

test("argv transport limitations refuse only the move, not the whole snapshot", () => {
  const { barLayoutSnapshot, barLayoutMove } = model()
  const oversized = spawnSync(process.execPath, ["-e", "", "界".repeat(44000)],
    { timeout: 1000, maxBuffer: 4096, env: {} })
  assert.equal(oversized.error?.code, "E2BIG", "Linux rejects this single UTF-8 argument")
  for (const id of ["contains\u0000nul", "unpaired\ud800", "界".repeat(44000)]) {
    const raw = { left: [id], center: [], right: [] }
    const snapshot = barLayoutSnapshot(raw)
    assert.ok(snapshot)
    assert.equal(snapshot.rows[0].id, id)
    assert.equal(barLayoutMove(snapshot, raw, "left", 0, "right", 0), null)
  }
})

test("capacity, depth, representation and cross-section duplicate identity are preserved", () => {
  const { barLayoutSnapshot, barLayoutMove } = model()
  const full = { ...layout(), right: Array(128).fill("same") }
  assert.equal(barLayoutMove(barLayoutSnapshot(full), full, "left", 1, "right", 128), null)
  const raw = { left: ["same", { id: "same", settings: { list: [1, false, null] } }],
    center: [{ id: "same", settings: { other: true } }], right: [] }
  const snapshot = barLayoutSnapshot(raw)
  const moved = barLayoutMove(snapshot, raw, "left", 1, "center", 1)
  assert.equal(moved.expected.layout.left[0], "same")
  assert.equal(moved.expected.layout.center[0].settings.other, true)
  assert.deepEqual(moved.expected.layout.center[1].settings.list, [1, false, null])
  assert.equal(barLayoutMove(null, raw, "left", 1, "right", 0), null)
  let deep = "value"
  for (let i = 0; i < 14; i++) deep = { nested: deep }
  assert.equal(barLayoutSnapshot({ ...layout(), left: [{ id: "clock", settings: deep }] }), null)
})

test("a changed source, destination or duplicate setting cancels the drag", () => {
  const { barLayoutSnapshot, barLayoutMove } = model()
  const snapshot = barLayoutSnapshot(layout())
  for (const change of [raw => raw.left.reverse(), raw => raw.right.push("clock"),
    raw => { raw.left[1].settings.color = "green" }]) {
    const latest = layout(); change(latest)
    assert.equal(barLayoutMove(snapshot, latest, "left", 1, "right", 0), null)
  }
})

test("section choices plan exact retained-move arguments after each first destination anchor", () => {
  const { barSectionMovePlan, barLayoutMove } = sectionModel()
  const anchors = { left: "omarchy.workspaces", center: "omarchy.weather", right: "omarchy.tray" }
  for (const section of Object.keys(anchors)) {
    const fromSection = section === "left" ? "center" : "left"
    const raw = { left: [], center: [], right: [] }
    raw[fromSection] = ["other", { id: "same", settings: { nested: [false, 2] }, extra: "keep" }, "same"]
    raw[section] = ["before", { id: anchors[section], settings: { first: true } }, anchors[section],
      section === "left" ? "tail" : "same"]
    const original = JSON.stringify(raw)
    const plan = barSectionMovePlan(enabledRow("same", fromSection), raw, section)
    assert.deepEqual(Object.keys(plan), ["snapshot", "fromSection", "fromIndex", "section", "gap"])
    assert.deepEqual([plan.fromSection, plan.fromIndex, plan.section, plan.gap], [fromSection, 1, section, 2])
    assert.equal(plan.snapshot.key, model().barLayoutSnapshot(raw).key)
    assert.ok(Object.isFrozen(plan))
    const move = barLayoutMove(plan.snapshot, raw, plan.fromSection, plan.fromIndex, plan.section, plan.gap)
    assert.deepEqual(move.command, ["omarchy-bar", "move", "same", "--from-section", fromSection,
      "--from-index", "1", "--section", section, "--index", "2"])
    const expected = JSON.parse(original)
    expected[section].splice(2, 0, expected[fromSection].splice(1, 1)[0])
    assert.equal(move.expected.key, model().barLayoutSnapshot(expected).key)
    assert.equal(JSON.stringify(raw), original)
    raw[fromSection][1].settings.nested[0] = true
    assert.equal(plan.snapshot.layout[fromSection][1].settings.nested[0], false)
    assert.equal(barLayoutMove(plan.snapshot, raw, fromSection, 1, section, 2), null)
  }
})

test("section choices append without anchors, including empty destinations and first-match order", () => {
  const { barSectionMovePlan, barLayoutMove } = sectionModel()
  for (const fromSection of ["left", "center", "right"]) {
    const section = fromSection === "left" ? "right" : "left"
    for (const destination of [[], ["clock", "tray"]]) {
      const raw = { left: [], center: [], right: [] }
      raw[fromSection] = ["same", { id: "same", settings: { duplicate: true } }]
      raw[section] = destination
      const plan = barSectionMovePlan(enabledRow("same", fromSection), raw, section)
      assert.deepEqual([plan.fromSection, plan.fromIndex, plan.section, plan.gap],
        [fromSection, 0, section, destination.length])
      const move = barLayoutMove(plan.snapshot, raw, fromSection, 0, section, plan.gap)
      assert.equal(move.expected.layout[section][destination.length], "same")
      assert.equal(move.expected.layout[fromSection][0].settings.duplicate, true)
    }
  }
})

test("section choices refuse no-op, stale, missing, invalid and ineligible rows", () => {
  const { barSectionMovePlan } = sectionModel()
  const raw = { left: ["same"], center: ["same"], right: ["same"] }
  assert.equal(barSectionMovePlan(enabledRow(), raw, "left"), null)
  for (const row of [null, enabledRow("missing"), enabledRow("same", "center"), enabledRow("same", "right"),
    enabledRow("same", ""), enabledRow(""), { ...enabledRow(), enabled: false },
    { ...enabledRow(), enabled: 1 }, { ...enabledRow(), kinds: ["service"] },
    { ...enabledRow(), kinds: ["bar", "bar-widget"] }])
    assert.equal(barSectionMovePlan(row, raw, "right"), null)
  for (const section of [null, "", "top", "RIGHT", 0])
    assert.equal(barSectionMovePlan(enabledRow(), raw, section), null)
  for (const invalid of [null, {}, { ...raw, center: [null] }, { ...raw, extra: [] },
    { ...raw, left: Array(129).fill("same") }, { ...raw, right: Array(128).fill("tray") }])
    assert.equal(barSectionMovePlan(enabledRow(), invalid, "right"), null)
})

test("section plans retain direct routing and reject unsafe argv through existing move validation", () => {
  const { barSectionMovePlan, barLayoutMove } = sectionModel()
  for (const id of ["--help", "-h", "contains\u0000nul", "unpaired\ud800", "界".repeat(44000)]) {
    const raw = { left: [id], center: [], right: [] }
    const plan = barSectionMovePlan(enabledRow(id), raw, "right")
    if (id === "--help" || id === "-h") {
      assert.deepEqual(barLayoutMove(plan.snapshot, raw, plan.fromSection, plan.fromIndex, plan.section, plan.gap).command,
        ["omarchy-bar", "move", id, "--from-section", "left", "--from-index", "0", "--section", "right", "--index", "0"])
    } else assert.equal(plan, null)
  }
})

// Execute the shipped QML method bodies with fake host/process objects. No CLI
// dispatch or shell.json read occurs; QML signal scheduling remains a runtime check.
function storeHarness() {
  const qml = readFileSync(new URL("../PluginStore.qml", import.meta.url), "utf8")
  const root = { shell: { barConfig: { layout: layout() } }, busy: false,
    barMovePending: null, barMoveExited: true, barMoveFailed: false, barMoveBytes: 0,
    setStatus(text, error, source) { this.status = text; this.statusIsError = error; this.statusSource = source } }
  const proc = { running: false, signals: [], signal(value) { this.signals.push(value) } }
  const names = ["startBarMove", "readBarMoveOutput", "finishBarMove", "reconcileBarMove"]
  for (const name of names) {
    const method = qml.match(new RegExp("  function " + name + "\\([^]*?\\n  }"))
    assert.ok(method, name + " exists")
    root[name] = Function("root", "barMoveProc", "Model", "return (" + method[0].trim() + ")")(
      root, proc, model())
  }
  return { root, proc, snapshot: model().barLayoutSnapshot(layout()) }
}

test("store dispatches once, rejects stale/no-op drops and waits for host reconciliation", () => {
  const { root, proc, snapshot } = storeHarness()
  assert.equal(root.startBarMove(snapshot, "left", 1, "left", 2), false)
  root.shell.barConfig.layout.left[1].settings.color = "green"
  assert.equal(root.startBarMove(snapshot, "left", 1, "right", 1), false)
  root.shell.barConfig.layout = layout()
  assert.equal(root.startBarMove(snapshot, "left", 1, "right", 1), true)
  assert.equal(root.statusSource, "layout")
  assert.deepEqual(proc.command.slice(0, 4), ["/usr/bin/timeout", "-k", "1", "8"])
  assert.deepEqual(proc.command.slice(4), root.barMovePending.command)
  assert.equal(root.startBarMove(snapshot, "left", 2, "center", 0), false)
  assert.equal(root.reconcileBarMove(true), false, "cannot acknowledge while client runs")
  proc.running = false; root.finishBarMove(0)
  assert.ok(root.barMovePending, "exit alone does not confirm host layout")
  root.shell.barConfig.layout = root.barMovePending.expected.layout
  assert.equal(root.reconcileBarMove(false), true)
  assert.equal(root.barMovePending, null)
  assert.equal(root.status, "Bar layout updated")
  assert.equal(root.statusSource, "layout")
})

test("untransportable IDs explain refusal without invalidating the visible snapshot", () => {
  for (const id of ["contains\u0000nul", "unpaired\ud800", "界".repeat(44000)]) {
    const { root, proc } = storeHarness()
    root.shell.barConfig.layout = { left: [id], center: [], right: [] }
    const snapshot = model().barLayoutSnapshot(root.shell.barConfig.layout)
    assert.ok(snapshot)
    assert.equal(root.startBarMove(snapshot, "left", 0, "right", 0), false)
    assert.match(root.status, /ID cannot be transported by omarchy-bar/)
    assert.equal(root.statusSource, "layout")
    assert.doesNotMatch(root.status, /Layout changed/)
    assert.equal(proc.running, false)
    assert.equal(root.barMovePending, null)
    assert.equal(snapshot.rows[0].id, id)
  }
})

test("host change before exit reconciles, while missing host and other actions prevent dispatch", () => {
  const { root, proc, snapshot } = storeHarness()
  root.busy = true
  assert.equal(root.startBarMove(snapshot, "left", 1, "right", 0), false)
  root.busy = false
  const shell = root.shell; root.shell = null
  assert.equal(root.startBarMove(snapshot, "left", 1, "right", 0), false)
  root.shell = shell
  root.startBarMove(snapshot, "left", 1, "right", 0)
  root.shell.barConfig.layout = root.barMovePending.expected.layout
  assert.equal(root.reconcileBarMove(false), false)
  proc.running = false; root.finishBarMove(0)
  assert.equal(root.barMovePending, null)
  const fresh = model().barLayoutSnapshot(root.shell.barConfig.layout)
  assert.equal(root.startBarMove(fresh, "right", 0, "center", 0), true)
})

test("failure and output overflow remain ambiguous until explicitly reconciled", () => {
  for (const code of [1, 124, 137]) {
    const { root, proc, snapshot } = storeHarness()
    root.startBarMove(snapshot, "left", 1, "right", 0)
    proc.running = false; root.finishBarMove(code)
    assert.equal(root.reconcileBarMove(false), false)
    assert.match(root.status, /unknown/i)
    assert.equal(root.statusSource, "layout")
    root.shell.barConfig.layout = null
    assert.equal(root.reconcileBarMove(true), false)
    root.shell.barConfig.layout = layout()
    assert.equal(root.reconcileBarMove(true), true)
    assert.equal(root.status, "Current layout accepted")
    assert.equal(root.statusSource, "layout")
  }
  const { root, proc, snapshot } = storeHarness()
  root.startBarMove(snapshot, "left", 1, "right", 0)
  root.readBarMoveOutput("é".repeat(2048))
  assert.deepEqual(proc.signals, [])
  root.readBarMoveOutput("x")
  assert.deepEqual(proc.signals, [15])
  root.readBarMoveOutput("x".repeat(10000))
  assert.deepEqual(proc.signals, [15], "overflow is latched without retaining output")
  proc.running = false; root.finishBarMove(0)
  assert.equal(root.barMoveFailed, true)
  assert.equal(root.reconcileBarMove(false), false)
})
