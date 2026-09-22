import test from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, readdirSync, readlinkSync, existsSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { spawn, spawnSync } from "node:child_process"
import vm from "node:vm"

const root = resolve(import.meta.dirname, "..")
const Model = vm.createContext({})
vm.runInContext(readFileSync(join(root, "Model.js"), "utf8"), Model)
const raw = JSON.stringify({ plugins: [{ id: "acme.weather", name: "Weather", stars: 3 }] })
const request = (rawCatalog = raw) => JSON.stringify({ generation: 7, raw: rawCatalog, installedIds: ["acme.weather"] })

async function isolated(run) {
  const dir = mkdtempSync(join(tmpdir(), "catalog-builder test-"))
  const env = { PATH: "/usr/bin:/bin", HOME: dir, QT_QPA_PLATFORM: "offscreen", QML_DISABLE_DISK_CACHE: "1" }
  for (const key of ["XDG_CONFIG_HOME", "XDG_CACHE_HOME", "XDG_RUNTIME_DIR", "XDG_DATA_HOME"]) {
    env[key] = join(dir, key)
    mkdirSync(env[key], { mode: 0o700 })
  }
  try { return await run(dir, env) } finally { rmSync(dir, { recursive: true, force: true }) }
}

function qs(path, env) {
  return spawnSync("/usr/bin/quickshell", ["--no-color", "--path", path], {
    env, detached: true, encoding: "utf8", timeout: 30000, maxBuffer: 20 * 1024 * 1024
  })
}

function helper(env, input, base = root) {
  return spawnSync("/usr/bin/python3", ["-I", "-S", join(base, "helpers/catalog_build.py")], {
    env, input, encoding: "utf8", timeout: 25000, maxBuffer: 20 * 1024 * 1024
  })
}

function decode(result) {
  assert.equal(result.status, 0, result.stderr + result.stdout)
  const frames = result.stdout.trim().split("\n").map(line => {
    assert.ok(Buffer.byteLength(line) <= 65536)
    return JSON.parse(line)
  })
  return { ...frames.pop(), entries: frames.flat() }
}

test("feasibility: isolated Quickshell imports Model.js and exits without a worker", () => isolated((dir, env) => {
  const path = join(dir, "shell.qml")
  writeFileSync(path, `import QtQuick\nimport Quickshell\nimport ${JSON.stringify("file://" + root + "/Model.js")} as Model
ShellRoot { Component.onCompleted: {
 console.log("CATALOG_RESULT:" + JSON.stringify(Model.buildCatalog(${JSON.stringify(raw)}, ["acme.weather"])))
 Qt.callLater(Qt.quit)
} }`)
  const result = qs(path, env)
  assert.equal(result.status, 0, result.stderr + result.stdout)
  const output = (result.stdout + result.stderr).match(/CATALOG_RESULT:(.*)/)
  assert.ok(output, result.stdout + result.stderr)
  assert.deepEqual(JSON.parse(output[1]), JSON.parse(JSON.stringify(Model.buildCatalog(raw, ["acme.weather"]))))
}))

test("isolated catalog helper returns the same model without WorkerScript", () => isolated((dir, env) => {
  const catalog = JSON.stringify({plugins: [
    {id: "builtin", sourceType: "builtin"}, null,
    {id: "__proto__", name: "<Unsafe>", stars: -1},
    {id: "acme.weather", name: "Weather", stars: 3, verificationStatus: "verified", verificationCommit: "a".repeat(40)},
    {id: "constructor", name: "Unicode é", listedAt: "2026-08-19T14:30:00Z", description: "A\\nB"}
  ]})
  const built = decode(helper(env, request(catalog)))
  assert.equal(built.generation, 7)
  assert.deepEqual(built.entries, JSON.parse(JSON.stringify(Model.buildCatalog(catalog, ["acme.weather"]).entries)))
  assert.doesNotMatch(readFileSync(join(root, "PluginStore.qml"), "utf8"), /import QtQml\.WorkerScript|WorkerScript\s*\{/)
}))

test("invalid and oversized requests fail closed; invalid catalogs return the Model error", () => isolated((dir, env) => {
  for (const input of ["invalid", "{}", request("x".repeat(8 * 1024 * 1024 + 1))]) {
    const result = helper(env, input)
    assert.equal(result.status, 1, result.stderr)
    assert.equal(result.stdout, "")
    assert.ok(result.stderr.length < 200)
  }
  assert.equal(decode(helper(env, request("not JSON"))).error, "Could not read the plugin catalog")
  // Enrichment duplicates text into searchText. A small raw document can
  // exceed the separate publication-frame budget; it must not be truncated.
  const result = helper(env, request(JSON.stringify({ plugins: [{ id: "big", description: "x".repeat(40000) }] })))
  assert.equal(result.status, 1)
  assert.equal(result.stdout, "")
}))

function storeFixture(dir, body, base = root) {
  const path = join(dir, "shell.qml")
  writeFileSync(path, `import QtQuick\nimport Quickshell\nimport Quickshell.Io
import ${JSON.stringify("file://" + base)} as Plugin
ShellRoot {
 Plugin.PluginStore { id: store; watchConfig: false }
 function finish(value) { console.log("TEST_RESULT:" + JSON.stringify(value)); Qt.callLater(Qt.quit) }
 ${body}
}`)
  return path
}

function outcome(result) {
  assert.equal(result.status, 0, result.stdout + result.stderr)
  const match = (result.stdout + result.stderr).match(/TEST_RESULT:(.*)/)
  assert.ok(match, result.stdout + result.stderr)
  assert.doesNotMatch(result.stdout + result.stderr, /ReferenceError|TypeError|Error loading configuration/)
  return JSON.parse(match[1])
}

test("supersession and destruction never signal a starting or unowned PID", () => {
  const source = readFileSync(join(root, "PluginStore.qml"), "utf8")
  const apply = source.match(/^  function applyCatalog\([^]*?^  }/m)[0]
  const stop = source.match(/^  function stopCatalogBuild\([^]*?^  }/m)?.[0] || ""
  const processSource = source.slice(source.indexOf("    id: catalogBuilder"), source.indexOf("  function applyCatalogResult"))
  const destruction = processSource.match(/Component.onDestruction: (.*)/)[1]
  for (const running of [true, false]) for (const processId of [0, undefined, -1, NaN, 1234]) {
    const signals = []
    const process = { running, processId, signal: value => signals.push(value) }
    const state = { catalogGeneration: 7, catalogBuildExit: -1, catalogBuildPending: null,
      rows: [], startCatalogBuild() {} }
    state.root = state
    const api = Function("state", "Model", "catalogBuilder", `with (state) {
      ${stop}\n${apply}
      return { applyCatalog, stopCatalogBuild: typeof stopCatalogBuild === "function" ? stopCatalogBuild : null }
    }`)(state, Model, process)
    state.stopCatalogBuild = api.stopCatalogBuild
    api.applyCatalog(raw)
    const expected = running && processId > 0 ? [15] : []
    const supersessionSignals = [...signals]
    signals.length = 0
    Function("root", "process", `with (process) { ${destruction} }`)(state, process)
    assert.deepEqual({supersession: supersessionSignals, destruction: signals},
      {supersession: expected, destruction: expected}, `running=${running}, pid=${processId}`)
  }
})

test("onStarted cancels a superseded launch instead of writing its stale request", () => {
  const source = readFileSync(join(root, "PluginStore.qml"), "utf8")
  const processSource = source.slice(source.indexOf("    id: catalogBuilder"), source.indexOf("  function applyCatalogResult"))
  const started = processSource.match(/onStarted: \{([^]*?)^    }/m)[1]
  for (const generation of [6, 7]) {
    const signals = [], writes = []
    const state = { catalogBuildStarted: false, catalogBuildGeneration: 6, catalogGeneration: generation,
      stopCatalogBuild: () => signals.push(15) }
    const process = { request: "old request", stdinEnabled: true, write: value => writes.push(value) }
    Function("root", "process", `with (process) { ${started} }`)(state, process)
    assert.deepEqual(writes, generation === 6 ? ["old request"] : [])
    assert.deepEqual(signals, generation === 6 ? [] : [15])
    assert.equal(state.catalogBuildStarted, true)
    assert.equal(process.request, "")
    assert.equal(process.stdinEnabled, false)
  }
})

test("failed launch retains the catalog, settles callbacks, and permits a real retry", () => isolated((dir, env) => {
  faultFixture(dir, "")
  writeFileSync(join(dir, "CatalogBuilder.qml"), readFileSync(join(root, "CatalogBuilder.qml")))
  const source = readFileSync(join(dir, "PluginStore.qml"), "utf8")
  writeFileSync(join(dir, "PluginStore.qml"), source.replace("  id: root", "  id: root\n  property alias buildProcess: catalogBuilder"))
  const path = storeFixture(dir, `
 property var command: null
 property var saved: null
 property bool recovered: false
 property int stage: 0
 Component.onCompleted: {
   store.catalog = [{id: "cached"}]; saved = store.catalog; store.catalogLoaded = true
   command = store.buildProcess.command
   store.buildProcess.command = [${JSON.stringify(join(dir, "missing-executable"))}]
   store.catalogLoading = true; store.applyCatalog(${JSON.stringify(raw)})
 }
 Timer { interval: 10; running: true; repeat: true; onTriggered: {
   if (store.catalogLoading) return
   if (stage === 0) {
     recovered = store.catalog === saved && store.catalogLoaded
       && store.catalogError.indexOf("start") !== -1 && store.catalogError.length < 200
       && store.catalogBuildExit !== -1 && store.catalogBuildOutputDone && store.catalogBuildErrorDone
       && store.buildProcess.request === ""
     stage = 1; store.buildProcess.command = command
     store.catalogLoading = true; store.applyCatalog(${JSON.stringify(raw)})
   } else {
     finish({recovered: recovered, error: store.catalogError, ids: store.catalog.map(e => e.id)}); stop()
   }
 } }
 Timer { interval: 2500; running: true; onTriggered: finish({wedged: store.catalogLoading}) }
 `, dir)
  assert.deepEqual(outcome(qs(path, env)), {recovered: true, error: "", ids: ["acme.weather"]})
}))

test("real store retains errors, retries, and rejects a superseded build", () => isolated((dir, env) => {
  const path = storeFixture(dir, `
 property int stage: 0
 property var saved: null
 property bool retained: false
 Component.onCompleted: { store.catalogLoading = true; store.applyCatalog(${JSON.stringify(raw)}) }
 Timer { interval: 10; running: true; repeat: true; onTriggered: {
   if (store.catalogLoading) return
   if (stage === 0) {
     if (!store.catalogLoaded) { finish({error: store.catalogError}); return }
     saved = store.catalog; stage = 1; store.catalogLoading = true; store.applyCatalog("bad")
   } else if (stage === 1) {
     retained = store.catalog === saved && store.catalogLoaded && store.catalogError !== ""
     stage = 2; store.catalogLoading = true
     store.applyCatalog('{"plugins":[{"id":"obsolete"}]}')
     store.applyCatalog(${JSON.stringify(raw)})
     store.rows = [{id: "acme.weather"}]
   } else {
     finish({retained: retained, error: store.catalogError, ids: store.catalog.map(e => e.id), installed: store.catalog[0].installed})
   }
 } }
 `)
  assert.deepEqual(outcome(qs(path, env)), { retained: true, error: "", ids: ["acme.weather"], installed: true })
}))

test("6000-entry store publication is complete and yields between frames", t => isolated((dir, env) => {
  const plugins = Array.from({ length: 6000 }, (_, i) => ({ id: `acme.plugin${i}`, name: `Plugin ${i}`, stars: i,
    description: "Representative marketplace description", category: "Utilities" }))
  const rawCatalog = JSON.stringify({ plugins })
  writeFileSync(join(dir, "catalog.json"), rawCatalog)
  const expected = JSON.parse(JSON.stringify(Model.buildCatalog(rawCatalog, []).entries))
  assert.deepEqual(decode(helper(env, request(rawCatalog))).entries, expected)
  const path = storeFixture(dir, `
 property double started: 0
 property double publication: 0
 property double previous: 0
 property int maxGap: 0
 property int ticks: 0
 FileView { path: ${JSON.stringify(join(dir, "catalog.json"))}; onLoaded: {
   started = Date.now(); previous = started; store.catalogLoading = true; store.applyCatalog(text())
 } }
 Connections { target: store; function onCatalogBuildExitChanged() { if (store.catalogBuildExit === 0) publication = Date.now() } }
 Timer { interval: 1; running: started > 0; repeat: true; onTriggered: {
   var now = Date.now(); maxGap = Math.max(maxGap, now - previous); previous = now; ticks++
   if (store.catalogLoading) return
   finish({count: store.catalog.length, first: store.catalog[0].id, last: store.catalog[5999].id,
     elapsedMs: now - started, publicationMs: now - publication, maxGapMs: maxGap, ticks: ticks, error: store.catalogError})
   stop()
 } }
 `)
  const result = outcome(qs(path, env))
  assert.equal(result.error, "")
  assert.equal(result.count, 6000)
  assert.equal(result.first, expected[0].id)
  assert.equal(result.last, expected[5999].id)
  assert.ok(result.ticks > 2)
  t.diagnostic(JSON.stringify(result))
}))

test("publication stamps the current install opt-in rather than the build snapshot", () => isolated((dir, env) => {
  const catalog = JSON.stringify({plugins: [{id: "acme.fresh", name: "Fresh", repo: "https://github.com/acme/fresh",
    installCommand: "omarchy plugin add https://github.com/acme/fresh.git --enable", installAvailable: true,
    sourceType: "community", verificationStatus: "unverified", listingValidatedBranch: "main"}]})
  const path = storeFixture(dir, `
 Component.onCompleted: {
   store.catalogLoading = true; store.applyCatalog(${JSON.stringify(catalog)})
   store.selfSettings = {allowUnverifiedInstalls: true}
 }
 Timer { interval: 10; running: true; repeat: true; onTriggered: {
   if (store.catalogLoading) return
   var entry = store.catalog[0]
   var offered = entry.installable && entry.installUnverified
   store.selfSettings = {}
   finish({offered: offered, disabled: !store.catalog[0].installable})
   stop()
 } }
 `)
  assert.deepEqual(outcome(qs(path, env)), {offered: true, disabled: true})
}))

// Faults live only in a private copy, with the real supervisor and store.
function faultFixture(dir, qml, deadline = 20) {
  mkdirSync(join(dir, "helpers"))
  for (const file of ["PluginStore.qml", "Model.js"]) writeFileSync(join(dir, file), readFileSync(join(root, file)))
  writeFileSync(join(dir, "helpers/catalog_build.py"), readFileSync(join(root, "helpers/catalog_build.py"), "utf8")
    .replace("DEADLINE = 20", `DEADLINE = ${deadline}`))
  writeFileSync(join(dir, "CatalogBuilder.qml"), `import QtQuick\nimport Quickshell\nShellRoot { ${qml} }`)
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
function children(pid) {
  try { return readFileSync(`/proc/${pid}/task/${pid}/children`, "utf8").trim().split(/\s+/).filter(Boolean).map(Number) }
  catch { return [] }
}
function alive(pid) {
  try { return !readFileSync(`/proc/${pid}/stat`, "utf8").split(") ").pop().startsWith("Z ") }
  catch { return false }
}

for (const mode of ["owner destruction", "parent exit", "parent SIGKILL"]) {
  test(`early ${mode} leaves no running helper descendants`, () => isolated(async (dir, env) => {
    faultFixture(dir, "Component.onCompleted: { while (true) {} }")
    const path = storeFixture(dir, `
 property var owned: null
 Component.onCompleted: {
   owned = Qt.createComponent("PluginStore.qml").createObject(null, {watchConfig: false})
   owned.applyCatalog(${JSON.stringify(raw)})
 }
 Timer { interval: 800; running: true; onTriggered: {
   ${mode === "owner destruction" ? "owned.destroy(); owned = null" : "Qt.quit()"}
 } }
 Timer { interval: 1500; running: true; onTriggered: Qt.quit() }
 `, dir)
    const owner = spawn("/usr/bin/quickshell", ["--no-color", "--path", path], { env, detached: true, stdio: ["ignore", "pipe", "pipe"] })
    let logs = ""
    owner.stdout.on("data", chunk => { logs += chunk })
    owner.stderr.on("data", chunk => { logs += chunk })
    const closed = new Promise(resolve => owner.on("close", resolve))
    const descendants = new Set()
    const scratch = new Set()
    let engineLimits = ""
    try {
      for (let i = 0; i < 250 && owner.exitCode === null; i++) {
        const pending = children(owner.pid)
        for (let j = 0; j < pending.length; j++) {
          const child = pending[j]
          descendants.add(child)
          try {
            if (readFileSync(`/proc/${child}/comm`, "utf8").trim() === "quickshell")
              engineLimits = readFileSync(`/proc/${child}/limits`, "utf8")
            for (const fd of readdirSync(`/proc/${child}/fd`)) {
              const match = readlinkSync(`/proc/${child}/fd/${fd}`).match(/^\/tmp\/omarchy-catalog-[^/]+(?=\/)/)
              if (match) scratch.add(match[0])
            }
          } catch {}
          pending.push(...children(child))
        }
        if (mode === "parent SIGKILL" && descendants.size >= 3 && scratch.size > 0 && engineLimits) {
          owner.kill("SIGKILL")
          break
        }
        await sleep(10)
      }
      assert.equal(await closed, mode === "parent SIGKILL" ? null : 0, logs)
      assert.ok(descendants.size >= 3, "observed observer, guardian and offscreen engine: " + logs)
      await sleep(150)
      for (const pid of descendants) assert.equal(alive(pid), false, `descendant ${pid} survived ${mode}`)
      assert.ok(scratch.size > 0, "observed the owned private scratch directory")
      for (const directory of scratch) assert.equal(existsSync(directory), false, "scratch survived " + mode)
      assert.match(engineLimits, /Max address space\s+2147483648\s+2147483648/)
    } finally {
      if (owner.exitCode === null) owner.kill("SIGKILL")
      await closed
      for (const directory of scratch) rmSync(directory, {recursive: true, force: true})
    }
  }))
}

test("deadline and raw output overflow stop the isolated engine", () => isolated((dir, env) => {
  faultFixture(dir, "Component.onCompleted: { while (true) {} }", 0.3)
  const start = Date.now()
  const timeout = helper(env, request(), dir)
  assert.equal(timeout.status, 1)
  assert.equal(timeout.stdout, "")
  assert.ok(Date.now() - start < 2000)
  writeFileSync(join(dir, "helpers/catalog_build.py"), readFileSync(join(root, "helpers/catalog_build.py")))
  writeFileSync(join(dir, "CatalogBuilder.qml"), `import QtQuick\nimport Quickshell
ShellRoot { Component.onCompleted: { console.log("x".repeat(17 * 1024 * 1024)); Qt.callLater(Qt.quit) } }`)
  const overflow = helper(env, request(), dir)
  assert.equal(overflow.status, 1)
  assert.equal(overflow.stdout, "")
}))

test("aggregate publication budget is independent of raw catalog bytes", () => isolated((dir, env) => {
  const catalog = JSON.stringify({plugins: Array.from({length: 5000}, (_, i) => ({id: `test.${i}`, description: "é".repeat(300)}))})
  assert.ok(Buffer.byteLength(catalog) < 8 * 1024 * 1024)
  const result = helper(env, request(catalog))
  assert.equal(result.status, 1)
  assert.equal(result.stdout, "", "an oversized publication must never be partially emitted")
}))
