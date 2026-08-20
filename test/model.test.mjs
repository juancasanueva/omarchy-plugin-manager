// Model.js is loaded by QML, so it has no module system of its own. Reading
// and evaluating the source keeps the shipped file free of node-isms while
// still letting the parsing rules be tested outside a running shell.
import { readFileSync } from "node:fs"
import { test } from "node:test"
import assert from "node:assert/strict"

const source = readFileSync(new URL("../Model.js", import.meta.url), "utf8")
const Model = new Function(
  source + `
  return {
    splitSections, parseArray, parseGitMap, mergePlugins, countRemovable,
    subtitle, normalizeGitUrl, isValidGitUrl, repoLabel, lastLine,
    actionVerb, actionGerund, successMessage, failureMessage
  }`
)()

const payload = (list, catalog, git) =>
  `===list===\n${list}\n===catalog===\n${catalog}\n===git===\n${git}`

test("splitSections rejects output that is missing a section", () => {
  assert.equal(Model.splitSections("===list===\n[]"), null)
  assert.equal(Model.splitSections(""), null)
})

test("splitSections rejects sections that arrive out of order", () => {
  assert.equal(Model.splitSections("===git===\n===list===\n===catalog===\n"), null)
})

test("splitSections returns each section's body", () => {
  const sections = Model.splitSections(payload("[1]", "[2]", "a\tb"))
  assert.equal(sections.list.trim(), "[1]")
  assert.equal(sections.catalog.trim(), "[2]")
  assert.equal(sections.git.trim(), "a\tb")
})

test("parseArray tells a failed command apart from an empty result", () => {
  assert.deepEqual(Model.parseArray("[]"), [])
  assert.equal(Model.parseArray("command not found"), null)
  assert.equal(Model.parseArray('{"id":"x"}'), null)
  assert.equal(Model.parseArray(""), null)
})

test("parseGitMap keeps a checkout whose origin remote is empty", () => {
  const map = Model.parseGitMap("/plugins/withremote\thttps://example.com/a.git\n/plugins/noremote\t\n")
  assert.equal(map["/plugins/withremote"], "https://example.com/a.git")
  assert.equal(map["/plugins/noremote"], "")
  assert.ok("noremote" in {} === false)
  assert.ok(Object.prototype.hasOwnProperty.call(map, "/plugins/noremote"))
})

test("parseGitMap skips blank and separator-less lines", () => {
  const map = Model.parseGitMap("\n/plugins/a\thttps://x/a.git\nnot-a-row\n")
  assert.deepEqual(Object.keys(map), ["/plugins/a"])
})

const listEntries = [
  { id: "omarchy.clock", name: "Clock", kinds: ["bar-widget"], enabled: true, firstParty: true },
  { id: "acme.weather", name: "Weather", kinds: ["bar-widget"], enabled: true, firstParty: false },
  { id: "acme.dev", name: "Dev", kinds: ["service"], enabled: false, firstParty: false }
]
const catalogEntries = [
  { id: "omarchy.clock", sourceDir: "/usr/share/omarchy/shell/plugins/panels/clock", description: "Clock" },
  { id: "acme.weather", sourceDir: "/plugins/acme.weather", description: "Weather" },
  { id: "acme.dev", sourceDir: "/plugins/acme.dev", description: "Dev" }
]
const gitMap = { "/plugins/acme.weather": "https://example.com/weather.git", "/plugins/acme.dev": "" }

test("mergePlugins puts installed plugins ahead of built-ins", () => {
  const rows = Model.mergePlugins(listEntries, catalogEntries, gitMap)
  assert.deepEqual(rows.map(r => r.id), ["acme.dev", "acme.weather", "omarchy.clock"])
})

test("mergePlugins marks built-ins as neither removable nor updatable", () => {
  const clock = Model.mergePlugins(listEntries, catalogEntries, gitMap).find(r => r.id === "omarchy.clock")
  assert.equal(clock.removable, false)
  assert.equal(clock.updatable, false)
  assert.equal(clock.gitManaged, false)
})

test("mergePlugins offers update only where a remote exists", () => {
  const rows = Model.mergePlugins(listEntries, catalogEntries, gitMap)
  const weather = rows.find(r => r.id === "acme.weather")
  const dev = rows.find(r => r.id === "acme.dev")

  assert.equal(weather.gitManaged, true)
  assert.equal(weather.updatable, true)
  assert.equal(weather.remote, "https://example.com/weather.git")

  // A working copy with no origin is still git-managed, but a fast-forward
  // has nowhere to pull from.
  assert.equal(dev.gitManaged, true)
  assert.equal(dev.updatable, false)
  assert.equal(dev.removable, true)
})

test("mergePlugins survives a plugin the catalog never mentioned", () => {
  const rows = Model.mergePlugins([{ id: "ghost", name: "Ghost", firstParty: false }], [], {})
  assert.equal(rows.length, 1)
  assert.equal(rows[0].sourceDir, "")
  assert.equal(rows[0].removable, false)
  assert.equal(rows[0].updatable, false)
})

test("mergePlugins ignores entries with no id", () => {
  assert.deepEqual(Model.mergePlugins([null, {}, { name: "x" }], [], {}), [])
})

test("countRemovable counts only what lives in the user plugin directory", () => {
  assert.equal(Model.countRemovable(Model.mergePlugins(listEntries, catalogEntries, gitMap)), 2)
})

test("isValidGitUrl accepts the three shapes git actually clones", () => {
  assert.ok(Model.isValidGitUrl("https://github.com/user/repo.git"))
  assert.ok(Model.isValidGitUrl("ssh://git@github.com/user/repo.git"))
  assert.ok(Model.isValidGitUrl("git@github.com:user/repo.git"))
  assert.ok(Model.isValidGitUrl("  https://github.com/user/repo  "))
})

test("isValidGitUrl rejects anything that could reach the CLI as a flag or a mess", () => {
  assert.equal(Model.isValidGitUrl(""), false)
  assert.equal(Model.isValidGitUrl("   "), false)
  assert.equal(Model.isValidGitUrl("--yes"), false)
  assert.equal(Model.isValidGitUrl("-f"), false)
  assert.equal(Model.isValidGitUrl("file:///etc/passwd"), false)
  assert.equal(Model.isValidGitUrl("http://github.com/user/repo.git"), false)
  assert.equal(Model.isValidGitUrl("https://github.com/user/repo .git"), false)
  assert.equal(Model.isValidGitUrl("https://github.com"), false)
  assert.equal(Model.isValidGitUrl("github.com/user/repo"), false)
})

test("repoLabel names the repository, not the whole url", () => {
  assert.equal(Model.repoLabel("https://github.com/user/omarchy-clock.git"), "omarchy-clock")
  assert.equal(Model.repoLabel("git@github.com:user/omarchy-clock.git"), "omarchy-clock")
  assert.equal(Model.repoLabel("https://github.com/user/repo/"), "repo")
  assert.equal(Model.repoLabel("nonsense"), "nonsense")
})

test("subtitle says so when a plugin declares no kind", () => {
  assert.equal(Model.subtitle({ id: "a.b", kinds: [] }), "a.b  ·  no kind")
  assert.equal(Model.subtitle({ id: "a.b", kinds: ["bar-widget", "service"] }), "a.b  ·  bar-widget, service")
})

test("lastLine picks the last thing stderr actually said", () => {
  assert.equal(Model.lastLine("first\nsecond\n\n  \n"), "second")
  assert.equal(Model.lastLine("   "), "")
})

test("failureMessage prefers the CLI's own words, and falls back to the exit code", () => {
  assert.equal(Model.failureMessage("add", "fatal: repository not found\n", 128), "Add failed: fatal: repository not found")
  assert.equal(Model.failureMessage("remove", "", 1), "Remove failed (exit 1)")
})

test("actionGerund does not produce Updateing", () => {
  assert.equal(Model.actionGerund("update"), "Updating")
  assert.equal(Model.actionGerund("remove"), "Removing")
  assert.equal(Model.actionGerund("add"), "Adding")
  assert.equal(Model.actionVerb("add"), "Add")
})

test("successMessage says that an added plugin is now live", () => {
  assert.match(Model.successMessage("add", "omarchy-clock"), /enabled/)
})
