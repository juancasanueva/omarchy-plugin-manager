import assert from "node:assert/strict"
import { spawn, spawnSync } from "node:child_process"
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"

function updateScript() {
  const source = readFileSync(new URL("../PluginStore.qml", import.meta.url), "utf8")
  const marker = "readonly property string updateScript:"
  const start = source.indexOf(marker)
  const end = source.indexOf("\n\n  Process {", start)
  assert.notEqual(start, -1)
  assert.notEqual(end, -1)
  return Function(`return (${source.slice(start + marker.length, end).trim()})`)()
}

function loadScript() {
  const source = readFileSync(new URL("../PluginStore.qml", import.meta.url), "utf8")
  const processStart = source.indexOf("id: loadProc")
  const marker = "command: "
  const start = source.indexOf(marker, processStart)
  const end = source.indexOf("\n    stdout:", start)
  assert.notEqual(processStart, -1)
  assert.notEqual(start, -1)
  assert.notEqual(end, -1)
  const command = Function(`return (${source.slice(start + marker.length, end).trim()})`)()
  assert.deepEqual(command.slice(0, 2), ["bash", "-c"])
  return command[2]
}

function executable(path, source) {
  writeFileSync(path, source)
  chmodSync(path, 0o755)
}

function runProducer(environment) {
  return spawnSync("bash", ["-c", updateScript()], {
    encoding: "utf8",
    env: { ...process.env, ...environment },
    maxBuffer: 32 * 1024 * 1024,
    timeout: 30_000
  })
}

function panelFunctions(root, loadProc, updateProc, names) {
  const source = readFileSync(new URL("../PluginStore.qml", import.meta.url), "utf8")
  const extract = name => {
    const start = source.indexOf(`function ${name}(`)
    assert.notEqual(start, -1, name)
    const brace = source.indexOf("{", start)
    let depth = 0
    for (let index = brace; index < source.length; index++) {
      if (source[index] === "{") depth++
      else if (source[index] === "}" && --depth === 0) return source.slice(start, index + 1)
    }
    assert.fail(`Unterminated Panel function ${name}`)
  }
  return Function("root", "loadProc", "updateProc",
    `${names.map(extract).join("\n")}\nreturn {${names.join(",")}}`)(root, loadProc, updateProc)
}

function refreshSchedulerHarness() {
  const starts = { load: 0, update: 0 }
  const process = kind => {
    let running = false
    return Object.defineProperty({}, "running", {
      get: () => running,
      set: value => {
        if (value === true && running === false) starts[kind]++
        running = value
      }
    })
  }
  const loadProc = process("load"), updateProc = process("update")
  const root = {
    loadProcessExited: true,
    loadOutputFinished: true,
    updateProcessExited: true,
    updateOutputFinished: true,
    freshUpdateCycleQueued: false,
    loading: false,
    checkingUpdates: false,
    reloadStarted() {}
  }
  Object.assign(root, panelFunctions(root, loadProc, updateProc, [
    "loadProcessSettled", "updateProcessSettled", "reload", "checkUpdates",
    "requestFreshUpdateCycle", "drainFreshUpdateCycle"
  ]))
  const callback = (kind, event) => {
    if (kind === "load") {
      if (event === "stopped") loadProc.running = false
      else if (event === "exit") root.loadProcessExited = true
      else root.loadOutputFinished = true
    } else {
      if (event === "stopped") updateProc.running = false
      else if (event === "exit") root.updateProcessExited = true
      else root.updateOutputFinished = true
    }
    root.drainFreshUpdateCycle()
  }
  return { root, loadProc, updateProc, starts, callback }
}

const delay = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds))

function processExists(pid) {
  try { process.kill(pid, 0); return true }
  catch (error) { if (error.code === "ESRCH") return false; throw error }
}

async function waitUntil(predicate, message, timeout = 3000) {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    if (predicate()) return
    await delay(10)
  }
  assert.fail(message)
}

function processSession(pid) {
  const stat = readFileSync(`/proc/${pid}/stat`, "utf8")
  return Number(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[3])
}

test("load producer emits strict checkout HEAD provenance without coupling exact tags to update state", () => {
  const root = mkdtempSync(join(tmpdir(), "plugin-load-head-test-"))
  const home = join(root, "home"), bin = join(root, "bin")
  const plugins = join(home, ".config", "omarchy", "plugins")
  const heads = {
    "01-valid-40": "A".repeat(40),
    "02-valid-64": "b".repeat(64),
    "03-exact-tag": "c".repeat(40),
    "04-malformed": "g".repeat(40),
    "05-hostile": "d".repeat(39) + "\nforged"
  }

  try {
    for (const path of [plugins, bin]) mkdirSync(path, { recursive: true })
    for (const id of Object.keys(heads)) {
      const path = join(plugins, id)
      mkdirSync(join(path, ".git"), { recursive: true })
      writeFileSync(join(path, "manifest.json"), JSON.stringify({ version: "1.0.3" }))
    }
    const absent = join(plugins, "06-absent")
    mkdirSync(join(absent, ".git"), { recursive: true })
    writeFileSync(join(absent, "manifest.json"), JSON.stringify({ version: "1.0.3" }))

    executable(join(bin, "omarchy"), `#!/usr/bin/env bash
case "$*" in
  "plugin catalog") printf '[]';;
  "plugin list --json") printf '[]';;
  *) exit 1;;
esac
`)
    executable(join(bin, "git"), `#!/usr/bin/env bash
path=""; if [ "\${1:-}" = -C ]; then path="$2"; shift 2; fi
command="\${1:-}"; shift || true; id="\${path##*/}"
case "$command" in
  rev-parse)
    case "$id" in
      01-valid-40) printf '${heads["01-valid-40"]}\\n';;
      02-valid-64) printf '${heads["02-valid-64"]}\\n';;
      03-exact-tag) printf '${heads["03-exact-tag"]}\\n';;
      04-malformed) printf '${heads["04-malformed"]}\\n';;
      05-hostile) printf '%s\\n' '${heads["05-hostile"]}';;
      *) exit 1;;
    esac;;
  show-ref) [ "$id" = 03-exact-tag ] && [ "\${@: -1}" = refs/tags/v1.0.3 ];;
  rev-list) [ "$id" = 03-exact-tag ] && printf '${heads["03-exact-tag"]}\\n';;
  remote) printf 'https://github.com/acme/%s.git\\n' "$id";;
  *) exit 1;;
esac
`)

    const result = spawnSync("bash", ["-c", loadScript()], {
      encoding: "utf8",
      env: { ...process.env, HOME: home, PATH: `${bin}:${process.env.PATH}`, LC_ALL: "C" },
      maxBuffer: 4 * 1024 * 1024,
      timeout: 30_000
    })
    assert.equal(result.status, 0, result.stderr)
    assert.equal(result.stderr, "")
    const gitSection = result.stdout.split("===git===\n")[1].split("\n===manifest===")[0]
    const records = gitSection.trim().split("\n").map(line => JSON.parse(line))
    const byId = Object.fromEntries(records.map(record => [record.path.split("/").at(-1), record]))
    for (const record of records)
      assert.deepEqual(Object.keys(record).sort(), ["exactTag", "headSha", "path", "remote"])
    for (const [id, headSha] of Object.entries(heads)) assert.equal(byId[id].headSha, headSha)
    assert.equal(byId["06-absent"].headSha, "")
    assert.equal(byId["03-exact-tag"].exactTag, "v1.0.3")
    for (const id of ["01-valid-40", "02-valid-64", "04-malformed", "05-hostile", "06-absent"])
      assert.equal(byId[id].exactTag, "")
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("post-update refresh coalesces through success or failure in every lifecycle order", async t => {
  const scenarios = [
    { name: "busy load failure, running clears last", busy: ["load"], callbacks: [
      ["load", "exit"], ["load", "output"], ["load", "stopped"]
    ] },
    { name: "busy check success, exit arrives last", busy: ["update"], callbacks: [
      ["update", "output"], ["update", "stopped"], ["update", "exit"]
    ] },
    { name: "both busy, failed exits first", busy: ["load", "update"], callbacks: [
      ["load", "exit"], ["update", "exit"], ["load", "output"], ["update", "output"],
      ["load", "stopped"], ["update", "stopped"]
    ] },
    { name: "both busy, outputs first", busy: ["load", "update"], callbacks: [
      ["update", "output"], ["load", "output"], ["update", "stopped"], ["load", "exit"],
      ["update", "exit"], ["load", "stopped"]
    ] }
  ]

  for (const scenario of scenarios) await t.test(scenario.name, () => {
    const harness = refreshSchedulerHarness()
    if (scenario.busy.includes("load")) harness.root.reload()
    if (scenario.busy.includes("update")) harness.root.checkUpdates()
    const before = { ...harness.starts }

    // Repeated success/programmatic requests are one bounded debt, not retries.
    harness.root.requestFreshUpdateCycle()
    harness.root.requestFreshUpdateCycle()
    harness.root.requestFreshUpdateCycle()
    assert.equal(harness.root.freshUpdateCycleQueued, true)
    assert.deepEqual(harness.starts, before)

    for (let index = 0; index < scenario.callbacks.length; index++) {
      harness.callback(...scenario.callbacks[index])
      if (index < scenario.callbacks.length - 1) assert.deepEqual(harness.starts, before)
    }

    assert.equal(harness.root.freshUpdateCycleQueued, false)
    assert.deepEqual(harness.starts, { load: before.load + 1, update: before.update + 1 })
    // Exit handlers may call the drain again; the started pair remains unique.
    harness.root.drainFreshUpdateCycle()
    assert.deepEqual(harness.starts, { load: before.load + 1, update: before.update + 1 })
  })
})

test("queued post-update cycle reaches fresh HEAD-bound evidence without a manual request", () => {
  const harness = refreshSchedulerHarness()
  harness.root.reload()
  harness.root.checkUpdates()
  harness.root.requestFreshUpdateCycle()
  for (const callback of [
    ["load", "output"], ["update", "exit"], ["load", "exit"],
    ["update", "output"], ["update", "stopped"], ["load", "stopped"]
  ]) harness.callback(...callback)
  assert.deepEqual(harness.starts, { load: 2, update: 2 })

  const modelSource = readFileSync(new URL("../Model.js", import.meta.url), "utf8")
  const Model = Function(`${modelSource}; return { parseUpdateReport, applyUpdateReport }`)()
  const head = "b".repeat(40)
  const rows = [{
    id: "acme.plugin", sourceDir: "/plugins/acme", localVersion: "2.0.0",
    remote: "https://github.com/acme/plugin.git", headSha: head
  }]
  const report = Model.parseUpdateReport(JSON.stringify({
    path: "/plugins/acme", localSha: head, remoteSha: head,
    localVersion: "2.0.0", remoteVersion: ""
  }))
  const fresh = Model.applyUpdateReport(rows, report)[0]
  assert.equal(fresh.headSha, head)
  assert.equal(fresh.localSha, head)
  assert.equal(fresh.remoteSha, head)
  assert.equal(fresh.updateChecked, true)
  assert.equal(fresh.behind, false)
})

test("successful update queues the fresh cycle and update entry points enforce settled processes", () => {
  const source = readFileSync(new URL("../PluginStore.qml", import.meta.url), "utf8")
  const clear = source.indexOf('if (kind === "update") {', source.indexOf("id: actionProc"))
  const fresh = source.indexOf(
    'if (exitCode === 0 && kind === "update") root.requestFreshUpdateCycle()', clear)
  assert.notEqual(clear, -1)
  assert.ok(fresh > clear)
  assert.equal(source.split(
    'if (exitCode === 0 && kind === "update") root.requestFreshUpdateCycle()').length - 1, 1)

  const start = source.indexOf("function canStartUpdate(row)")
  const end = source.indexOf("\n  }", start)
  const body = source.slice(start, end)
  assert.match(body, /!root\.loadProcessSettled\(\)/)
  assert.match(body, /!root\.updateProcessSettled\(\)/)
  assert.match(source, /if \(!canStartUpdate\(row\)\) return/)
  for (const surface of ["../Panel.qml", "../Expanded.qml"]) {
    const surfaceSource = readFileSync(new URL(surface, import.meta.url), "utf8")
    assert.match(surfaceSource, /updateEnabled: root\.updateActionsEnabled/)
  }
  assert.equal(source.split("onRunningChanged: if (!running) root.drainFreshUpdateCycle()").length - 1, 2)

  const row = readFileSync(new URL("../PluginRow.qml", import.meta.url), "utf8")
  assert.match(row, /property bool updateEnabled: true/)
  assert.match(row, /enabled: root\.actionsEnabled && root\.updateEnabled/)
})

test("update producer cannot interleave large concurrent records or publish partial workers", () => {
  const root = mkdtempSync(join(tmpdir(), "plugin-update-producer-test-"))
  const home = join(root, "home"), runtime = join(root, "runtime"), bin = join(root, "bin")
  const plugins = join(home, ".config", "omarchy", "plugins")
  const coordination = join(root, "coordination")
  const workerCount = 18, expected = new Map()

  try {
    for (const path of [plugins, runtime, bin, coordination]) mkdirSync(path, { recursive: true })
    chmodSync(runtime, 0o700)
    const hostile = "x".repeat(64 * 1024) + "\n\t\"} forged {\"path\":\"/victim\"}"
    for (let index = 0; index < workerCount; index++) {
      const name = index === 3 ? "worker 03 [literal]*" : `worker-${String(index).padStart(2, "0")}`
      const path = join(plugins, name)
      const version = `${index}:${hostile}`
      mkdirSync(join(path, ".git"), { recursive: true })
      writeFileSync(join(path, "manifest.json"), JSON.stringify({ version }))
      expected.set(path, version)
    }

    executable(join(bin, "git"), `#!/usr/bin/env bash
case " $* " in *" rev-parse --abbrev-ref HEAD "*) printf 'main\\n';; *" rev-parse HEAD "*) printf '%040d\\n' 0;; *" ls-remote "*) printf '%040d\\trefs/heads/main\\n' 0;; *) exit 1;; esac
`)
    // This barrier deterministically corrupts a shared stdout pipe: every jq
    // writes half a large record before any writes its remainder. Per-worker
    // files keep those writes isolated, and failed/empty files never publish.
    executable(join(bin, "jq"), `#!/usr/bin/env bash
if [ "\${1:-}" != "-cn" ]; then exec /usr/bin/jq "$@"; fi
previous=""; for argument in "$@"; do
  if [ "$previous" = path ]; then path="$argument"; break; fi
  if [ "$previous" = --arg ]; then previous="$argument"; continue; fi
  previous="$argument"
done
record=$(/usr/bin/jq "$@") || exit
id=\${path##*/}; half=$(( \${#record} / 2 ))
[ "$id" = worker-08 ] || printf %s "\${record:0:half}"
: > "$STRESS_COORDINATION/ready.$id"
while :; do ready=("$STRESS_COORDINATION"/ready.*)
  [ -e "\${ready[0]}" ] && [ "\${#ready[@]}" -ge "$STRESS_WORKERS" ] && break
  sleep 0.005; done
[ "$id" = worker-07 ] && exit 1
[ "$id" = worker-08 ] && exit 0
printf '%s\\n' "\${record:half}"
`)

    const result = runProducer({
      HOME: home, XDG_RUNTIME_DIR: runtime,
      PATH: `${bin}:${process.env.PATH}`,
      LC_ALL: "C", STRESS_COORDINATION: coordination,
      STRESS_WORKERS: String(workerCount)
    })
    assert.equal(result.status, 0, result.stderr)
    assert.equal(result.stderr, "")
    const records = result.stdout.trimEnd().split("\n").map(line => JSON.parse(line))
    const wanted = [...expected.keys()]
      .filter(path => !path.endsWith("worker-07") && !path.endsWith("worker-08"))
      .sort()
    assert.equal(records.length, workerCount - 2)
    assert.deepEqual(records.map(record => record.path), wanted)
    for (const record of records) {
      assert.deepEqual(Object.keys(record).sort(),
        ["localSha", "localVersion", "path", "remoteSha", "remoteVersion"])
      assert.equal(record.localVersion, expected.get(record.path))
    }
    assert.deepEqual(readdirSync(runtime), [])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("update producer reads remote manifest versions without background tag probes", () => {
  const root = mkdtempSync(join(tmpdir(), "plugin-update-version-test-"))
  const home = join(root, "home"), runtime = join(root, "runtime"), bin = join(root, "bin")
  const plugins = join(home, ".config", "omarchy", "plugins"), gitLog = join(root, "git-requests")
  const localSha = "a".repeat(40)
  const remote = {
    "01-lightweight": "b".repeat(40),
    "02-annotated": "c".repeat(40),
    "03-both": "d".repeat(40),
    "04-wrong-commit": "e".repeat(40),
    "05-same-version": "f".repeat(40),
    "06-no-tag": "1".repeat(40),
    "07-malicious": "2".repeat(40),
    "08-oversized": "3".repeat(40),
    "09-invalid-ref": "4".repeat(40),
    "10-plain-tag": "5".repeat(40),
    "11-annotated-plain": "6".repeat(40),
    "12-non-github": "7".repeat(40)
  }

  try {
    for (const path of [plugins, runtime, bin]) mkdirSync(path, { recursive: true })
    chmodSync(runtime, 0o700)
    for (const id of Object.keys(remote)) {
      const path = join(plugins, id)
      mkdirSync(join(path, ".git"), { recursive: true })
      writeFileSync(join(path, "manifest.json"), JSON.stringify({ version: "1.0.0" }))
    }

    executable(join(bin, "git"), `#!/usr/bin/env bash
path=""; if [ "\${1:-}" = -C ]; then path="$2"; shift 2; fi
command="\${1:-}"; shift || true; id="\${path##*/}"
remote_sha() { case "$id" in
  01-lightweight) printf '${remote["01-lightweight"]}';; 02-annotated) printf '${remote["02-annotated"]}';;
  03-both) printf '${remote["03-both"]}';; 04-wrong-commit) printf '${remote["04-wrong-commit"]}';;
  05-same-version) printf '${remote["05-same-version"]}';; 06-no-tag) printf '${remote["06-no-tag"]}';;
  07-malicious) printf '${remote["07-malicious"]}';; 08-oversized) printf '${remote["08-oversized"]}';;
  09-invalid-ref) printf '${remote["09-invalid-ref"]}';; 10-plain-tag) printf '${remote["10-plain-tag"]}';;
  11-annotated-plain) printf '${remote["11-annotated-plain"]}';; 12-non-github) printf '${remote["12-non-github"]}';;
esac; }
case "$command" in
  rev-parse) [ "\${1:-}" = --abbrev-ref ] && printf 'main\\n' || printf '${localSha}\\n';;
  remote) if [ "$id" = 12-non-github ]; then printf 'https://gitlab.com/acme/thing.git\\n'; else printf 'https://github.com/acme/%s.git\\n' "$id"; fi;;
  ls-remote)
    printf '%s\\n' "$id $*" >> "$GIT_LOG"
    case " $* " in *" refs/heads/main "*) printf '%s\\trefs/heads/main\\n' "$(remote_sha)";; *) exit 99;; esac;;
  *) exit 1;;
esac
`)
    executable(join(bin, "curl"), `#!/usr/bin/env bash
url="\${@: -1}"
case "$url" in
  */${remote["01-lightweight"]}/manifest.json) printf '{"version":"2.0.0"}';;
  */${remote["02-annotated"]}/manifest.json) printf '{"version":"2.1.0"}';;
  */${remote["03-both"]}/manifest.json) printf '{"version":"2.2.0"}';;
  */${remote["04-wrong-commit"]}/manifest.json) printf '{"version":"2.3.0"}';;
  */${remote["05-same-version"]}/manifest.json) printf '{"version":"1.0.0"}';;
  */${remote["06-no-tag"]}/manifest.json) printf '{"version":"2.4.0"}';;
  */${remote["07-malicious"]}/manifest.json) printf '%s' '{"version":"bad\\nversion"}';;
  */${remote["08-oversized"]}/manifest.json) printf '{"version":"%s"}' "$(printf 'x%.0s' {1..101})";;
  */${remote["09-invalid-ref"]}/manifest.json) printf '{"version":"bad..tag"}';;
  */${remote["10-plain-tag"]}/manifest.json) printf '{"version":"3.0.0"}';;
  */${remote["11-annotated-plain"]}/manifest.json) printf '{"version":"3.1.0"}';;
  *) exit 22;;
esac
`)

    const result = runProducer({
      HOME: home, XDG_RUNTIME_DIR: runtime, PATH: `${bin}:${process.env.PATH}`,
      LC_ALL: "C", GIT_LOG: gitLog
    })
    assert.equal(result.status, 0, result.stderr)
    assert.equal(result.stderr, "")
    const records = result.stdout.trimEnd().split("\n").map(line => JSON.parse(line))
    const byId = Object.fromEntries(records.map(record => [record.path.split("/").at(-1), record]))
    assert.equal(byId["01-lightweight"].remoteVersion, "2.0.0")
    assert.equal(byId["02-annotated"].remoteVersion, "2.1.0")
    assert.equal(byId["03-both"].remoteVersion, "2.2.0")
    assert.equal(byId["04-wrong-commit"].remoteVersion, "2.3.0")
    assert.equal(byId["05-same-version"].remoteVersion, "1.0.0")
    assert.equal(byId["06-no-tag"].remoteVersion, "2.4.0")
    assert.equal(byId["07-malicious"].remoteVersion, "bad\nversion")
    assert.equal(byId["08-oversized"].remoteVersion, "x".repeat(101))
    assert.equal(byId["09-invalid-ref"].remoteVersion, "bad..tag")
    assert.equal(byId["10-plain-tag"].remoteVersion, "3.0.0")
    assert.equal(byId["11-annotated-plain"].remoteVersion, "3.1.0")
    assert.equal(byId["12-non-github"].remoteVersion, "")

    const requested = readFileSync(gitLog, "utf8")
    assert.doesNotMatch(requested, /refs\/tags\//)
    assert.equal(requested.trim().split("\n").length, Object.keys(remote).length)
    assert.deepEqual(readdirSync(runtime), [])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("SIGTERM revokes output and reaps a blocked worker with its network descendant", async () => {
  const root = mkdtempSync(join(tmpdir(), "plugin-update-termination-test-"))
  const home = join(root, "home"), runtime = join(root, "runtime"), bin = join(root, "bin")
  const plugin = join(home, ".config", "omarchy", "plugins", "blocked")
  const ready = join(root, "ready"), networkFile = join(root, "network-pid")
  const descendantFile = join(root, "descendant-pid")
  let child = null, workerSession = 0

  try {
    for (const path of [join(plugin, ".git"), runtime, bin]) mkdirSync(path, { recursive: true })
    chmodSync(runtime, 0o700)
    writeFileSync(join(plugin, "manifest.json"), JSON.stringify({ version: "1.0.0" }))
    executable(join(bin, "git"), `#!/usr/bin/env bash
path=""; if [ "\${1:-}" = -C ]; then path="$2"; shift 2; fi
command="\${1:-}"; shift || true
case "$command" in
  rev-parse) [ "\${1:-}" = --abbrev-ref ] && printf 'main\\n' || printf '%040d\\n' 0;;
  ls-remote)
    printf '%s\\n' "$$" > "$NETWORK_PID_FILE"
    sleep 30 & descendant=$!
    printf '%s\\n' "$descendant" > "$DESCENDANT_PID_FILE"
    : > "$READY_FILE"
    wait "$descendant";;
  *) exit 1;;
esac
`)

    let stdout = "", stderr = ""
    child = spawn("bash", ["-c", updateScript()], {
      env: {
        ...process.env,
        HOME: home,
        XDG_RUNTIME_DIR: runtime,
        PATH: `${bin}:${process.env.PATH}`,
        LC_ALL: "C",
        READY_FILE: ready,
        NETWORK_PID_FILE: networkFile,
        DESCENDANT_PID_FILE: descendantFile
      },
      stdio: ["ignore", "pipe", "pipe"]
    })
    child.stdout.setEncoding("utf8").on("data", chunk => { stdout += chunk })
    child.stderr.setEncoding("utf8").on("data", chunk => { stderr += chunk })

    await waitUntil(() => existsSync(ready), "blocked network descendant did not start")
    const networkPid = Number(readFileSync(networkFile, "utf8").trim())
    const descendantPid = Number(readFileSync(descendantFile, "utf8").trim())
    workerSession = processSession(networkPid)
    assert.notEqual(workerSession, child.pid)
    for (const pid of [child.pid, workerSession, networkPid, descendantPid])
      assert.equal(processExists(pid), true, `expected pid ${pid} to be alive before SIGTERM`)

    const exited = new Promise((resolve, reject) => {
      child.once("error", reject)
      child.once("exit", (code, signal) => resolve({ code, signal }))
    })
    child.kill("SIGTERM")
    const result = await Promise.race([
      exited,
      delay(3000).then(() => assert.fail("producer did not exit after SIGTERM"))
    ])
    assert.deepEqual(result, { code: 143, signal: null }, stderr)
    await waitUntil(
      () => [child.pid, workerSession, networkPid, descendantPid].every(pid => !processExists(pid)),
      "producer left a worker or network descendant alive")
    assert.equal(stdout, "")
    assert.deepEqual(readdirSync(runtime), [])
  } finally {
    if (child && child.pid && processExists(child.pid)) child.kill("SIGKILL")
    if (workerSession > 0)
      spawnSync("/usr/bin/pkill", ["-KILL", "-s", String(workerSession)])
    rmSync(root, { recursive: true, force: true })
  }
})

test("update producer owns cleanup before creation across signals, collisions, and root fallback", () => {
  const root = mkdtempSync(join(tmpdir(), "plugin-update-lifecycle-test-"))
  const home = join(root, "home"), runtime = join(root, "runtime"), invalid = join(root, "invalid")
  const bin = join(root, "bin"), log = join(root, "candidates"), count = join(root, "collision")
  const modeLog = join(root, "mode"), workerMarker = join(root, "worker-ran")
  const otherProducer = join(runtime, "omarchy-plugin-manager-updates.999999.other.0")

  try {
    for (const path of [join(home, ".config/omarchy/plugins"), runtime, invalid, bin, otherProducer])
      mkdirSync(path, { recursive: true })
    chmodSync(runtime, 0o700)
    chmodSync(invalid, 0o755)
    executable(join(bin, "mkdir"), `#!/usr/bin/env bash
path="\${@: -1}"; printf '%s\\n' "$path" >> "$PROBE_LOG"
if [ "$PROBE_ACTION" = fail ]; then exit 73; fi
if [ "$PROBE_ACTION" = collide ] && [ ! -e "$PROBE_COUNT" ]; then : > "$PROBE_COUNT"; exit 1; fi
/usr/bin/mkdir "$@" || exit
/usr/bin/stat -c %a -- "$path" > "$PROBE_MODE_LOG"
if [ "$PROBE_ACTION" = signal ]; then kill -TERM "$PPID"; fi
`)
    executable(join(bin, "git"), `#!/usr/bin/env bash
: > "$WORKER_MARKER"
exit 1
`)
    const run = (action, xdg = runtime) => runProducer({
      HOME: home, XDG_RUNTIME_DIR: xdg, PATH: `${bin}:${process.env.PATH}`,
      PROBE_ACTION: action, PROBE_LOG: log, PROBE_COUNT: count,
      PROBE_MODE_LOG: modeLog, WORKER_MARKER: workerMarker
    })
    const candidates = () => readFileSync(log, "utf8").trim().split("\n")
    const reset = () => { rmSync(log, { force: true }); rmSync(count, { force: true }); rmSync(modeLog, { force: true }) }

    let result = run("normal")
    assert.equal(result.status, 0, result.stderr)
    assert.equal(candidates()[0].startsWith(`${runtime}/omarchy-plugin-manager-updates.`), true)
    assert.equal(readFileSync(modeLog, "utf8").trim(), "700")
    assert.equal(existsSync(candidates()[0]), false)

    reset(); result = run("normal", invalid)
    assert.equal(result.status, 0, result.stderr)
    assert.equal(candidates()[0].startsWith("/tmp/omarchy-plugin-manager-updates."), true)
    assert.equal(existsSync(candidates()[0]), false)

    reset(); result = run("collide")
    assert.equal(result.status, 0, result.stderr)
    assert.equal(candidates().length, 2)
    assert.notEqual(candidates()[0], candidates()[1])
    for (const path of candidates()) assert.equal(existsSync(path), false)

    reset(); result = run("signal")
    assert.equal(result.status, 143, result.stderr)
    assert.equal(existsSync(candidates()[0]), false)
    assert.equal(existsSync(otherProducer), true)

    mkdirSync(join(home, ".config/omarchy/plugins/probe/.git"), { recursive: true })
    reset(); result = run("fail")
    assert.equal(result.status, 1)
    assert.equal(candidates().length, 16)
    assert.equal(existsSync(workerMarker), false)
    for (const path of candidates()) assert.equal(existsSync(path), false)
    assert.deepEqual(readdirSync(runtime), ["omarchy-plugin-manager-updates.999999.other.0"])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
