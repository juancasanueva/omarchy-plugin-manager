import { readFileSync } from "node:fs"
import { spawnSync } from "node:child_process"
import { runInNewContext } from "node:vm"
import { test } from "node:test"
import assert from "node:assert/strict"

const read = name => readFileSync(new URL(`../${name}`, import.meta.url), "utf8")
const Model = runInNewContext(read("Model.js") + `\n;({parseUpdateDataStatus, parseCleanupResult,
  updateDataCountLabel, cleanupOutcomeText, updateDataCommand, boundedUpdateDataChunk})`)
const paths = { plugins: "/home/test/.config/omarchy/plugins",
  active: "/home/test/.config/omarchy/plugin-manager-updates",
  archive: "/home/test/.config/omarchy/plugin-manager-updates-archive" }
const status = (changes = {}) => ({ schemaVersion: 1, paths, available: true,
  activeCount: 12, lowerBound: false, limit: 32, error: "", ...changes })
const cleanup = (changes = {}) => ({ schemaVersion: 1, status: "complete", discovered: 3,
  visited: 3, removed: 2, preserved: 1, partial: 0, removedUnsynced: 0, unknown: 0,
  discoveryComplete: true, refreshRequired: true, error: "", ...changes })
const parseStatus = (value, code = 0) => Model.parseUpdateDataStatus(JSON.stringify(value), code)
const parseCleanup = (value, code = value.status === "complete" ? 0 : 1) =>
  Model.parseCleanupResult(JSON.stringify(value), code)

test("status validates canonical paths, bounded counts and availability/exit relationships", () => {
  assert.equal(parseStatus(status()).activeCount, 12)
  assert.equal(Model.updateDataCountLabel(parseStatus(status()), false), "12/32")
  assert.equal(Model.updateDataCountLabel(parseStatus(status({ activeCount: 33, lowerBound: true })), false), "≥33/32 (lower bound)")
  assert.equal(Model.updateDataCountLabel(null, true), "Loading…")
  assert.equal(Model.updateDataCountLabel(null, false), "Unavailable")
  assert.equal(parseStatus(status({ activeCount: 0 })).activeCount, 0)
  for (const count of [-1, 34, 1.5, "12", null, true])
    assert.equal(parseStatus(status({ activeCount: count })), null)
  for (const patch of [{ lowerBound: true }, { activeCount: 33 }, { limit: 33 },
    { schemaVersion: 2 }, { paths: null }, { error: "bad" }, { extra: 1 }, { available: 1 }])
    assert.equal(parseStatus(status(patch)), null, JSON.stringify(patch))
  assert.equal(parseStatus(status(), 1), null)
  for (const p of [null, paths]) {
    const value = status({ available: false, activeCount: null, paths: p, error: "Unavailable" })
    assert.equal(parseStatus(value, 1).available, false)
    assert.equal(parseStatus(value), null)
  }
  for (const patch of [{ activeCount: 0 }, { lowerBound: true }, { error: "" }])
    assert.equal(parseStatus(status({ available: false, activeCount: null, error: "Unavailable", ...patch }), 1), null)
  for (const plugins of ["relative/plugins", paths.plugins + "/", "/home/../test/.config/omarchy/plugins",
    "/home/<img>/.config/omarchy/plugins", "/home/test\n/.config/omarchy/plugins", "/home/test\u202e/.config/omarchy/plugins"])
    assert.equal(parseStatus(status({ paths: { ...paths, plugins } })), null)
  assert.equal(parseStatus(status({ paths: { ...paths, active: paths.active + "-other" } })), null)
  assert.equal(parseStatus(status({ error: "x".repeat(201) })), null)
  for (const raw of ["", "null", "[]", "{", JSON.stringify(status()) + "x", " ".repeat(8193)])
    assert.equal(Model.parseUpdateDataStatus(raw, 0), null)
  assert.equal(Model.parseUpdateDataStatus(JSON.stringify(status()), 124), null)
})

test("cleanup exact schema rejects inconsistent success, exit codes, counts and partial claims", () => {
  const result = parseCleanup(cleanup())
  assert.equal(result.removed, 2)
  assert.match(Model.cleanupOutcomeText(result), /removed 2; preserved 1/)
  assert.match(Model.cleanupOutcomeText(result), /this pass only/)
  for (const patch of [{ discovered: 513 }, { visited: 4 }, { removed: -1 }, { preserved: 1.5 },
    { partial: 1 }, { unknown: 1 }, { removedUnsynced: 1 }, { discoveryComplete: false },
    { refreshRequired: false }, { error: "error" }, { schemaVersion: 0 }, { extra: 1 },
    { discovered: 4 }, { status: "success" },
    { discovered: 129, visited: 129, removed: 129, preserved: 0 }])
    assert.equal(parseCleanup(cleanup(patch)), null, JSON.stringify(patch))
  assert.equal(parseCleanup(cleanup(), 1), null)
  for (const state of ["limited", "cancelled", "failed"])
    assert.ok(parseCleanup(cleanup({ status: state, error: "Bounded reason" })))
  const partial = cleanup({ status: "partial", removed: 1, partial: 1, removedUnsynced: 1, error: "Sync failed" })
  assert.ok(parseCleanup(partial))
  assert.match(Model.cleanupOutcomeText(parseCleanup(partial)), /partial 1/)
  assert.equal(parseCleanup(partial, 0), null)
  for (const patch of [{ partial: 2 }, { removedUnsynced: 2 }, { status: "complete" }, { unknown: 1 }])
    assert.equal(parseCleanup({ ...partial, ...patch }, 1), null)
  assert.ok(parseCleanup(cleanup({ status: "unknown", removed: 1, unknown: 1, error: "Lost result" })))
  assert.equal(parseCleanup(cleanup({ status: "unknown", error: "Lost result" })), null)
  assert.equal(parseCleanup(cleanup({ status: "failed", error: "x".repeat(201) })), null)
  const hostile = parseCleanup(cleanup({ status: "failed", error: "<img src=x> & injected" }))
  assert.ok(hostile)
  assert.doesNotMatch(Model.cleanupOutcomeText(hostile), /<|>|&|injected/)
  for (const raw of ["", "null", "[]", "{}", " ".repeat(4097)])
    assert.equal(Model.parseCleanupResult(raw, 0), null)
  for (const code of [-1, 2, 124, 137]) assert.equal(parseCleanup(cleanup(), code), null)
  assert.match(Model.cleanupOutcomeText(null), /unknown/i)
  assert.doesNotMatch(Model.cleanupOutcomeText(null), /removed 0|success|complete/i)
})

test("raw buffers bound UTF-8 conservatively before accumulation, including split surrogates", () => {
  assert.deepEqual(JSON.parse(JSON.stringify(Model.boundedUpdateDataChunk("abc", 3, "é", 5))),
    { text: "abcé", bytes: 5, overflow: false })
  assert.equal(Model.boundedUpdateDataChunk("abc", 3, "€", 5).overflow, true)
  assert.equal(Model.boundedUpdateDataChunk("", 0, "\ud83d", 2).overflow, true)
  assert.equal(Model.boundedUpdateDataChunk("", 0, "x".repeat(8193), 8192).text, "")
})

test("fixed argv has independent group timeout supervision, no shell or display paths", () => {
  for (const destructive of [false, true]) {
    const argv = Array.from(Model.updateDataCommand("/bundle/helpers/pinned_update.py", destructive))
    const seconds = destructive ? "20" : "6"
    assert.deepEqual(argv, ["/usr/bin/timeout", destructive ? "22" : "8",
      "/usr/bin/timeout", "-k", "1", seconds, "/usr/bin/python3", "-I", "-S",
      "/bundle/helpers/pinned_update.py", destructive ? "--cleanup-completed" : "--update-data-status"])
  }
})

test("supervisor survives observer destruction and escalates TERM for a disposable blocking child", () => {
  // No real helper: the test-owned child ignores TERM and only sleeps. Preserve
  // the shipped argv/timeouts and observe EOF after the independent supervisor
  // closes the child's pipes, including after killing the direct observer.
  const program = `
import json, pathlib, select, signal, subprocess, sys, tempfile, time
with tempfile.TemporaryDirectory(prefix="update-data-supervisor-") as directory:
    helper = pathlib.Path(directory) / "blocked.py"
    helper.write_text("import signal, time\\nsignal.signal(signal.SIGTERM, signal.SIG_IGN)\\nprint('ready', flush=True)\\ntime.sleep(60)\\n")
    argv = json.loads(sys.argv[1])
    argv[9] = str(helper)
    process = subprocess.Popen(argv, stdout=subprocess.PIPE, stderr=subprocess.PIPE, env={})
    try:
        assert select.select([process.stdout], [], [], 3)[0], "child failed to start"
        assert process.stdout.readline(16) == b"ready\\n"
        started = time.monotonic()
        interruption = int(sys.argv[2])
        if interruption:
            process.send_signal(interruption)
        out, err = process.communicate(timeout=24)
        elapsed = time.monotonic() - started
        assert process.returncode != 0
        assert out == b"" and err == b""
        assert elapsed >= (0.5 if interruption else int(argv[5])), "deadline and escalation must run"
        assert elapsed < (23 if argv[5] == "20" else 9)
    finally:
        if process.poll() is None:
            process.terminate()
            process.communicate(timeout=24)
`
  for (const [cleanup, signal] of [[false, 0], [true, 0], [false, 15], [false, 9], [true, 9]]) {
    const result = spawnSync("/usr/bin/python3", ["-I", "-S", "-c", program,
      JSON.stringify(Model.updateDataCommand("/unused/test-only.py", cleanup)), String(signal)],
      { encoding: "utf8", timeout: 30000, maxBuffer: 4096 })
    assert.equal(result.status, 0, result.stderr || String(result.error || "supervisor failed"))
  }
})

const storeSource = read("PluginStore.qml")
// Extract the actual store methods, not a reimplementation of their decisions.
function method(name) {
  const start = storeSource.indexOf(`  function ${name}(`)
  assert.notEqual(start, -1, `${name} exists`)
  const end = storeSource.indexOf("\n  }", start)
  return storeSource.slice(start, end + 4)
}
function storeHarness() {
  const later = [], launches = []
  const context = { Model, updateDataStatus: status({ activeCount: 0 }), updateDataLoading: false,
    updateDataRefreshQueued: false, updateDataGeneration: 0, updateDataProcess: null,
    cleanupProcess: null, cleanupOutcome: "", cleanupIsError: false, updateDataDestroying: false,
    externalBusy: false, busyKind: "", barMovePending: null, pendingKind: "", pendingId: "",
    pinnedHelperPath: "/bundle/helper.py", actionProc: { running: false }, pinnedProc: { running: false },
    Qt: { callLater: callback => later.push(callback) }, setStatus() {},
    updateDataProcessComponent: { createObject(owner, properties) {
      const proc = { ...properties, output: "", outputBytes: 0, errorBytes: 0, overflow: false,
        processExited: false, exitCode: -1, settled: false, running: false, signals: [],
        signal(number) { this.signals.push(number) }, destroy() { this.destroyed = true } }
      launches.push(proc)
      return proc
    } }
  }
  context.root = context
  Object.defineProperties(context, {
    busy: { get: () => context.busyKind !== "" || context.externalBusy || context.barMovePending !== null || context.cleanupProcess !== null },
    actionRunning: { get: () => context.actionProc.running || context.pinnedProc.running || context.cleanupProcess !== null }
  })
  const names = ["canCleanupUpdateData", "askCleanupUpdateData", "startCleanupUpdateData", "refreshUpdateData",
    "drainUpdateDataRefresh", "invalidateUpdateData", "finishUpdateDataProcess", "readUpdateDataChunk",
    "stopUpdateDataProcesses", "confirmPending", "cancelPending", "runAction", "launchInstall",
    "canStartUpdate", "writeSelfSetting", "runDetached"]
  runInNewContext(names.map(method).join("\n"), context)
  return { s: context, launches,
    flush() { for (let n = 0; later.length && n < 50; n++) later.shift()(); assert.equal(later.length, 0) },
    finish(proc, result, code = 0) {
      context.readUpdateDataChunk(proc, JSON.stringify(result), false)
      proc.running = false; proc.processExited = true; proc.exitCode = code
      context.finishUpdateDataProcess(proc)
    }
  }
}

test("archive-only active zero can ask; cancellation and stale confirmations launch nothing", () => {
  const h = storeHarness(), s = h.s
  assert.equal(s.canCleanupUpdateData(), true)
  s.askCleanupUpdateData()
  assert.equal(s.pendingKind, "cleanup")
  s.cancelPending()
  s.confirmPending()
  assert.equal(h.launches.length, 0)
  for (const [key, value] of [["externalBusy", true], ["busyKind", "install"], ["barMovePending", {}],
    ["updateDataLoading", true], ["updateDataRefreshQueued", true], ["updateDataStatus", null],
    ["updateDataProcess", {}], ["cleanupProcess", {}]]) {
    const h = storeHarness(), s = h.s
    s.askCleanupUpdateData(); s[key] = value; s.confirmPending()
    assert.equal(h.launches.length, 0, key)
  }
  for (const name of ["actionProc", "pinnedProc"]) {
    const h = storeHarness(); h.s.askCleanupUpdateData(); h.s[name].running = true
    h.s.confirmPending(); assert.equal(h.launches.length, 0, name)
  }
})

test("one confirmation launches once, owns busy, then independently refreshes every outcome", () => {
  for (const outcome of [cleanup(), cleanup({ status: "failed", error: "Locked" }),
    cleanup({ status: "partial", removed: 1, partial: 1, error: "Interrupted" }), null]) {
    const h = storeHarness(), s = h.s
    s.askCleanupUpdateData(); s.confirmPending(); s.confirmPending()
    assert.equal(h.launches.length, 1)
    const proc = h.launches[0]
    assert.equal(proc.cleanup, true)
    assert.equal(s.busy, true)
    assert.equal(s.canCleanupUpdateData(), false)
    assert.equal(s.updateDataStatus, null)
    h.finish(proc, outcome, outcome?.status === "complete" ? 0 : 1)
    h.flush()
    assert.equal(h.launches.length, 2)
    assert.equal(h.launches[1].cleanup, false)
    assert.equal(s.updateDataStatus, null, "removed does not infer active count")
    assert.equal(s.updateDataLoading, true)
    assert.match(s.cleanupOutcome, outcome ? /removed 2|removed 1/ : /unknown/i)
    const message = s.cleanupOutcome
    h.finish(h.launches[1], status({ activeCount: 0 }))
    h.flush()
    assert.equal(s.updateDataStatus.activeCount, 0)
    assert.equal(s.cleanupOutcome, message, "read status cannot hide the outcome")
    assert.equal(h.launches.length, 2, "never autoretry cleanup")
  }
})

test("cleanup busy guard prevents all other store mutations from overlapping", () => {
  const h = storeHarness(), s = h.s
  s.askCleanupUpdateData(); s.confirmPending()
  s.runAction("remove", "sample", ["never-execute"])
  s.launchInstall({}, "sample")
  assert.equal(s.canStartUpdate({}), false)
  assert.equal(s.writeSelfSetting("allowUnverifiedInstalls", true, false), false)
  s.runDetached("sample", "sample", ["never-execute"])
  assert.equal(s.actionProc.running, false)
  assert.equal(s.pinnedProc.running, false)
  assert.equal(h.launches.length, 1)
})

test("stale reads settle before new generation; retired callbacks cannot overwrite or clear it", () => {
  const h = storeHarness(), s = h.s
  s.refreshUpdateData(); const old = h.launches[0]
  s.refreshUpdateData(); s.refreshUpdateData()
  assert.equal(h.launches.length, 1)
  h.finish(old, status())
  assert.equal(s.updateDataStatus, null)
  h.flush()
  assert.equal(h.launches.length, 2)
  const current = h.launches[1]
  s.finishUpdateDataProcess(old)
  s.readUpdateDataChunk(old, "late", false)
  assert.equal(s.updateDataProcess, current)
  h.finish(current, status({ activeCount: 2 }))
  h.flush()
  assert.equal(s.updateDataStatus.activeCount, 2)
  assert.equal(h.launches.length, 2)
})

test("overflow, crash, start failure and destruction cannot become cleanup success", () => {
  for (const stderr of [false, true]) {
    const h = storeHarness(), s = h.s
    s.askCleanupUpdateData(); s.confirmPending()
    const proc = h.launches[0]
    s.readUpdateDataChunk(proc, "é".repeat(4097), stderr)
    assert.equal(proc.overflow, true)
    assert.deepEqual(proc.signals, [15])
    assert.equal(proc.output, "")
    h.finish(proc, cleanup())
    h.flush()
    assert.match(s.cleanupOutcome, /unknown/i)
    assert.equal(h.launches.length, 2)
  }
  const h = storeHarness(), s = h.s
  s.askCleanupUpdateData(); s.confirmPending()
  const proc = h.launches[0]
  proc.running = false // failed to start, no exit signal
  s.finishUpdateDataProcess(proc); h.flush()
  assert.match(s.cleanupOutcome, /unknown/i)
  s.stopUpdateDataProcesses()
  assert.equal(s.updateDataDestroying, true)
  assert.deepEqual(h.launches[1].signals, [15])
  h.finish(h.launches[1], status()); h.flush()
  assert.equal(h.launches.length, 2)
})

test("both surfaces wire Settings to the shared store and destructive confirmation", () => {
  assert.match(storeSource, /completed journals and rollback backups[\s\S]*both active and archive/i)
  assert.match(storeSource, /irreversible/i)
  assert.match(storeSource, /failed and unresolved[\s\S]*installed plugins/i)
  for (const file of ["Panel.qml", "Expanded.qml"]) {
    const source = read(file)
    const start = source.indexOf("SettingsInfo {")
    const info = source.slice(start, source.indexOf("\n           }", start))
    for (const prop of ["updateDataPaths", "updateDataCount", "updateDataLoading", "cleanupOutcome", "cleanupEnabled"])
      assert.match(info, new RegExp(`store\\.${prop}`), `${file} ${prop}`)
    assert.match(info, /onCleanupRequested: store\.askCleanupUpdateData\(\)/)
    assert.doesNotMatch(info, /Quickshell\.env/)
    const open = source.slice(source.indexOf("function openSettings()"), source.indexOf("function closeSettings()"))
    assert.match(open, /store\.refreshUpdateData\(\)/)
    assert.doesNotMatch(open, /askCleanup|startCleanup/)
    assert.match(source, /pendingKind === "cleanup" \? "Delete"/)
    assert.match(source, /onCanceled: (root|store)\.cancelPending\(\)/)
    assert.match(source, /onConfirmed: (root|store)\.confirmPending\(\)/)
  }
  const process = storeSource.slice(storeSource.indexOf("id: updateDataProcessComponent"), storeSource.indexOf("// ---- Positional layout moves"))
  assert.match(process, /stdout: SplitParser[\s\S]*splitMarker: ""/)
  assert.match(process, /stderr: SplitParser[\s\S]*splitMarker: ""/)
  assert.doesNotMatch(process, /StdioCollector|signal\(9\)/)
  assert.match(process, /onExited:[\s\S]*Qt\.callLater/)
  assert.match(storeSource, /Component\.onDestruction: stopUpdateDataProcesses\(\)/)
  assert.match(method("finishPinnedUpdate"), /refreshUpdateData\(\)/)
  const action = storeSource.slice(storeSource.lastIndexOf("id: actionProc"))
  assert.match(action, /refreshUpdateData\(\)/)
})
