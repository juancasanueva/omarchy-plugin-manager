import { readFileSync } from "node:fs"
import { test } from "node:test"
import assert from "node:assert/strict"

const read = name => readFileSync(new URL(`../${name}`, import.meta.url), "utf8")
const expanded = read("Expanded.qml"), widgetSource = read("BarWidget.qml")
const storeSource = read("PluginStore.qml"), panelSource = read("Panel.qml")
const Model = Function(read("Model.js") + "; return { barLayoutSnapshot, barLayoutMove }")()
function call(source, name, state, ...args) {
  const match = source.match(new RegExp(`function ${name}\\(([^)]*)\\) \\{([\\s\\S]*?)\\n  \\}`))
  assert.ok(match, `${name} exists`)
  return Function("state", "args", `with (state) { return (function(${match[1]}) {${match[2]}})(...args) }`)(state, args)
}
// Evaluate the shipped one-line bindings, not a parallel lock implementation.
function binding(source, name, state, fallback = "false") {
  const expression = source.match(new RegExp(`^\\s*(?:(?:readonly )?property (?:bool|alias) )?${name}: ([^\\n]+)`, "m"))?.[1] || fallback
  return Function("state", `with (state) { return (${expression}) }`)(state)
}
function actionStore(owner = null) {
  const effects = []
  const state = { popupMoveOwner: owner, busyKind: "", barMovePending: null,
    actionProc: { running: false }, pinnedProc: { running: false }, barMoveProc: { running: false },
    selfId: "manager", selfEntry: {}, selfEntryLoaded: true, selfSettings: {},
    allowUnverifiedUpdates: false, allowUnverifiedInstalls: false, tiledExpandedPanel: false,
    pendingKind: "", pendingId: "", pendingLabel: "", pendingPlacementNeeded: false,
    rows: [], catalog: [], catalogLoaded: true, pinnedHelperPath: "/fake/helper", noticeScript: "fake",
    shell: { updateEntryInline(id, entry) { effects.push([id, entry]); return true },
      barConfig: { layout: { left: ["a"], center: [], right: [] } } },
    Quickshell: { execDetached(argv) { effects.push(argv) }, env() { return "" } },
    Model: Function(read("Model.js") + "; return { withSelfSetting, parseSelfSettings, canEnable, canDisable, needsPlacement, canMove, findRow, moveCommand, enableCommand, disableCommand, successMessage, enableNote, disableNote, moveNote, restartShellCommand, barLayoutMove }")(),
    loadProcessSettled: () => true, updateProcessSettled: () => true }
  state.root = state
  for (const name of ["setStatus", "writeSelfSetting", "setAllowUnverifiedUpdates", "setAllowUnverifiedInstalls", "setTiledExpandedPanel",
    "runDetached", "startEnable", "startDisable", "startMoveTo", "restartShell", "askRemove", "askInstall", "askEnable", "askDisable", "askMove",
    "confirmPending", "confirmPlacement", "cancelPending", "startAdd", "launchInstall", "runAction", "canStartUpdate", "startUpdate", "runUpdate", "startBarMove"])
    state[name] = (...args) => call(storeSource, name, state, ...args)
  Object.defineProperty(state, "externalBusy", { get: () => binding(panelSource, "externalBusy", state) })
  for (const name of ["busy", "actionRunning"])
    Object.defineProperty(state, name, { get: () => binding(storeSource, name, state) })
  return { state, effects }
}

for (const lock of ["owner", "local"]) {
  test(`${lock} lock blocks actual popup setters, inventory actions and restart without consuming confirmations`, () => {
    const owner = { busy: lock === "owner" }
    const attempts = [
      s => s.setAllowUnverifiedUpdates(true), s => s.setAllowUnverifiedInstalls(true), s => s.setTiledExpandedPanel(true),
      s => s.runDetached("test", "test", ["fake"]), s => s.startEnable({ id: "a", name: "A", enabled: false }, "right"),
      s => s.startDisable({ id: "a", name: "A", enabled: true }), s => s.restartShell(),
      s => s.askRemove({ id: "a", removable: true }),
      s => s.askInstall({ id: "a", installable: true, updateSnapshot: { repository: "fake", verifiedCommit: "a" } }),
      s => s.askEnable({ id: "a", enabled: false }), s => s.askDisable({ id: "a", enabled: true, canDisable: true }),
      s => s.askMove({ id: "a", enabled: true, kinds: ["bar-widget"], barSection: "left" }),
      s => s.startMoveTo({ id: "a", enabled: true, kinds: ["bar-widget"], barSection: "left" }, "right"),
      s => s.confirmPending(), s => s.confirmPlacement("right"), s => s.startAdd("right"),
      s => s.launchInstall({}, "A"), s => s.runAction("remove", "A", ["fake"]),
      s => s.startUpdate({ id: "a" }), s => s.runUpdate({ id: "a" })
    ]
    for (const attempt of attempts) {
      const { state, effects } = actionStore(owner)
      if (lock === "local") state.busyKind = "remove"
      state.pendingKind = "remove"; state.pendingId = "a"; state.pendingLabel = "A"
      attempt(state)
      assert.equal(effects.length, 0, String(attempt))
      assert.equal(state.actionProc.running || state.pinnedProc.running, false, String(attempt))
      assert.equal(state.pendingKind, "remove", String(attempt))
      assert.equal(state.pendingId, "a", String(attempt))
      assert.equal(state.busyKind, lock === "local" ? "remove" : "", "external lock must not latch local state")
    }
  })
}

test("owner unlock and removal restore popup actions; local busy and owner-free Expanded stay independent", () => {
  const owner = { busy: true }, { state, effects } = actionStore(owner)
  assert.equal(state.busy, true)
  owner.busy = false
  assert.equal(state.busy, false)
  assert.equal(state.setTiledExpandedPanel(true), true)
  state.restartShell()
  state.askDisable({ id: "a", name: "A", enabled: true, canDisable: true })
  assert.equal(effects.length, 3)
  state.busyKind = "remove"; owner.busy = true; owner.busy = false
  assert.equal(state.busy, true)
  state.busyKind = ""
  assert.equal(state.busy, false)
  owner.busy = true; state.popupMoveOwner = null
  assert.equal(state.busy, false)
  state.runAction("remove", "A", ["fake"])
  assert.equal(state.actionProc.running, true)
  const legacy = actionStore().state
  assert.equal(legacy.busy, false)
  assert.equal(legacy.setAllowUnverifiedUpdates(true), true)
  assert.match(storeSource, /property bool externalBusy: false/)
  assert.doesNotMatch(expanded, /externalBusy:/)
  assert.match(panelSource, /readonly property alias busy: store\.busy/)
})

test("unresolved retained moves keep popup mutations locked after exit until reconciliation", () => {
  const h = setup(), { state, effects } = actionStore(h.owner)
  assert.equal(h.request(), true)
  assert.equal(state.busy, true)
  h.finish(1, false)
  assert.equal(state.setAllowUnverifiedInstalls(true), false)
  state.restartShell()
  assert.equal(effects.length, 0)
  assert.equal(h.owner.recover(), true)
  assert.equal(state.busy, false)
  assert.equal(state.setAllowUnverifiedInstalls(true), true)
  assert.equal(effects.length, 1)
})

test("active local processes reject a move before reading host layout, including after busyKind clears", () => {
  for (const process of ["actionProc", "pinnedProc"]) {
    const { state } = actionStore()
    state[process].running = true
    Object.defineProperty(state.shell.barConfig, "layout", { get() { throw Error("preflight must not run") } })
    assert.equal(state.startBarMove({}, "left", 0, "right", 0), false)
    const p = popup({ busy: false, pending: false })
    p.state.store = state
    p.state.openArrange()
    assert.equal(p.state.requestBarMove({}, "left", 0, "right", 0), false)
    assert.equal(p.events.some(Array.isArray), false)
  }
})

function popup(owner = null) {
  const events = []
  const state = { popupMoveOwner: owner, opened: false, arrangeOpen: false, settingsOpen: true,
    detailsEntry: { id: "old" }, store: { actionRunning: false }, busy: false, confirming: false, placing: false,
    bar: {}, anchorItem: {}, activeTab: "installed", pendingTab: "browse", contentFlipAngle: 45,
    contentFlipping: false, contentFlip: { stop() { events.push("stop flip") } },
    barBoard: { heldSnapshot: null, cancelDrag() { this.heldSnapshot = null; events.push("cancel drag") } },
    settingsPane: { visible: true, forceActiveFocus() {} },
    revokeReleaseNavigation() {}, returnFocusToList() {}, closeDetails() { this.detailsEntry = null },
    open() { this.opened = true }, close() { this.opened = false },
    hostWidget: { cancelPopupArrange() { events.push("cancel return") },
      requestPopupMove(...args) { events.push(args); return true } } }
  state.root = state
  for (const name of ["openArrange", "closeArrange", "requestBarMove", "useCurrentLayout", "openSettings", "openDetails", "switchTab", "handleArrangeKey"])
    state[name] = (...args) => call(panelSource, name, state, ...args)
  return { state, events }
}

test("popup Arrange opens locally, cancels an old flip and reports actual readiness", () => {
  const { state, events } = popup()
  assert.equal(state.openArrange(), true)
  assert.equal(state.opened && state.arrangeOpen, true)
  assert.equal(state.settingsOpen, false)
  assert.equal(state.detailsEntry, null)
  assert.equal(state.pendingTab, "")
  assert.equal(state.contentFlipAngle, 0)
  assert.equal(events.includes("cancel return"), true)
  state.settingsPane.visible = false
  events.length = 0
  assert.equal(state.openArrange(), false)
  assert.equal(events.includes("cancel return"), false)
  state.opened = false
  state.open = () => {}
  assert.equal(state.openArrange(), false)
  assert.doesNotMatch(panelSource, /onClicked: root\.expand\("arrange"\)/)
})

test("popup drops use only the host bridge with unchanged raw index and pre-removal gap", () => {
  const { state, events } = popup()
  state.openArrange()
  const args = [{ key: "raw" }, "left", 2, "left", 4]
  assert.equal(state.requestBarMove(...args), false)
  state.popupMoveOwner = { busy: false, pending: false }
  assert.equal(state.requestBarMove(...args), true)
  assert.deepEqual(events.at(-1), args)
  for (const flag of ["busy", "pending"]) {
    state.popupMoveOwner[flag] = true
    assert.equal(state.requestBarMove(...args), false)
    state.popupMoveOwner[flag] = false
  }
  state.arrangeOpen = false
  assert.equal(state.requestBarMove(...args), false)
  assert.doesNotMatch(panelSource, /store\.startBarMove|popupMoveOwner\.start\(/)
})

test("popup recovery is explicit, requires exit and a snapshot, and never dispatches", () => {
  let recoveries = 0
  const { state } = popup({ pending: true, exited: false, snapshot: {}, recover() { recoveries++; return true } })
  state.openArrange()
  assert.equal(state.useCurrentLayout(), false)
  state.popupMoveOwner.exited = true
  state.popupMoveOwner.snapshot = null
  assert.equal(state.useCurrentLayout(), false)
  state.popupMoveOwner.snapshot = {}
  assert.equal(state.useCurrentLayout(), true)
  assert.equal(recoveries, 1)
  state.closeArrange()
  assert.equal(state.useCurrentLayout(), false)
})

test("explicit navigation cancels return even after an automatic close; drag Escape is consumed first", () => {
  const { state, events } = popup()
  const Qt = { Key_Escape: 1, Key_Backspace: 2 }
  state.Qt = Qt
  state.openArrange()
  state.barBoard.heldSnapshot = {}
  assert.equal(state.handleArrangeKey({ key: 1 }), true)
  assert.equal(state.arrangeOpen, true)
  assert.equal(state.handleArrangeKey({ key: 1 }), true)
  assert.equal(state.arrangeOpen, false)
  for (const leave of [() => state.openSettings(), () => state.openDetails({ id: "new" }), () => state.switchTab("installed")]) {
    state.openArrange()
    state.arrangeOpen = false // automatic close/rebuild must not revoke the retained route
    leave()
    assert.equal(events.at(-1), "cancel return")
  }
  assert.equal(state.handleArrangeKey({ key: 9 }), false)
  const closed = panelSource.match(/onOpenedChanged: \{\s*if \(!opened\) \{([^\n]*)/)[1]
  assert.doesNotMatch(closed, /closeArrange|cancelPopupArrange/)
  assert.doesNotMatch(panelSource, /Component\.onDestruction:.*cancel/)
})

function setup() {
  const bridge = Function(read("PopupBridge.js").replace(/^\.pragma library$/m, "") +
    "; return { register, unregister, registerOwner, unregisterOwner, requestMove, continueArrange, cancelArrange, openPopup }")()
  const shell = { barConfig: { layout: { left: ["a", "b"], center: [], right: [] } } }
  let dispatches = 0
  const proc = { running: false, set command(value) { dispatches++; this.argv = value } }
  const store = { shell, barMovePending: null, barMoveExited: true, barMoveFailed: false,
    setStatus(text, error) { this.status = text; this.statusIsError = error } }
  Object.defineProperty(store, "busy", { get: () => store.barMovePending !== null })
  for (const name of ["startBarMove", "finishBarMove", "reconcileBarMove"])
    store[name] = (...args) => call(storeSource, name, { root: store, barMoveProc: proc, Model }, ...args)
  const owner = { continuationActive: false, generation: 0 }
  const pendingChanged = Function("root", "popupMoves",
    expanded.match(/function onBarMovePendingChanged\(\) \{ (.*) \}/)[1])
  let pending = null
  Object.defineProperty(store, "barMovePending", {
    get: () => pending,
    set(value) { pending = value; pendingChanged({ barMovePending: pending !== null }, owner) }
  })
  for (const [key, source] of Object.entries({ pending: "barMovePending", exited: "barMoveExited", busy: "busy" }))
    Object.defineProperty(owner, key, { get: () => key === "pending" ? store[source] !== null : store[source] })
  const state = { store, root: { shell }, Model }
  owner.start = (...args) => call(expanded, "startPopupMove", state, ...args)
  owner.recover = () => call(expanded, "recoverPopupMove", state)
  function widget(screenName, ready = true) {
    const w = { screenName, ready, opens: 0, arrangements: 0, moveOwner: null,
      setMoveOwner(value) { this.moveOwner = value },
      open() { this.opens++ },
      openArrange() { if (!this.ready) return false; this.arrangements++; return true } }
    bridge.register(w)
    return w
  }
  bridge.registerOwner(owner)
  const first = widget("DP-1"), other = widget("DP-2")
  const request = (w = first) => bridge.requestMove(w, Model.barLayoutSnapshot(shell.barConfig.layout), "left", 0, "right", 0)
  function finish(code = 0, matched = true) {
    if (matched) shell.barConfig.layout = store.barMovePending.expected.layout
    proc.running = false
    store.finishBarMove(code)
  }
  const tick = () => bridge.continueArrange(owner)
  return { bridge, owner, store, shell, proc, first, other, widget, request, finish, tick, dispatches: () => dispatches }
}

test("rebuilt popup opens the actual local overlay once; a later Settings choice revokes it", () => {
  const h = setup()
  h.request(); h.bridge.unregister(h.first)
  const replacement = h.widget("DP-1")
  const { state } = popup(h.owner)
  state.hostWidget.cancelPopupArrange = () => h.bridge.cancelArrange()
  replacement.openArrange = () => call(widgetSource, "openArrange", { panelLoader: { item: state } })
  h.finish(); h.tick(); h.tick()
  assert.equal(state.opened && state.arrangeOpen, true)
  assert.equal(h.other.arrangements, 0)
  assert.equal(h.dispatches(), 1)
  h.request(replacement); state.openSettings(); h.finish(); h.tick()
  assert.equal(state.settingsOpen, true)
  assert.equal(state.arrangeOpen, false)
})

test("popup overlay projects owner status, blocks background focus, and injects the board theme", () => {
  const pane = panelSource.split("id: arrangeStatus")[1].split("Flickable {")[0]
  const expression = pane.match(/text: ([\s\S]*?)\n\s*color:/)[1]
  const text = root => Function("root", `return ${expression}`)(root)
  assert.match(text({ popupMoveOwner: null }), /not ready/)
  const root = { popupMoveOwner: { status: "Unknown outcome" }, barMovePending: true, barSnapshot: null }
  assert.equal(text(root), "Unknown outcome")
  root.barMovePending = false
  assert.match(text(root), /layout unavailable/i)
  root.barSnapshot = {}
  assert.equal(text(root), "Unknown outcome")
  assert.match(panelSource, /blocked: .*root\.arrangeOpen/)
  assert.match(panelSource, /focusTarget: root\.arrangeOpen \? settingsPane : keyCatcher/)
  assert.match(panelSource, /arrangeBusy: !popupMoveOwner \|\| popupMoveOwner\.busy \|\| barMovePending/)
  for (const property of ["fill", "rowFill", "foreground", "mutedForeground", "borderColor", "accent", "fontFamily", "fontPixelSize", "spacing", "radius", "rowHeight"])
    assert.match(pane.split("BarLayoutPane {")[1], new RegExp(`${property}: (root\\.|Color\\.|Style\\.)`))
})

test("hidden owner dispatches raw positional move once, globally locking expanded and popup", () => {
  const h = setup()
  assert.equal(h.first.moveOwner, h.owner)
  assert.equal(h.request(), true)
  assert.equal(h.request(h.other), false)
  assert.equal(h.store.startBarMove(null, "left", 0, "right", 0), false)
  assert.equal(h.dispatches(), 1)
  assert.deepEqual(h.proc.argv.slice(4), ["omarchy-bar", "move", "a", "--from-section", "left", "--from-index", "0", "--section", "right", "--index", "0"])
  h.tick()
  assert.equal(h.first.arrangements, 0)
  assert.equal(h.owner.recover(), false)
  assert.equal(h.first.opens + h.other.opens, 0)
})

test("destroyed popup is never called; replacement on original screen receives continuation once", () => {
  const h = setup()
  h.request()
  h.bridge.unregister(h.first)
  h.first.openArrange = () => { throw Error("dead popup") }
  h.finish()
  h.tick()
  assert.equal(h.other.arrangements, 0)
  const replacement = h.widget("DP-1", false)
  h.tick()
  replacement.ready = true
  h.tick(); h.tick()
  assert.equal(replacement.arrangements, 1)
  assert.equal(h.dispatches(), 1)
  assert.equal(h.owner.continuationActive, false)
})

test("continuation is bounded, falls back only without original screen, and cancellation is final", () => {
  const h = setup()
  h.request(); h.finish()
  h.first.ready = false
  for (let i = 0; i < 40; i++) h.tick()
  h.first.ready = true
  h.tick()
  assert.equal(h.first.arrangements + h.other.arrangements, 0)
  assert.equal(h.owner.continuationActive, false)
  const fallback = setup()
  fallback.request(); fallback.bridge.unregister(fallback.first); fallback.finish()
  for (let i = 0; i < 40; i++) fallback.tick()
  assert.equal(fallback.other.arrangements, 1)
  const cancelled = setup()
  cancelled.request(); cancelled.bridge.cancelArrange(); cancelled.finish(); cancelled.tick()
  assert.equal(cancelled.first.arrangements, 0)
  assert.equal(cancelled.dispatches(), 1)
})

for (const [code, matched] of [[0, true], [1, true], [0, false], [1, false]]) {
  test(`exit ${code}, matched ${matched}: restore/recover without replay`, () => {
    const h = setup()
    h.request(); h.finish(code, matched); h.tick()
    assert.equal(h.first.arrangements, 1)
    assert.equal(h.owner.pending, !matched)
    if (!matched) assert.equal(h.owner.recover(), true)
    h.tick()
    assert.equal(h.first.arrangements, 1)
    assert.equal(h.dispatches(), 1)
  })
}

test("newer expanded request, owner replacement/destruction, and reload invalidate reopen", () => {
  const h = setup()
  h.request(); h.finish()
  assert.equal(call(expanded, "requestBarMove", { opened: true, arrangeOpen: true,
    contentFlipping: false, busy: false, store: h.store },
    Model.barLayoutSnapshot(h.shell.barConfig.layout), "right", 0, "left", 0), true)
  assert.equal(h.request(), false)
  h.tick()
  assert.equal(h.first.arrangements, 0)
  h.finish(); h.request()
  const old = h.owner
  h.bridge.registerOwner({ continuationActive: false })
  assert.equal(old.continuationActive, false)
  h.bridge.unregisterOwner(old) // late destruction cannot clear its successor
  assert.notEqual(h.first.moveOwner, null)
  h.bridge.unregisterOwner(h.first.moveOwner)
  assert.equal(h.first.moveOwner, null)
  assert.equal(h.request(), false)
  h.tick()
  assert.equal(h.first.arrangements, 0)
})

test("a newer popup move replaces the settled route rather than reopening both screens", () => {
  const h = setup()
  h.request(); h.finish()
  assert.equal(h.request(h.other), true)
  h.tick()
  assert.equal(h.first.arrangements + h.other.arrangements, 0)
  h.finish(); h.tick(); h.tick()
  assert.equal(h.first.arrangements, 0)
  assert.equal(h.other.arrangements, 1)
  assert.equal(h.dispatches(), 2)
})

test("hidden snapshots refresh without reopening on unrelated host updates", () => {
  const h = setup()
  const state = { opened: false, barMovePending: false, store: h.store, Model,
    shell: h.shell, barSnapshot: null, barBoard: { cancelDrag() {} } }
  state.root = state
  call(expanded, "refreshBarLayout", state)
  assert.equal(state.barSnapshot.key, Model.barLayoutSnapshot(h.shell.barConfig.layout).key)
  h.tick()
  assert.equal(h.first.arrangements + h.other.arrangements, 0)
})

test("legacy collapse routing and panel readiness remain separate", () => {
  const h = setup()
  assert.equal(h.bridge.openPopup("DP-2"), true)
  assert.equal(h.other.opens, 1)
  assert.equal(h.bridge.openPopup("missing"), true)
  assert.equal(h.first.opens, 1)
  const state = { panelLoader: { item: { open() { throw Error("must not open") } } } }
  assert.equal(call(widgetSource, "openArrange", state), false)
  state.panelLoader.item.openArrange = () => true
  assert.equal(call(widgetSource, "openArrange", state), true)
  assert.match(expanded, /onTriggered: PopupBridge\.registerOwner\(popupMoves\)/)
  assert.match(expanded, /Component\.onDestruction: PopupBridge\.unregisterOwner\(popupMoves\)/)
  assert.match(expanded, /onTriggered: PopupBridge\.continueArrange\(popupMoves\)/)
  assert.match(expanded, /onBarMovePendingChanged\(\).*popupMoves\.generation/)
})
