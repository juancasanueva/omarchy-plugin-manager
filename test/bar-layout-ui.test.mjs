import { readFileSync } from "node:fs"
import { test } from "node:test"
import assert from "node:assert/strict"

const panel = readFileSync(new URL("../Panel.qml", import.meta.url), "utf8")
const expanded = readFileSync(new URL("../Expanded.qml", import.meta.url), "utf8")
const storeSource = readFileSync(new URL("../PluginStore.qml", import.meta.url), "utf8")
const Model = Function(readFileSync(new URL("../Model.js", import.meta.url), "utf8") +
  "; return { barLayoutSnapshot, barLayoutMove, tiledExpandedPanel, parseSelfSettings, selfEntryFromShellConfig, expandedTabFromPayload, expandedPageFromPayload, expandedScreenFromPayload }")()
function call(source, name, state, ...args) {
  const match = source.match(new RegExp(`  function ${name}\\(([^)]*)\\) \\{([\\s\\S]*?)\\n  \\}`))
  assert.ok(match, `${name} exists`)
  return new Function("state", "args", `with (state) { return (function(${match[1]}) {${match[2]}})(...args) }`)(state, args)
}

function lifecycle() {
  const events = []
  const shell = { barConfig: { layout: { left: ["same", { id: "same", settings: { n: 2 } }], center: [], right: [] } } }
  const proc = { running: false }
  const store = { shell, barMovePending: null, barMoveExited: true, barMoveFailed: false, barMoveBytes: 0,
    cancelPending() { events.push("cancel confirmation") }, loadOnOpen() { events.push("load") },
    setStatus(text, error) { this.status = text; this.statusIsError = error } }
  Object.defineProperty(store, "busy", { get: () => store.barMovePending !== null })
  for (const name of ["startBarMove", "finishBarMove", "reconcileBarMove"])
    store[name] = (...args) => call(storeSource, name, { root: store, barMoveProc: proc, Model }, ...args)
  const state = { shell, store, Model, opened: false, tiled: true, arrangeOpen: true,
    activeTab: "installed", settingsOpen: false, detailsEntry: null, selectedIndex: 2,
    contentFlipping: false, pendingFlip: null, pendingTab: "", contentFlipAngle: 0,
    pluginId: "manager", targetScreenName: "DP-1", barSnapshot: null,
    barBoard: { cancelDrag() { events.push("cancel drag") } },
    contentFlip: { running: false, stop() { events.push("stop flip") }, restart() { events.push("flip") } },
    initialLoad: { stop() { events.push("stop load") }, restart() { events.push("schedule load") } },
    releaseNavigator: { revoke() { events.push("revoke") } },
    configView: { reload() { events.push("read config") }, text() { throw Error("unexpected config read") } },
    tiledWindow: { visible: false }, keyCatcher: { forceActiveFocus() {} },
    titleIconIntro: { stop() {} }, titleIcon: { opacity: 1 }, titleIconIntroArmed: false,
    Qt: { binding: fn => fn, callLater: fn => fn() },
    PopupBridge: { openPopup() { events.push("popup") } } }
  state.root = state
  for (const name of ["open", "close", "dismiss", "collapse", "showRetainedWindow", "loadEverything",
    "refreshBarLayout", "requestBarMove", "useCurrentLayout", "flipTo", "switchTab", "applyPendingFlip",
    "openArrange", "closeArrange", "openSettings", "openDetails"])
    state[name] = (...args) => call(expanded, name, state, ...args)
  Object.defineProperty(state, "barMovePending", { get: () => store.barMovePending !== null })
  Object.defineProperty(state, "busy", { get: () => store.busy })
  shell.hide = () => { state.close(); events.push("host removes open id") }
  const begin = () => {
    state.opened = true
    state.refreshBarLayout()
    assert.equal(state.requestBarMove(state.barSnapshot, "left", 1, "right", 0), true)
    return store.barMovePending
  }
  return { state, store, shell, proc, events, begin }
}

test("explicit Expanded routing preserves the tab and screen, while Arrange stays local", () => {
  const events = []
  const state = { activeTab: "browse", pluginId: "manager", panel: { screen: { name: "DP-2" } },
    revokeReleaseNavigation() {}, closeArrange() {}, close() { events.push("close") },
    bar: { shell: { summon(id, payload) { events.push([id, JSON.parse(payload)]) } } } }
  call(panel, "expand", state, "arrange")
  assert.deepEqual(events, ["close", ["manager", { tab: "browse", screen: "DP-2", page: "arrange" }]])
  events.length = 0
  call(panel, "expand", state, "untrusted")
  assert.equal(events[1][1].page, "")
  state.bar = null
  call(panel, "expand", state, "arrange")
  assert.match(panel, /tooltipText: "Arrange"[\s\S]*?onClicked: root\.arrangeOpen \? root\.closeArrange\(\) : root\.openArrange\(\)/)
})

test("Expanded Arrange, Settings and details are exclusive and Back preserves the tab", () => {
  const state = { activeTab: "browse", settingsOpen: false, arrangeOpen: false, detailsEntry: { id: "old" },
    flipTo(direction, apply) { apply() } }
  call(expanded, "openArrange", state)
  assert.equal(state.arrangeOpen, true)
  assert.equal(state.detailsEntry, null)
  call(expanded, "openSettings", state)
  assert.equal(state.arrangeOpen, false)
  assert.equal(state.settingsOpen, true)
  call(expanded, "openArrange", state)
  assert.equal(state.settingsOpen, false)
  call(expanded, "closeArrange", state)
  assert.equal(state.arrangeOpen, false)
  assert.equal(state.activeTab, "browse")
  call(expanded, "openArrange", state)
  call(expanded, "openDetails", state, { id: "new" })
  assert.equal(state.arrangeOpen, false)
  assert.equal(state.detailsEntry.id, "new")
  assert.match(expanded, /arrangeOpen = Model\.expandedPageFromPayload\(payloadJson\) === "arrange"/)
  assert.match(expanded, /onClicked: root\.arrangeOpen \? root\.closeArrange\(\) : root\.closeSettings\(\)/)
})

test("Arrange wires a themed board to guarded persistence with inventory labels", () => {
  assert.match(expanded, /Model\.barLayoutSnapshot\(root\.shell[^\n]*barConfig\.layout/)
  assert.match(expanded, /labels\[row\.id\] = row\.name/)
  const board = expanded.split("BarLayoutPane {")[1].split("Flickable {")[0]
  assert.match(board, /busy: root\.busy/)
  assert.match(board, /onMoveRequested:[\s\S]*?root\.requestBarMove\(/)
  for (const property of ["fill", "rowFill", "foreground", "mutedForeground", "borderColor", "accent", "fontFamily", "fontPixelSize", "spacing", "radius", "rowHeight"])
    assert.match(board, new RegExp(`${property}: (root\\.|Color\\.|Style\\.)`))
})

test("Arrange status exposes pending outcomes and refused IDs instead of generic busy or inventory errors", () => {
  const body = expanded.match(/id: statusLine[\s\S]*?text: \{([\s\S]*?)\n        \}/)[1]
  const text = Function("root", "Model", body)
  const state = { arrangeOpen: true, barSnapshot: {}, barMovePending: true, busy: true,
    busyKind: "", busyId: "", status: "Move outcome unknown", browsing: false, loadError: "Old inventory error", catalogError: "" }
  assert.equal(text(state, { actionGerund: () => "Working" }), state.status)
  state.barMovePending = false
  state.busy = false
  state.status = "Move refused: this entry ID cannot be transported by omarchy-bar."
  assert.equal(text(state, {}), state.status)
  state.barSnapshot = null
  assert.match(text(state, {}), /layout unavailable/i)
})

test("retained eager load stays hidden and cannot initiate inventory work or dispatch", () => {
  const { state, events } = lifecycle()
  state.loadEverything()
  assert.deepEqual(events, [])
  assert.equal(state.requestBarMove(null, "left", 0, "right", 0), false)
  assert.equal(JSON.parse(readFileSync(new URL("../manifest.json", import.meta.url))).keepLoaded, true)
  assert.match(expanded, /id: configView[\s\S]*?preload: false/)
  assert.match(expanded, /watchConfig: root\.opened/)
  assert.match(storeSource, /id: shellConfig[\s\S]*?preload: false[\s\S]*?blockAllReads: true/)
  assert.doesNotMatch(expanded + storeSource, /Component\.onCompleted:/)
})

test("normal open loads on demand and honors payload; closing cancels the scheduled load", () => {
  const { state, events } = lifecycle()
  state.configView.text = () => "{}"
  state.open('{"page":"arrange","tab":"browse","screen":"DP-2"}')
  assert.equal(state.opened, true)
  assert.equal(state.arrangeOpen, true)
  assert.equal(state.activeTab, "browse")
  assert.equal(state.targetScreenName, "DP-2")
  assert.equal(events.includes("read config"), true)
  assert.equal(events.includes("schedule load"), true)
  state.loadEverything()
  assert.equal(events.filter(event => event === "load").length, 1)
  state.close()
  state.loadEverything()
  assert.equal(events.filter(event => event === "load").length, 1)
  assert.equal(events.includes("stop load"), true)
  assert.equal(state.arrangeOpen, false)
})

test("pending hide/open preserves ownership, snapshot plan and lock without new IO", () => {
  const { state, store, events, begin } = lifecycle()
  const plan = begin()
  state.dismiss()
  assert.equal(state.opened, false)
  assert.equal(store.barMovePending, plan)
  assert.equal(state.arrangeOpen, true)
  state.open('{"tab":"browse"}')
  assert.equal(state.opened, true)
  assert.equal(state.tiledWindow.visible(), true, "reinstalls visibility binding after compositor close")
  assert.equal(state.activeTab, "installed")
  assert.equal(store.barMovePending, plan)
  assert.equal(state.selectedIndex, 2)
  assert.equal(events.includes("cancel confirmation"), false)
  assert.equal(events.includes("schedule load"), false)
  assert.equal(events.includes("read config"), false)
  assert.match(expanded, /onClosed: root\.dismiss\(\)/)
})

test("pending navigation, collapse, animation callbacks and conflicting drops cannot leave Arrange", () => {
  const { state, events, begin } = lifecycle()
  begin()
  events.length = 0
  state.switchTab("browse")
  state.closeArrange()
  state.openSettings()
  state.openDetails({ id: "other" })
  state.collapse()
  state.pendingFlip = () => { state.arrangeOpen = false }
  state.applyPendingFlip()
  assert.equal(state.arrangeOpen, true)
  assert.equal(state.pendingFlip, null)
  assert.equal(state.pendingTab, "")
  assert.equal(state.requestBarMove(state.barSnapshot, "left", 0, "center", 0), false)
  assert.equal(events.includes("flip"), false)
  assert.equal(events.includes("popup"), false)
  call(storeSource, "restartShell", { busy: state.busy, actionProc: { running: false },
    runDetached() { assert.fail("pending move must block restart") } })
})

test("a stale drop, hidden board or flip cannot dispatch through the integration", () => {
  const { state, shell, store } = lifecycle()
  state.opened = true
  state.refreshBarLayout()
  const stale = state.barSnapshot
  shell.barConfig.layout.left.reverse()
  state.refreshBarLayout()
  assert.equal(state.requestBarMove(stale, "left", 0, "right", 0), false)
  assert.equal(store.barMovePending, null)
  state.contentFlipping = true
  assert.equal(state.requestBarMove(state.barSnapshot, "left", 0, "right", 0), false)
  state.contentFlipping = false
  state.arrangeOpen = false
  assert.equal(state.requestBarMove(state.barSnapshot, "left", 0, "right", 0), false)
})

test("host updates cancel stale drag and render raw duplicates before reconciling", () => {
  const { state, store, shell, events, begin } = lifecycle()
  const plan = begin()
  const original = store.reconcileBarMove
  store.reconcileBarMove = accept => {
    assert.equal(events.at(-1), "cancel drag")
    assert.equal(state.barSnapshot.key, Model.barLayoutSnapshot(shell.barConfig.layout).key)
    assert.equal(accept, false)
    return original(accept)
  }
  shell.barConfig.layout = plan.expected.layout
  state.refreshBarLayout()
  assert.equal(state.barSnapshot.rows.find(row => row.section === "right").entry.settings.n, 2)
  assert.equal(store.barMovePending, plan, "host update alone cannot release running client")
})

test("exit and host layout can arrive in either order, without retrying", () => {
  for (const hostFirst of [false, true]) {
    const { state, store, shell, proc, begin } = lifecycle()
    const plan = begin()
    if (hostFirst) { shell.barConfig.layout = plan.expected.layout; state.refreshBarLayout() }
    proc.running = false
    store.finishBarMove(0)
    if (!hostFirst) {
      assert.equal(store.barMovePending, plan, "exit is not confirmation")
      shell.barConfig.layout = plan.expected.layout
      state.refreshBarLayout()
    }
    assert.equal(store.barMovePending, null)
    assert.equal(proc.running, false)
    assert.deepEqual(proc.command.slice(4), plan.command)
  }
})

test("timeout/mismatch recovery needs a human click and unavailable layout allows safe hiding", () => {
  for (const exitCode of [0, 124, 137]) {
    const { state, store, shell, proc, begin } = lifecycle()
    const plan = begin()
    assert.equal(state.useCurrentLayout(), false)
    proc.running = false
    store.finishBarMove(exitCode)
    shell.barConfig.layout = null
    state.refreshBarLayout()
    assert.equal(state.barSnapshot, null)
    assert.equal(state.useCurrentLayout(), false)
    state.dismiss()
    assert.equal(state.opened, false)
    assert.equal(store.barMovePending, plan)
    state.open("{}")
    shell.barConfig.layout = { left: ["new", "new"], center: [], right: [] }
    state.refreshBarLayout()
    assert.equal(store.barMovePending, plan, "fresh but mismatched config is not acceptance")
    assert.equal(state.barSnapshot.rows.length, 2)
    assert.equal(state.useCurrentLayout(), true)
    assert.equal(store.barMovePending, null)
    assert.equal(proc.running, false)
    assert.equal(state.arrangeOpen, true)
  }
})
