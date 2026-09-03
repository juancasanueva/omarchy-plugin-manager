// Model.js is loaded by QML, so it has no module system of its own. Reading
// and evaluating the source keeps the shipped file free of node-isms while
// still letting the parsing rules be tested outside a running shell.
import { spawnSync } from "node:child_process"
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"
import assert from "node:assert/strict"

const source = readFileSync(new URL("../Model.js", import.meta.url), "utf8")
const Model = new Function(
  source + `
  return {
    splitSections, parseArray, parseGitMap, parseManifestMeta, mergePlugins, countRemovable,
    rowsInGroup, groupLabel, sectionHeading,
    kindLabel, kindsLabel, kindOptions, filterByKind, nextKind, filterKind, filterKindLabel,
    statusOptions, filterByStatus,
    matchesQuery, filterRows, isFiltering, emptyMessage, groupOptions, browseFilterHints, installedFilterHints, actionHints, nextOption, verifiedIdSet, isVerified, upToDate,
    parseCatalog, catalogEntries, installedIdSet, installUrlFor, markInstalled,
    restampCatalogInstallState, plainText,
    catalogAssetUrl, catalogCount,
    catalogCategories, catalogKindKey, catalogKindOptions, catalogAvailabilityOptions, catalogSortOptions,
    filterCatalog, sortCatalog, matchesCatalogQuery, catalogIsFiltering,
    clearedCatalogFilters, catalogEmptyMessage,
    installState, installBlockedReason, starLabel, accentColor, installedTint,
    repoShortLabel, browsableUrl, repoWebUrl, rowRepoUrl,
    normalizedManifestVersion, normalizedReleaseVersion, releaseVersionLabel,
    githubReleaseCandidates, versionReleaseCandidates, versionFallbackUrl,
    catalogVersionLabel, catalogVersionReleaseCandidates, catalogVersionFallbackUrl,
    repoPreviewUrl, previewCandidates,
    parseUpdateReport, applyUpdateReport, updateBadge, updateCompareUrl,
    updateReleaseCandidates, versionLabel, countBehind,
    trustedGithubReleaseApiUrl, trustedGithubReleaseUrl, trustedGithubRepoUrl, trustedGithubWebUrl,
    githubNavigationRequest, releaseProbeCommand,
    releaseNavigationInitialState, releaseNavigationRequestTransition,
    releaseNavigationRevokeTransition, releaseNavigationDirectTransition,
    releaseNavigationProbeExitedTransition, releaseNavigationProbeOutputTransition,
    releaseNavigationStartQueuedTransition, releaseNavigationProbeStartFailedTransition,
    metaLine, authorLabel, descriptionLine, hasDescription, sourceBadge,
    normalizeGitUrl, isValidGitUrl, repoLabel, lastLine,
    actionVerb, actionGerund, successMessage, failureMessage,
    needsPlacement, canEnable, placementOptions, enableCommand, findRow,
    canDisable, disableCommand, enableNote, disableNote,
    catalogNeedsPlacement, browseModalFocusOwner, catalogPlacementConfirmationNote
  }`
)()

const CATALOG_DOWNLOAD_LIMIT = 8 * 1024 * 1024
const STATS_DOWNLOAD_LIMIT = 1024 * 1024
const CATALOG_PROJECTION_LIMIT = 8 * 1024 * 1024
const CATALOG_PROJECTION_SCHEMA_VERSION = 1

function catalogScript(catalogPath, statsPath) {
  const panel = readFileSync(new URL("../Panel.qml", import.meta.url), "utf8")
  const marker = "readonly property string catalogScript:"
  const start = panel.indexOf(marker)
  const end = panel.indexOf("\n\n  // No fetch", start)
  assert.notEqual(start, -1)
  assert.notEqual(end, -1)
  return Function("Model", `return (${panel.slice(start + marker.length, end).trim()})`)({
    CATALOG_URL: `file://${catalogPath}`,
    MARKETPLACE_STATS_URL: `file://${statsPath}`
  })
}

function catalogCache(home, value) {
  const path = join(home, ".cache", "omarchy-plugin-manager", "catalog.json")
  mkdirSync(join(home, ".cache", "omarchy-plugin-manager"), { recursive: true })
  writeFileSync(path, value)
  return path
}

function catalogProjectionTemps(home) {
  return readdirSync(join(home, ".cache", "omarchy-plugin-manager"))
    .filter(name => name.startsWith(".catalog.json.tmp."))
}

function runCatalogScript(home, catalogPath, statsPath, forceRefresh = "1", environment = {}) {
  const tempRoot = join(home, "tmp")
  mkdirSync(tempRoot, { recursive: true })
  const result = spawnSync("bash", ["-c", catalogScript(catalogPath, statsPath), "catalog", forceRefresh], {
    encoding: "utf8",
    env: { ...process.env, ...environment, HOME: home, LC_ALL: "C", TMPDIR: tempRoot },
    maxBuffer: 32 * 1024 * 1024,
    timeout: 30_000
  })
  assert.deepEqual(readdirSync(tempRoot), [], "catalogScript should clean its temporary files")
  return result
}

const payload = (list, catalog, git, manifest = "") =>
  `===list===\n${list}\n===catalog===\n${catalog}\n===git===\n${git}\n===manifest===\n${manifest}`

test("splitSections rejects output that is missing a section", () => {
  assert.equal(Model.splitSections("===list===\n[]"), null)
  assert.equal(Model.splitSections(""), null)
})

test("splitSections rejects sections that arrive out of order", () => {
  assert.equal(Model.splitSections("===git===\n===list===\n===catalog===\n===manifest===\n"), null)
})

test("splitSections rejects output that stops before the manifest section", () => {
  assert.equal(Model.splitSections("===list===\n[]\n===catalog===\n[]\n===git===\n"), null)
})

test("splitSections returns each section's body", () => {
  const sections = Model.splitSections(payload("[1]", "[2]", "a\tb", "x\ty\tz"))
  assert.equal(sections.list.trim(), "[1]")
  assert.equal(sections.catalog.trim(), "[2]")
  assert.equal(sections.git.trim(), "a\tb")
  assert.equal(sections.manifest.trim(), "x\ty\tz")
})

test("parseManifestMeta reads the author and version of each manifest", () => {
  const meta = Model.parseManifestMeta("acme.weather\tAcme Corp\t1.2.3\nacme.dev\t\t\n")
  assert.deepEqual(meta["acme.weather"], { author: "Acme Corp", version: "1.2.3" })
  assert.deepEqual(meta["acme.dev"], { author: "", version: "" })
})

test("parseManifestMeta skips blank and separator-less lines", () => {
  const meta = Model.parseManifestMeta("\nno-tabs-here\nacme.weather\tAcme\t1.0.0\n")
  assert.deepEqual(Object.keys(meta), ["acme.weather"])
})

test("parseArray tells a failed command apart from an empty result", () => {
  assert.deepEqual(Model.parseArray("[]"), [])
  assert.equal(Model.parseArray("command not found"), null)
  assert.equal(Model.parseArray('{"id":"x"}'), null)
  assert.equal(Model.parseArray(""), null)
})

// ---- Untrusted display text ----------------------------------------------
//
// Every Text in Qt defaults to Text.AutoText, which sniffs its content and
// renders anything tag-shaped as rich text — including `<img src=…>`, which
// fetches. Names, descriptions, authors and notes all arrive from a public
// registry or from a stranger's manifest, and they are drawn inside a shell
// process that outlives every panel. So they are stripped of anything that
// could open a tag before they are ever stored.

test("plainText removes what could be read as markup", () => {
  assert.equal(Model.plainText('<img src="https://evil/beacon">'), 'img src="https://evil/beacon"')
  assert.equal(Model.plainText("<b>Bold</b>"), "bBold/b")
  assert.equal(Model.plainText("<!DOCTYPE html>"), "!DOCTYPE html")
})

test("plainText leaves ordinary text alone", () => {
  assert.equal(Model.plainText("AT&T Monitor"), "AT&T Monitor")
  assert.equal(Model.plainText("Battery — 80% · charging"), "Battery — 80% · charging")
  assert.equal(Model.plainText(""), "")
  assert.equal(Model.plainText(null), "")
})

// A newline or a carriage return in a one-line label lets crafted text push
// the rest of a confirmation off the visible area.
test("plainText flattens control characters into spaces", () => {
  assert.equal(Model.plainText("Weather\nRemove everything?"), "Weather Remove everything?")
  assert.equal(Model.plainText("a\r\nb\tc"), "a b c")
})

test("parseGitMap keeps JSON-framed remotes and exact local tags, including empty fields", () => {
  const map = Model.parseGitMap([
    JSON.stringify({ path: "/plugins/prefixed", remote: "https://example.com/a.git", exactTag: "v1.0.3", headSha: "A".repeat(40) }),
    JSON.stringify({ path: "/plugins/plain", remote: "git@example.com:b.git", exactTag: "1.0.3", headSha: "b".repeat(64) }),
    JSON.stringify({ path: "/plugins/noremote", remote: "", exactTag: "", headSha: "" })
  ].join("\n"))
  assert.deepEqual(map["/plugins/prefixed"], {
    remote: "https://example.com/a.git", exactTag: "v1.0.3", headSha: "a".repeat(40)
  })
  assert.deepEqual(map["/plugins/plain"], {
    remote: "git@example.com:b.git", exactTag: "1.0.3", headSha: "b".repeat(64)
  })
  assert.deepEqual(map["/plugins/noremote"], { remote: "", exactTag: "", headSha: "" })
  assert.ok("noremote" in {} === false)
  assert.ok(Object.prototype.hasOwnProperty.call(map, "/plugins/noremote"))
})

test("parseGitMap skips malformed, non-object, and wrong-schema JSON records", () => {
  const valid = JSON.stringify({ path: "/plugins/a", remote: "https://x/a.git", exactTag: "v1", headSha: "a".repeat(40) })
  const records = [
    "not-json",
    "/plugins/legacy\thttps://github.com/owner/repo.git\tv1.0.0",
    "null",
    "[]",
    '"string"',
    JSON.stringify({ path: "/plugins/missing", remote: "https://x/missing.git", exactTag: "v1" }),
    JSON.stringify({ path: "/plugins/wrong-type", remote: 42, exactTag: "v1", headSha: "a".repeat(40) }),
    JSON.stringify({ path: "/plugins/extra", remote: "https://x/extra.git", exactTag: "v1", headSha: "a".repeat(40), forged: true }),
    JSON.stringify({ path: "/plugins/control", remote: "https://x/control.git", exactTag: "v1\u0001", headSha: "a".repeat(40) }),
    JSON.stringify({ path: "/plugins/short-head", remote: "https://x/short.git", exactTag: "", headSha: "a".repeat(39) }),
    JSON.stringify({ path: "/plugins/nonhex-head", remote: "https://x/nonhex.git", exactTag: "", headSha: "g".repeat(40) }),
    JSON.stringify({ path: "/plugins/hostile-head", remote: "https://x/hostile.git", exactTag: "", headSha: "a".repeat(39) + "\nforged" }),
    valid
  ]
  const map = Model.parseGitMap(records.join("\n"))
  assert.deepEqual(Object.keys(map), ["/plugins/a"])
})

test("parseGitMap keeps hostile delimiters inside one JSON record", () => {
  const path = "/plugins/real\n{\"path\":\"/plugins/path-forgery\"}"
  const remote = "git@github.com:owner/repo.git\n"
    + "/plugins/tsv-forgery\thttps://github.com/attacker/repo.git\tv9.9.9\n"
    + "{\"path\":\"/plugins/json-forgery\",\"remote\":\"https://github.com/attacker/repo\",\"exactTag\":\"v9.9.9\"}"
    + "\\quoted\"tail"
  const record = JSON.stringify({ path, remote, exactTag: "v1.0.3", headSha: "a".repeat(40) })
  const map = Model.parseGitMap(record)

  assert.deepEqual(Object.keys(map), [path])
  assert.deepEqual(map[path], { remote, exactTag: "v1.0.3", headSha: "a".repeat(40) })
  assert.equal(map["/plugins/path-forgery"], undefined)
  assert.equal(map["/plugins/tsv-forgery"], undefined)
  assert.equal(map["/plugins/json-forgery"], undefined)
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
const gitMap = {
  "/plugins/acme.weather": { remote: "https://example.com/weather.git", exactTag: "v2.0.1", headSha: "a".repeat(40) },
  "/plugins/acme.dev": { remote: "", exactTag: "", headSha: "b".repeat(64) }
}

test("mergePlugins strips markup out of everything a manifest supplied", () => {
  const rows = Model.mergePlugins(
    [{ id: "evil.one", name: '<img src="https://evil/n">', kinds: ["bar-widget"], enabled: true }],
    [{ id: "evil.one", sourceDir: "/plugins/evil.one", description: '<img src="https://evil/d">' }],
    {},
    { "evil.one": { author: '<img src="https://evil/a">', version: "<b>9</b>" } })
  const row = rows[0]
  for (const field of [row.name, row.description, row.author, row.localVersion]) {
    assert.ok(!/[<>]/.test(field), "left markup in: " + field)
  }
})

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
  assert.equal(weather.exactTag, "v2.0.1")
  assert.equal(weather.headSha, "a".repeat(40))

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

// A bar has no off, only a successor, so the shell reports canDisable: false
// for one. The row has to carry that or the panel offers a verb the CLI will
// refuse.
test("mergePlugins carries whether a plugin can be switched off", () => {
  const rows = Model.mergePlugins(
    [{ id: "a.bar", name: "Bar", kinds: ["bar"], enabled: true, canDisable: false },
     { id: "b.widget", name: "Widget", kinds: ["bar-widget"], enabled: true, canDisable: true }],
    [], {})
  assert.equal(rows.find(r => r.id === "a.bar").canDisable, false)
  assert.equal(rows.find(r => r.id === "b.widget").canDisable, true)
})

test("mergePlugins carries the author and version out of each manifest", () => {
  const meta = { "acme.weather": { author: "Acme Corp", version: "2.0.1" } }
  const rows = Model.mergePlugins(listEntries, catalogEntries, gitMap, meta)
  const weather = rows.find(r => r.id === "acme.weather")
  assert.equal(weather.author, "Acme Corp")
  assert.equal(weather.localVersion, "2.0.1")
  assert.equal(weather.exactTag, "v2.0.1")

  const dev = rows.find(r => r.id === "acme.dev")
  assert.equal(dev.author, "")
  assert.equal(dev.localVersion, "")
})

test("mergePlugins ignores entries with no id", () => {
  assert.deepEqual(Model.mergePlugins([null, {}, { name: "x" }], [], {}), [])
})

test("countRemovable counts only what lives in the user plugin directory", () => {
  assert.equal(Model.countRemovable(Model.mergePlugins(listEntries, catalogEntries, gitMap)), 2)
})

// ---- Enabling ------------------------------------------------------------

test("canEnable offers the action only to plugins that are off", () => {
  assert.equal(Model.canEnable({ id: "a.b", enabled: false, kinds: ["bar-widget"] }), true)
  assert.equal(Model.canEnable({ id: "a.b", enabled: true, kinds: ["bar-widget"] }), false)
  assert.equal(Model.canEnable(null), false)
})

// Disable takes a widget out of the bar and leaves the plugin on disk. It is
// the exact inverse of enable, and the only thing it cannot be applied to is a
// whole-bar plugin: a bar has no off, only a successor.
test("canDisable offers the action only to plugins that are on", () => {
  assert.equal(Model.canDisable({ id: "a.b", enabled: true, canDisable: true }), true)
  assert.equal(Model.canDisable({ id: "a.b", enabled: false, canDisable: true }), false)
  assert.equal(Model.canDisable({ id: "a.b", enabled: true, canDisable: false }), false)
  assert.equal(Model.canDisable(null), false)
})

test("disableCommand names the plugin and nothing else", () => {
  assert.deepEqual(Model.disableCommand({ id: "a.b" }), ["omarchy", "plugin", "disable", "a.b"])
  assert.deepEqual(Model.disableCommand({ id: "" }), [])
  assert.deepEqual(Model.disableCommand(null), [])
})

// Enabling or disabling a bar widget rewrites bar.layout, which makes the bar
// rebuild its widgets — this panel among them. The status line it would have
// written is destroyed before anyone reads it, so the outcome is announced
// where it survives.
test("enableNote says where the widget landed", () => {
  assert.equal(Model.enableNote("right"), "It has a place in the right section of the bar now.")
  assert.equal(Model.enableNote(""), "It is switched on now.")
  assert.equal(Model.enableNote("nonsense"), "It is switched on now.")
})

test("disableNote makes clear nothing was uninstalled", () => {
  assert.equal(Model.disableNote(), "It is off the bar, but still installed.")
})

test("the disable action reports in its own words", () => {
  assert.equal(Model.actionVerb("disable"), "Disable")
  assert.equal(Model.actionGerund("disable"), "Disabling")
  assert.equal(Model.successMessage("disable", "Active window"), "Disabled Active window")
})

test("needsPlacement asks where only for widgets that take a place in the bar", () => {
  assert.equal(Model.needsPlacement({ kinds: ["bar-widget"] }), true)
  assert.equal(Model.needsPlacement({ kinds: ["service", "bar-widget"] }), true)
  assert.equal(Model.needsPlacement({ kinds: ["service"] }), false)
  assert.equal(Model.needsPlacement({ kinds: ["overlay"] }), false)
  assert.equal(Model.needsPlacement(null), false)
})

// A whole-bar plugin replaces the bar rather than sitting in a section, and
// `omarchy plugin enable` fails outright if handed a placement for one.
test("needsPlacement refuses to place a plugin that IS the bar", () => {
  assert.equal(Model.needsPlacement({ kinds: ["bar"] }), false)
  assert.equal(Model.needsPlacement({ kinds: ["bar", "bar-widget"] }), false)
})

test("placementOptions offers the three sections the bar actually has", () => {
  assert.deepEqual(Model.placementOptions().map(o => o.value), ["left", "center", "right"])
})

test("enableCommand passes the section only when one was chosen", () => {
  assert.deepEqual(
    Model.enableCommand({ id: "a.b", kinds: ["bar-widget"] }, "right"),
    ["omarchy", "plugin", "enable", "a.b", "right"])
  assert.deepEqual(
    Model.enableCommand({ id: "a.b", kinds: ["service"] }, ""),
    ["omarchy", "plugin", "enable", "a.b"])
})

// The section is what the user picked from a fixed list, never free text —
// but this builds an argv array that reaches a CLI, so it is checked here too
// rather than trusted because the UI happens to be a set of buttons today.
test("enableCommand drops a section that is not one of the three", () => {
  assert.deepEqual(
    Model.enableCommand({ id: "a.b", kinds: ["bar-widget"] }, "--yes"),
    ["omarchy", "plugin", "enable", "a.b"])
  assert.deepEqual(
    Model.enableCommand({ id: "a.b", kinds: ["bar-widget"] }, "Right"),
    ["omarchy", "plugin", "enable", "a.b"])
})

test("enableCommand refuses a row with no id", () => {
  assert.deepEqual(Model.enableCommand(null, "left"), [])
  assert.deepEqual(Model.enableCommand({ id: "" }, "left"), [])
})

test("the enable action reports failure in its own words", () => {
  assert.equal(Model.actionVerb("enable"), "Enable")
  assert.equal(Model.actionGerund("enable"), "Enabling")
})

// The placement question outlives the list underneath it: a background reload
// can land while the dialog is open, and answering must not enable whatever
// now happens to sit at that position.
test("findRow looks a plugin up by id rather than by position", () => {
  const rows = [{ id: "a.b" }, { id: "c.d" }]
  assert.equal(Model.findRow(rows, "c.d").id, "c.d")
  assert.equal(Model.findRow(rows, "gone"), null)
  assert.equal(Model.findRow(rows, ""), null)
  assert.equal(Model.findRow(null, "a.b"), null)
})

// The panel is a plugin, and cloning one into ~/.config/omarchy/plugins makes
// the shell tear every plugin widget down and rebuild it — this panel with
// them. So anything that has to be asked about an install must be asked BEFORE
// the install starts, which means reading the kind off the registry listing
// rather than off the manifest that does not exist yet.
test("catalogNeedsPlacement reads the registry's own words for the kind", () => {
  assert.equal(Model.catalogNeedsPlacement({ kind: "Bar widget" }), true)
  assert.equal(Model.catalogNeedsPlacement({ kind: "Service + Bar widget" }), true)
  assert.equal(Model.catalogNeedsPlacement({ kind: "Menu + Bar widget" }), true)
})

// "Bar" is a whole-bar replacement, and it is a prefix of "Bar widget" — so
// this has to match the phrase, not the word.
test("catalogNeedsPlacement does not place a plugin that IS the bar", () => {
  assert.equal(Model.catalogNeedsPlacement({ kind: "Bar" }), false)
})

test("catalogNeedsPlacement stays quiet about kinds it cannot vouch for", () => {
  assert.equal(Model.catalogNeedsPlacement({ kind: "Service" }), false)
  assert.equal(Model.catalogNeedsPlacement({ kind: "Overlay" }), false)
  assert.equal(Model.catalogNeedsPlacement({ kind: "Suite" }), false)
  assert.equal(Model.catalogNeedsPlacement({ kind: "" }), false)
  assert.equal(Model.catalogNeedsPlacement(null), false)
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

test("mergePlugins tags each row with the section it belongs to", () => {
  const rows = Model.mergePlugins(listEntries, catalogEntries, gitMap)
  assert.equal(rows.find(r => r.id === "omarchy.clock").group, "built-in")
  assert.equal(rows.find(r => r.id === "acme.weather").group, "installed")
})

test("rowsInGroup slices the flat list without reordering it", () => {
  const rows = Model.mergePlugins(listEntries, catalogEntries, gitMap)
  const installed = Model.rowsInGroup(rows, "installed")
  const builtin = Model.rowsInGroup(rows, "built-in")

  assert.deepEqual(installed.map(r => r.id), ["acme.dev", "acme.weather"])
  assert.deepEqual(builtin.map(r => r.id), ["omarchy.clock"])

  // The two slices must rejoin into the original order, because one flat
  // selection index addresses both sections.
  assert.deepEqual([...installed, ...builtin].map(r => r.id), rows.map(r => r.id))
})

test("sectionHeading counts what is actually on screen", () => {
  const rows = Model.mergePlugins(listEntries, catalogEntries, gitMap)
  assert.equal(Model.sectionHeading(rows, "installed"), "INSTALLED  ·  2")
  assert.equal(Model.sectionHeading(rows, "built-in"), "BUILT-IN  ·  1")
  assert.equal(Model.sectionHeading(Model.filterByKind(rows, "service"), "installed"), "INSTALLED  ·  1")
})

test("kindOptions is derived from installed plugins, not a fixed list", () => {
  const rows = Model.mergePlugins(listEntries, catalogEntries, gitMap)
  assert.deepEqual(Model.kindOptions(rows), [
    { value: "all", label: "All" },
    { value: "bar-widget", label: "Bar-widget" },
    { value: "service", label: "Service" }
  ])
})

test("kindOptions gives an unknown kind a chip rather than hiding it", () => {
  const rows = Model.mergePlugins(
    [{ id: "a.b", name: "B", kinds: ["hologram"], firstParty: false }], [], {})
  assert.deepEqual(Model.kindOptions(rows).map(o => o.value), ["all", "hologram"])
  assert.equal(Model.kindLabel("hologram"), "hologram")
})

test("the bar and widget chips are merged into one that covers both kinds", () => {
  const rows = Model.mergePlugins([
    { id: "a.whole", name: "Whole", kinds: ["bar"], firstParty: false },
    { id: "a.mounted", name: "Mounted", kinds: ["bar-widget"], firstParty: false },
    { id: "a.daemon", name: "Daemon", kinds: ["service"], firstParty: false }
  ], [], {})

  assert.deepEqual(Model.kindOptions(rows), [
    { value: "all", label: "All" },
    { value: "bar-widget", label: "Bar-widget" },
    { value: "service", label: "Service" }
  ])

  assert.deepEqual(
    Model.filterByKind(rows, "bar-widget").map(r => r.id),
    ["a.mounted", "a.whole"])
})

test("the merged chip is reachable by either kind it covers", () => {
  const rows = Model.mergePlugins(
    [{ id: "a.whole", name: "Whole", kinds: ["bar"], firstParty: false }], [], {})
  assert.equal(Model.filterByKind(rows, "bar").length, 1)
  assert.equal(Model.filterKind("bar"), "bar-widget")
  assert.equal(Model.filterKind("service"), "service")
})

test("rows still name their own kind — merging is a filter concern only", () => {
  assert.equal(Model.kindLabel("bar"), "Bar")
  assert.equal(Model.kindLabel("bar-widget"), "Widget")
  assert.equal(Model.filterKindLabel("bar-widget"), "Bar-widget")
  assert.equal(Model.filterKindLabel("service"), "Service")
})

test("filterByKind keeps plugins that declare the kind among several", () => {
  const rows = Model.mergePlugins(
    [{ id: "a.b", name: "B", kinds: ["service", "bar-widget"], firstParty: false }], [], {})
  assert.equal(Model.filterByKind(rows, "service").length, 1)
  assert.equal(Model.filterByKind(rows, "bar-widget").length, 1)
  assert.equal(Model.filterByKind(rows, "panel").length, 0)
  assert.equal(Model.filterByKind(rows, "all").length, 1)
  assert.equal(Model.filterByKind(rows, "").length, 1)
})

test("nextKind wraps so the cycle key never dead-ends", () => {
  const options = [{ value: "all" }, { value: "bar-widget" }, { value: "service" }]
  assert.equal(Model.nextKind(options, "all"), "bar-widget")
  assert.equal(Model.nextKind(options, "service"), "all")
  assert.equal(Model.nextKind(options, "gone"), "all")
  assert.equal(Model.nextKind([], "all"), "all")
})

test("metaLine pairs the author with readable kind labels", () => {
  assert.equal(Model.metaLine({ id: "a.b", author: "Ada", kinds: [] }), "Ada  ·  no kind")
  assert.equal(Model.metaLine({ id: "a.b", author: "Ada", kinds: ["bar-widget", "service"] }), "Ada  ·  Widget · Service")
})

// A manifest with no author still names its namespace in the id, and that
// namespace is the handle the plugin was published under.
test("metaLine falls back to the id namespace when no author is declared", () => {
  assert.equal(Model.metaLine({ id: "agx.screen-time", kinds: ["bar-widget"] }), "agx  ·  Widget")
})

test("metaLine drops the author segment when nothing names one", () => {
  assert.equal(Model.metaLine({ id: "ghost", kinds: ["service"] }), "Service")
})

test("authorLabel prefers the manifest author over the id namespace", () => {
  assert.equal(Model.authorLabel({ id: "agx.screen-time", author: "  agx  " }), "agx")
  assert.equal(Model.authorLabel({ id: "agx.screen-time" }), "agx")
  assert.equal(Model.authorLabel({ id: "ghost" }), "")
  assert.equal(Model.authorLabel(null), "")
})

test("descriptionLine says a missing description is the manifest's doing", () => {
  assert.equal(Model.descriptionLine({ description: "Does a thing" }), "Does a thing")
  assert.match(Model.descriptionLine({ description: "   " }), /manifest/)
  assert.match(Model.descriptionLine({}), /manifest/)
  assert.equal(Model.hasDescription({ description: "Does a thing" }), true)
  assert.equal(Model.hasDescription({ description: "  " }), false)
})

test("sourceBadge stays silent for built-ins, whose section already said it", () => {
  const rows = Model.mergePlugins(listEntries, catalogEntries, gitMap)
  assert.equal(Model.sourceBadge(rows.find(r => r.id === "omarchy.clock")), "")
  assert.equal(Model.sourceBadge(rows.find(r => r.id === "acme.weather")), "git")
  assert.equal(Model.sourceBadge(rows.find(r => r.id === "acme.dev")), "git")
  assert.equal(Model.sourceBadge({ firstParty: false, gitManaged: false }), "local")
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

// Adding no longer enables — placement is a separate, asked-for step — so the
// message must not claim the plugin is running.
test("successMessage reports an add as added, not as live", () => {
  assert.equal(Model.successMessage("add", "omarchy-clock"), "Added omarchy-clock")
})

test("matchesQuery searches name and id, case-insensitively", () => {
  const row = { name: "Hardware Tooltip", id: "im0001gt.hw-tooltip", description: "Names your CPU and GPU" }
  assert.equal(Model.matchesQuery(row, "hardware"), true)
  assert.equal(Model.matchesQuery(row, "TOOLTIP"), true)
  assert.equal(Model.matchesQuery(row, "im0001gt"), true)
  assert.equal(Model.matchesQuery(row, "hw-tool"), true)
  assert.equal(Model.matchesQuery(row, "  tooltip  "), true)
})

test("matchesQuery does not search descriptions", () => {
  // A search that matched prose would surface plugins whose names look
  // nothing like what was typed, which reads as a bug rather than a feature.
  const row = { name: "Hardware Tooltip", id: "im0001gt.hw-tooltip", description: "Names your CPU and GPU" }
  assert.equal(Model.matchesQuery(row, "GPU"), false)
})

test("an empty query matches everything, including a whitespace-only one", () => {
  const row = { name: "A", id: "b.c" }
  assert.equal(Model.matchesQuery(row, ""), true)
  assert.equal(Model.matchesQuery(row, "   "), true)
  assert.equal(Model.matchesQuery(row, null), true)
})

test("statusOptions exposes All, Enabled, Disabled, and Update", () => {
  assert.deepEqual(Model.statusOptions(), [
    { value: "all", label: "All" },
    { value: "enabled", label: "Enabled" },
    { value: "disabled", label: "Disabled" },
    { value: "update", label: "Update" }
  ])
})

test("filterRows applies status, kind, and search together", () => {
  const rows = Model.mergePlugins(listEntries, catalogEntries, gitMap)
  const checkedRows = rows.map(row => ({ ...row, behind: row.id === "acme.weather" }))

  assert.deepEqual(Model.filterRows(rows, "all", "all", "").map(r => r.id), ["acme.dev", "acme.weather", "omarchy.clock"])
  assert.deepEqual(Model.filterRows(rows, "all", "enabled", "").map(r => r.id), ["acme.weather", "omarchy.clock"])
  assert.deepEqual(Model.filterRows(rows, "all", "disabled", "").map(r => r.id), ["acme.dev"])
  assert.deepEqual(Model.filterRows(rows, "all", "enabled", "acme").map(r => r.id), ["acme.weather"])
  assert.deepEqual(Model.filterRows(rows, "bar-widget", "enabled", "acme").map(r => r.id), ["acme.weather"])
  assert.deepEqual(Model.filterRows(rows, "service", "disabled", "dev").map(r => r.id), ["acme.dev"])
  assert.deepEqual(Model.filterRows(rows, "service", "enabled", "weather").map(r => r.id), [])
  assert.deepEqual(Model.filterRows(checkedRows, "all", "update", "").map(r => r.id), ["acme.weather"])
  assert.deepEqual(Model.filterRows(checkedRows, "bar-widget", "update", "weather").map(r => r.id), ["acme.weather"])
  assert.deepEqual(Model.filterRows(checkedRows, "service", "update", "weather").map(r => r.id), [])
})

test("status filtering preserves both section classes and their flat selection order", () => {
  const rows = Model.mergePlugins([
    { id: "z.installed-on", name: "Zed", kinds: ["service"], enabled: true, firstParty: false },
    { id: "a.installed-off", name: "Alpha", kinds: ["service"], enabled: false, firstParty: false },
    { id: "z.builtin-on", name: "Zulu", kinds: ["service"], enabled: true, firstParty: true },
    { id: "a.builtin-off", name: "Able", kinds: ["service"], enabled: false, firstParty: true }
  ], [], {}).map(row => ({
    ...row,
    behind: row.id === "a.installed-off" || row.id === "z.builtin-on"
  }))
  const filtered = Model.filterRows(rows, "service", "disabled", "a")
  const rejoined = [...Model.rowsInGroup(filtered, "installed"), ...Model.rowsInGroup(filtered, "built-in")]
  const updates = Model.filterRows(rows, "service", "update", "")
  const rejoinedUpdates = [...Model.rowsInGroup(updates, "installed"), ...Model.rowsInGroup(updates, "built-in")]

  assert.deepEqual(Model.filterByStatus(rows, "all").map(r => r.id), rows.map(r => r.id))
  assert.deepEqual(rejoined.map(r => r.id), ["a.installed-off", "a.builtin-off"])
  assert.deepEqual(rejoined.map(r => r.group), ["installed", "built-in"])
  assert.deepEqual(rejoined.map(r => r.id), filtered.map(r => r.id))
  assert.deepEqual(rejoinedUpdates.map(r => r.id), ["a.installed-off", "z.builtin-on"])
  assert.deepEqual(rejoinedUpdates.map(r => r.id), updates.map(r => r.id))
})

test("groupOptions offers the two sections plus All, in section order", () => {
  assert.deepEqual(Model.groupOptions(), [
    { value: "all", label: "All" },
    { value: "installed", label: "Installed" },
    { value: "built-in", label: "Built-in" }
  ])
})

test("filterRows narrows by group alongside kind, status, and search", () => {
  const rows = [
    { id: "acme.dev", name: "Dev", kinds: ["service"], enabled: false, group: "installed" },
    { id: "acme.weather", name: "Weather", kinds: ["bar-widget"], enabled: true, group: "installed" },
    { id: "omarchy.clock", name: "Clock", kinds: ["bar-widget"], enabled: true, group: "built-in" }
  ]
  assert.deepEqual(Model.filterRows(rows, "all", "all", "", "all").map(r => r.id), ["acme.dev", "acme.weather", "omarchy.clock"])
  assert.deepEqual(Model.filterRows(rows, "all", "all", "").map(r => r.id), ["acme.dev", "acme.weather", "omarchy.clock"])
  assert.deepEqual(Model.filterRows(rows, "all", "all", "", "installed").map(r => r.id), ["acme.dev", "acme.weather"])
  assert.deepEqual(Model.filterRows(rows, "all", "all", "", "built-in").map(r => r.id), ["omarchy.clock"])
  assert.deepEqual(Model.filterRows(rows, "bar-widget", "enabled", "", "installed").map(r => r.id), ["acme.weather"])
  assert.deepEqual(Model.filterRows(rows, "all", "all", "clock", "installed").map(r => r.id), [])
  assert.deepEqual(Model.filterRows(rows, "all", "all", "", "nonsense").map(r => r.id), [])
})

test("isFiltering and emptyMessage account for the group filter", () => {
  assert.equal(Model.isFiltering("all", "all", "", "all"), false)
  assert.equal(Model.isFiltering("all", "all", ""), false)
  assert.equal(Model.isFiltering("all", "all", "", "installed"), true)
  assert.equal(Model.isFiltering("all", "all", "", "built-in"), true)

  assert.equal(Model.emptyMessage("all", "all", "", "built-in"), "No built-in plugins found.")
  assert.equal(Model.emptyMessage("all", "all", "zzz", "installed"), "No installed plugins match “zzz”.")
  assert.equal(Model.emptyMessage("service", "disabled", "", "built-in"), "No disabled built-in service plugins found.")
  assert.equal(Model.emptyMessage("all", "update", "", "installed"), "No confirmed installed plugin updates found.")
  assert.equal(Model.emptyMessage("service", "update", "zzz", "built-in"), "No confirmed built-in service plugin updates match “zzz”.")
  assert.equal(Model.emptyMessage("all", "all", "", "all"), "No plugins found.")
})

test("isFiltering includes status and clears only when all controls are neutral", () => {
  assert.equal(Model.isFiltering("all", "all", ""), false)
  assert.equal(Model.isFiltering("all", "all", "   "), false)
  assert.equal(Model.isFiltering("service", "all", ""), true)
  assert.equal(Model.isFiltering("all", "enabled", ""), true)
  assert.equal(Model.isFiltering("all", "disabled", ""), true)
  assert.equal(Model.isFiltering("all", "update", ""), true)
  assert.equal(Model.isFiltering("all", "all", "clock"), true)
})

test("emptyMessage names every active exclusion, including status", () => {
  assert.equal(Model.emptyMessage("all", "all", "zzz"), "No plugins match “zzz”.")
  assert.equal(Model.emptyMessage("service", "all", "zzz"), "No service plugins match “zzz”.")
  assert.equal(Model.emptyMessage("all", "disabled", "zzz"), "No disabled plugins match “zzz”.")
  assert.equal(Model.emptyMessage("service", "disabled", "zzz"), "No disabled service plugins match “zzz”.")
  assert.equal(Model.emptyMessage("service", "enabled", ""), "No enabled service plugins found.")
  assert.equal(Model.emptyMessage("all", "disabled", ""), "No disabled plugins found.")
  assert.equal(Model.emptyMessage("all", "update", "zzz"), "No confirmed plugin updates match “zzz”.")
  assert.equal(Model.emptyMessage("service", "update", "zzz"), "No confirmed service plugin updates match “zzz”.")
  assert.equal(Model.emptyMessage("service", "update", ""), "No confirmed service plugin updates found.")
  assert.equal(Model.emptyMessage("all", "update", ""), "No confirmed updates found.")
  assert.equal(Model.emptyMessage("bar-widget", "all", ""), "No bar-widget plugins found.")
  assert.equal(Model.emptyMessage("all", "all", ""), "No plugins found.")
})

// ---- Marketplace catalog ---------------------------------------------------

const catalogDoc = {
  generatedAt: "2026-08-20T21:33:17.660Z",
  plugins: [
    {
      id: "acme.weather", name: "Weather", description: "Forecast in the bar",
      author: "acme", version: "v1.2.3", category: "Widgets", kind: "Bar widget",
      repo: "https://github.com/acme/omarchy-weather",
      installCommand: "omarchy plugin add https://github.com/acme/omarchy-weather.git --enable",
      installAvailable: true, verificationStatus: "verified", sourceType: "community",
      stars: 120, marketplaceHearts: 7, addedAt: "2026-08-19",
      listedAt: "2026-08-19T14:30:00.000Z",
      accent: "cyan", initials: "WE", previewThumbnail: "assets/img/w-card.webp"
    },
    {
      id: "acme.suite", name: "Suite", description: "A whole shell",
      author: "acme", version: "", category: "Desktop", kind: "Suite",
      repo: "https://github.com/acme/suite", installCommand: "",
      installAvailable: false, installNote: "This repository has its own installer.",
      verificationStatus: "unverified", sourceType: "community",
      stars: 9, marketplaceHearts: 0, accent: "violet", initials: "SU"
    },
    {
      id: "omarchy.clock", name: "Clock", description: "Built in",
      category: "Widgets", installAvailable: true, sourceType: "builtin",
      repo: "https://github.com/omarchy/omarchy", stars: 999, initials: "CL"
    }
  ]
}

test("parseCatalog rejects anything that is not a plugin document", () => {
  assert.equal(Model.parseCatalog("not json"), null)
  assert.equal(Model.parseCatalog('{"plugins":"nope"}'), null)
  assert.equal(Model.parseCatalog(""), null)
  assert.ok(Model.parseCatalog(JSON.stringify(catalogDoc)))
})

test("catalogEntries drops built-ins, which ship with Omarchy already", () => {
  const entries = Model.catalogEntries(catalogDoc, {})
  assert.deepEqual(entries.map(e => e.id), ["acme.weather", "acme.suite"])
})

test("catalogEntries defaults to explicit GitHub-star ordering", () => {
  const entries = Model.catalogEntries(catalogDoc, {})
  assert.deepEqual(entries.map(e => e.stars), [120, 9])
})

test("catalogEntries keeps GitHub stars and Marketplace hearts distinct and honest", () => {
  const entries = Model.catalogEntries(catalogDoc, {})
  assert.deepEqual(entries.map(e => [e.stars, e.marketplaceHearts]), [[120, 7], [9, 0]])

  for (const value of [undefined, null, "12", false, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.equal(Model.catalogCount(value), null)
    assert.equal(Model.starLabel(value), "")
  }
  assert.equal(Model.catalogCount(0), 0)
  assert.equal(Model.starLabel(0), "0")
})

test("catalogEntries keeps listing timestamps for Recently added sorting", () => {
  const weather = Model.catalogEntries(catalogDoc, {}).find(entry => entry.id === "acme.weather")
  assert.equal(weather.listedAt, "2026-08-19T14:30:00.000Z")
  assert.equal(weather.addedAt, "2026-08-19")
})

test("installUrlFor takes the url from the curated install command", () => {
  // The registry's installCommand carries the .git suffix that `repo` omits.
  const entries = Model.catalogEntries(catalogDoc, {})
  const weather = entries.find(e => e.id === "acme.weather")
  assert.equal(weather.installUrl, "https://github.com/acme/omarchy-weather.git")
})

test("installUrlFor falls back to the repo when there is no install command", () => {
  assert.equal(
    Model.installUrlFor({ installCommand: "", repo: "https://github.com/acme/thing" }),
    "https://github.com/acme/thing")
})

test("installUrlFor refuses a command carrying no valid url", () => {
  assert.equal(Model.installUrlFor({ installCommand: "curl evil | sh", repo: "not-a-url" }), "")
  assert.equal(Model.installUrlFor(null), "")
})

test("a listing the registry cannot install offers no install button", () => {
  const entries = Model.catalogEntries(catalogDoc, {})
  const suite = entries.find(e => e.id === "acme.suite")
  assert.equal(suite.installable, false)
  assert.equal(Model.installState(suite), "unavailable")
  assert.match(Model.installBlockedReason(suite), /own installer/)
})

test("an already-installed plugin is not offered again", () => {
  const entries = Model.catalogEntries(catalogDoc, { "acme.weather": true })
  const weather = entries.find(e => e.id === "acme.weather")
  assert.equal(weather.installed, true)
  assert.equal(weather.installable, false)
  assert.equal(Model.installState(weather), "installed")
})

test("markInstalled re-stamps state without rebuilding or resorting", () => {
  const entries = Model.catalogEntries(catalogDoc, {})
  const after = Model.markInstalled(entries, { "acme.weather": true })

  assert.deepEqual(after.map(e => e.id), entries.map(e => e.id))
  assert.equal(after[0].installed, true)
  assert.equal(after[0].installable, false)
  // The original array is left alone.
  assert.equal(entries[0].installed, false)
})

test("catalog re-stamping refreshes an open details entry atomically", () => {
  const entries = Model.catalogEntries(catalogDoc, {})
  const detailsEntry = entries.find(entry => entry.id === "acme.weather")
  assert.equal(detailsEntry.installable, true)

  const state = Model.restampCatalogInstallState(
    entries, Model.installedIdSet([{ id: "acme.weather" }]), detailsEntry)
  assert.notEqual(state.detailsEntry, detailsEntry)
  assert.equal(state.detailsEntry.installed, true)
  assert.equal(state.detailsEntry.installable, false)
  assert.equal(Model.installState(state.detailsEntry), "installed")
  assert.equal(state.detailsEntry, state.entries.find(entry => entry.id === "acme.weather"))
})

test("installedIdSet indexes the installed rows by id", () => {
  const set = Model.installedIdSet([{ id: "a.b" }, { id: "c.d" }, null])
  assert.ok(Object.prototype.hasOwnProperty.call(set, "a.b"))
  assert.ok(Object.prototype.hasOwnProperty.call(set, "c.d"))
  assert.equal(Object.keys(set).length, 2)
})

test("installed membership is collision-safe for valid hostile property names", () => {
  const hostileIds = ["hasOwnProperty", "constructor", "__proto__"]
  const installed = Model.installedIdSet(hostileIds.map(id => ({ id })))
  assert.equal(Object.getPrototypeOf(installed), null)
  for (const id of hostileIds)
    assert.equal(Object.prototype.hasOwnProperty.call(installed, id), true)

  const doc = {
    plugins: hostileIds.map((id, index) => ({
      id, name: id, kind: "Panel", category: "Tools", sourceType: "community",
      repo: `https://github.com/acme/plugin-${index}`,
      installAvailable: true
    }))
  }
  const entries = Model.catalogEntries(doc, installed)
  assert.equal(entries.length, hostileIds.length)
  assert.ok(entries.every(entry => entry.installed && !entry.installable))
  assert.ok(Model.markInstalled(entries, installed).every(entry => entry.installed))

  // Inherited Object properties are never membership evidence.
  assert.ok(Model.catalogEntries(doc, {}).every(entry => !entry.installed))
})

test("catalog search covers author and description, unlike the installed search", () => {
  // Browsing is how you find something you cannot already name.
  const entry = { name: "Weather", id: "acme.weather", author: "acme", description: "Forecast in the bar" }
  assert.equal(Model.matchesCatalogQuery(entry, "forecast"), true)
  assert.equal(Model.matchesCatalogQuery(entry, "acme"), true)
  assert.equal(Model.matchesCatalogQuery(entry, "zzz"), false)
})

test("filterCatalog composes query, category, kind, and availability", () => {
  const entries = Model.catalogEntries(catalogDoc, {})
  const installed = Model.markInstalled(entries, { "acme.weather": true })

  assert.equal(Model.filterCatalog(installed, "all", "all", "all", "").length, 2)
  assert.deepEqual(
    Model.filterCatalog(installed, "Widgets", "Bar widget", "installed", "forecast").map(e => e.id),
    ["acme.weather"])
  assert.equal(Model.filterCatalog(installed, "Widgets", "Suite", "installed", "").length, 0)
  assert.deepEqual(
    Model.filterCatalog(entries, "Desktop", "Suite", "all", "acme").map(e => e.id),
    ["acme.suite"])
  // Available follows the existing installability policy; blocked listings
  // remain visible under All but are not presented as available to install.
  assert.deepEqual(
    Model.filterCatalog(entries, "all", "all", "available", "").map(e => e.id),
    ["acme.weather"])
})

test("catalogCategories is derived from the catalog and led by All", () => {
  const entries = Model.catalogEntries(catalogDoc, {})
  assert.deepEqual(Model.catalogCategories(entries).map(o => o.value), ["all", "Desktop", "Widgets"])
})

test("missing category groups under Other without becoming details metadata", () => {
  const entries = Model.catalogEntries({ plugins: [
    { id: "missing", name: "Missing", kind: "Panel", sourceType: "community" },
    { id: "present", name: "Present", category: "Other", kind: "Panel", sourceType: "community" }
  ] }, {})
  const missing = entries.find(entry => entry.id === "missing")
  const present = entries.find(entry => entry.id === "present")
  assert.equal(missing.category, "Other")
  assert.equal(missing.categoryPresent, false)
  assert.equal(present.category, "Other")
  assert.equal(present.categoryPresent, true)
  assert.deepEqual(Model.catalogCategories(entries).map(option => option.value), ["all", "Other"])
})

test("Browse options are derived from catalog kinds and keep fixed policy labels", () => {
  const entries = Model.catalogEntries(catalogDoc, {})
  assert.deepEqual(Model.catalogKindOptions(entries), [
    { value: "all", label: "All" },
    { value: "bar widget", label: "Bar widget" },
    { value: "suite", label: "Suite" }
  ])
  assert.deepEqual(Model.catalogKindOptions([
    { kind: "Panel" }, { kind: "panel" }, { kind: "" }, {}, null
  ]), [
    { value: "all", label: "All" },
    { value: "panel", label: "Panel" }
  ])
  assert.deepEqual(Model.catalogAvailabilityOptions().map(o => o.label), ["All", "Available", "Installed"])
})

test("Browse sort options put Recently added first", () => {
  assert.deepEqual(Model.catalogSortOptions(), [
    { value: "recently-added", label: "Recently added" },
    { value: "stars", label: "GitHub stars" },
    { value: "hearts", label: "Hearts" },
    { value: "name", label: "Name" }
  ])
})

test("Browse sort dropdown defaults to Recently added", () => {
  const panel = readFileSync(new URL("../Panel.qml", import.meta.url), "utf8")
  assert.match(panel, /^  property string catalogSort: "recently-added"$/m)
  assert.match(panel, /^                value: root\.catalogSort$/m)
})

test("catalog kind filtering uses the same case-insensitive key as its option", () => {
  const entries = [
    { id: "upper", kind: "Panel", name: "Upper", author: "", description: "", category: "Tools" },
    { id: "lower", kind: "panel", name: "Lower", author: "", description: "", category: "Tools" }
  ]
  assert.equal(Model.catalogKindKey(" Panel "), "panel")
  assert.deepEqual(Model.catalogKindOptions(entries), [
    { value: "all", label: "All" },
    { value: "panel", label: "Panel" }
  ])
  assert.deepEqual(
    Model.filterCatalog(entries, "all", "panel", "all", "").map(entry => entry.id).sort(),
    ["lower", "upper"])
})

test("modal focus ownership prioritizes successors and restores the list only when clear", () => {
  assert.equal(Model.browseModalFocusOwner(false, false, false), "list")
  assert.equal(Model.browseModalFocusOwner(true, false, false), "details")
  assert.equal(Model.browseModalFocusOwner(true, true, false), "confirmation")
  assert.equal(Model.browseModalFocusOwner(false, true, true), "placement")
  assert.equal(Model.browseModalFocusOwner(true, true, true), "placement")
})

test("install confirmation describes placement before cloning only when required", () => {
  assert.equal(Model.catalogPlacementConfirmationNote(false), "")
  assert.equal(
    Model.catalogPlacementConfirmationNote(true),
    "\n\nNext, choose its bar section. Cloning starts only after that choice.")
})

test("Browse sorting keeps stars and hearts independent with deterministic tie-breakers", () => {
  const entries = [
    { id: "z.same", name: "Same", stars: 10, marketplaceHearts: 2 },
    { id: "A.same", name: "same", stars: 10, marketplaceHearts: 5 },
    { id: "b.beta", name: "Beta", stars: null, marketplaceHearts: 5 },
    { id: "c.alpha", name: "alpha", stars: 1, marketplaceHearts: null }
  ]

  assert.deepEqual(Model.sortCatalog(entries, "stars").map(e => e.id),
    ["A.same", "z.same", "c.alpha", "b.beta"])
  assert.deepEqual(Model.sortCatalog(entries, "hearts").map(e => e.id),
    ["b.beta", "A.same", "z.same", "c.alpha"])
  assert.deepEqual(Model.sortCatalog(entries, "name").map(e => e.id),
    ["c.alpha", "b.beta", "A.same", "z.same"])
  assert.deepEqual(entries.map(e => e.id), ["z.same", "A.same", "b.beta", "c.alpha"])
})

test("Browse sorting is stable for exact missing-metadata ties", () => {
  const entries = [
    { id: "same", name: "Same", stars: null, marketplaceHearts: null, marker: 1 },
    { id: "same", name: "Same", stars: null, marketplaceHearts: null, marker: 2 }
  ]
  assert.deepEqual(Model.sortCatalog(entries, "stars").map(e => e.marker), [1, 2])
  assert.deepEqual(Model.sortCatalog(entries, "hearts").map(e => e.marker), [1, 2])
})

test("Recently added sorts precise listing timestamps newest first", () => {
  const entries = [
    { id: "old", name: "Old", listedAt: "2026-08-20T08:15:00.000Z" },
    { id: "new", name: "New", listedAt: "2026-08-20T16:45:00.000Z" }
  ]
  assert.deepEqual(Model.sortCatalog(entries, "recently-added").map(e => e.id), ["new", "old"])
})

test("Recently added prefers listedAt and falls back to addedAt when needed", () => {
  const entries = [
    { id: "listed", name: "Listed", listedAt: "2026-08-02T10:00:00Z", addedAt: "2026-08-31" },
    { id: "missing-listed", name: "Missing", listedAt: "", addedAt: "2026-08-03" },
    { id: "invalid-listed", name: "Invalid", listedAt: "not-a-date", addedAt: "2026-08-01" }
  ]
  assert.deepEqual(Model.sortCatalog(entries, "recently-added").map(e => e.id),
    ["missing-listed", "listed", "invalid-listed"])
})

test("Recently added puts invalid and missing timestamps after valid timestamps", () => {
  const entries = [
    { id: "invalid", name: "Zulu", listedAt: "not-a-date", addedAt: "also-not-a-date" },
    { id: "valid", name: "Middle", listedAt: "2026-08-01T00:00:00Z" },
    { id: "missing", name: "Alpha" }
  ]
  assert.deepEqual(Model.sortCatalog(entries, "recently-added").map(e => e.id),
    ["valid", "missing", "invalid"])
})

test("Recently added uses the existing text tie-breaker for equal timestamps", () => {
  const entries = [
    { id: "z.same", name: "Same", listedAt: "2026-08-01T00:00:00Z" },
    { id: "A.same", name: "same", listedAt: "2026-08-01T00:00:00Z" },
    { id: "beta", name: "Beta", listedAt: "2026-08-01T00:00:00Z" }
  ]
  assert.deepEqual(Model.sortCatalog(entries, "recently-added").map(e => e.id),
    ["beta", "A.same", "z.same"])
})

test("Recently added normalizes catalog-scale timestamps at most once per entry", () => {
  const entries = []
  for (let i = 0; i < 1203; i++) {
    entries.push({
      id: `listed-${i}`,
      name: `Listed ${String(i).padStart(4, "0")}`,
      listedAt: new Date(Date.UTC(2026, 0, 1, 0, i)).toISOString(),
      addedAt: "2024-01-01"
    })
  }
  for (let i = 0; i < 36; i++) {
    entries.push({
      id: `fallback-${i}`,
      name: `Fallback ${String(i).padStart(2, "0")}`,
      listedAt: i < 18 ? "   " : (i < 27 ? "not-a-date" : "2026-02-30T12:00:00Z"),
      addedAt: new Date(Date.UTC(2025, 0, i + 1)).toISOString().slice(0, 10)
    })
  }
  entries.reverse()

  const originalParse = Date.parse
  let parseCalls = 0
  Date.parse = value => {
    parseCalls++
    return originalParse(value)
  }
  try {
    const sorted = Model.sortCatalog(entries, "recently-added")
    assert.equal(parseCalls, entries.length,
      "normalization should parse at most once per entry")
    assert.equal(sorted[0].id, "listed-1202")
    assert.equal(sorted[1202].id, "listed-0")
    assert.equal(sorted[1203].id, "fallback-35")
    assert.equal(sorted[1238].id, "fallback-0")
  } finally {
    Date.parse = originalParse
  }
})

test("Browse active-filter detection and clear state cover every narrowing control", () => {
  assert.equal(Model.catalogIsFiltering("all", "all", "all", ""), false)
  assert.equal(Model.catalogIsFiltering("Widgets", "all", "all", ""), true)
  assert.equal(Model.catalogIsFiltering("all", "Panel", "all", ""), true)
  assert.equal(Model.catalogIsFiltering("all", "all", "available", ""), true)
  assert.equal(Model.catalogIsFiltering("all", "all", "installed", ""), true)
  assert.equal(Model.catalogIsFiltering("all", "all", "all", " weather "), true)
  assert.deepEqual(Model.clearedCatalogFilters(), {
    category: "all", kind: "all", availability: "all", query: ""
  })
})

test("catalogEmptyMessage names what excluded everything", () => {
  assert.match(Model.catalogEmptyMessage("all", "all", "all", "zzz"), /No plugins match “zzz”/)
  assert.match(Model.catalogEmptyMessage("Widgets", "all", "available", "zzz"), /selected filters/)
  assert.match(Model.catalogEmptyMessage("Widgets", "all", "all", ""), /selected filters/)
})

test("starLabel keeps big counts short", () => {
  assert.equal(Model.starLabel(0), "0")
  assert.equal(Model.starLabel(999), "999")
  assert.equal(Model.starLabel(1200), "1.2k")
  assert.equal(Model.starLabel(undefined), "")
})

// Omarchy themes define foreground, background, accent, urgent and muted —
// there is no success role to borrow, so the installed badge brings its own
// green and only has to survive both ends of the theme range.
test("installedTint darkens the green for a light theme background", () => {
  assert.equal(Model.installedTint({ r: 0.06, g: 0.07, b: 0.08 }), "#5fb37a")
  assert.equal(Model.installedTint({ r: 0.98, g: 0.98, b: 0.98 }), "#1f7a4d")
})

test("installedTint reads lightness, not any single channel", () => {
  // Pure blue is dark despite a full channel; pure green is light despite two
  // empty ones. A naive max() or average would get both of these backwards.
  assert.equal(Model.installedTint({ r: 0, g: 0, b: 1 }), "#5fb37a")
  assert.equal(Model.installedTint({ r: 0, g: 1, b: 0 }), "#1f7a4d")
})

test("installedTint assumes a dark panel when handed nothing", () => {
  assert.equal(Model.installedTint(null), "#5fb37a")
})

test("accentColor falls back rather than returning nothing", () => {
  assert.equal(Model.accentColor("cyan"), Model.accentColor("CYAN"))
  assert.equal(Model.accentColor("not-a-colour"), Model.accentColor("violet"))
})

test("repoShortLabel drops the host, which is the same on every card", () => {
  assert.equal(Model.repoShortLabel("https://github.com/akitaonrails/ai-usagebar"), "akitaonrails/ai-usagebar")
  assert.equal(Model.repoShortLabel("https://github.com/acme/thing.git"), "acme/thing")
  assert.equal(Model.repoShortLabel("https://github.com/acme/thing/"), "acme/thing")
  assert.equal(Model.repoShortLabel("git@github.com:acme/thing.git"), "acme/thing")
  assert.equal(Model.repoShortLabel(""), "")
})

test("browsableUrl only ever hands https to the browser", () => {
  // The repo field arrives over the network, so a url that is not a web page
  // must never reach the launcher.
  assert.equal(Model.browsableUrl("https://omarchyplugins.com/"), "https://omarchyplugins.com/")
  assert.equal(Model.browsableUrl("https://github.com/a/b"), "https://github.com/a/b")
  assert.equal(Model.browsableUrl("http://github.com/a/b"), "")
  assert.equal(Model.browsableUrl("javascript:alert(1)"), "")
  assert.equal(Model.browsableUrl("file:///etc/passwd"), "")
  assert.equal(Model.browsableUrl("https://github.com/a b"), "")
  assert.equal(Model.browsableUrl("https://github.com"), "")
  assert.equal(Model.browsableUrl(""), "")
  assert.equal(Model.browsableUrl(null), "")
})

// An installed checkout names its origin in git's own vocabulary, which is
// not a web address: ssh remotes and the .git suffix both have to be turned
// into something a browser can open.
test("repoWebUrl turns a git remote into a page you can open", () => {
  assert.equal(Model.repoWebUrl("https://github.com/a/b.git"), "https://github.com/a/b")
  assert.equal(Model.repoWebUrl("git@github.com:a/b.git"), "https://github.com/a/b")
  assert.equal(Model.repoWebUrl("ssh://git@github.com/a/b.git"), "https://github.com/a/b")
  assert.equal(Model.repoWebUrl("https://gitlab.com/group/sub/proj/"), "https://gitlab.com/group/sub/proj")
})

test("repoWebUrl refuses anything that is not a repository on the web", () => {
  assert.equal(Model.repoWebUrl(""), "")
  assert.equal(Model.repoWebUrl("/home/me/plugins/local"), "")
  assert.equal(Model.repoWebUrl("javascript:alert(1)"), "")
  assert.equal(Model.repoWebUrl("file:///etc/passwd"), "")
  assert.equal(Model.repoWebUrl("git@github.com:a b.git"), "")
  assert.equal(Model.repoWebUrl("https://github.com"), "")
})

test("rowRepoUrl prefers the live origin over what the plugin was cloned from", () => {
  // The origin is where an update will actually pull from; clonedFrom is only
  // a record of how it first arrived, and a checkout can be repointed.
  assert.equal(
    Model.rowRepoUrl({ remote: "git@github.com:a/live.git", clonedFrom: "https://github.com/a/old" }),
    "https://github.com/a/live")
  assert.equal(Model.rowRepoUrl({ remote: "", clonedFrom: "https://github.com/a/old" }), "https://github.com/a/old")
  assert.equal(Model.rowRepoUrl({ remote: "", clonedFrom: "" }), "")
  assert.equal(Model.rowRepoUrl(null), "")
})

test("manifest versions become bounded encoded Release candidates in deterministic order", () => {
  assert.equal(Model.normalizedManifestVersion("  1.2.3\n"), "1.2.3")
  assert.equal(Model.normalizedManifestVersion("x".repeat(100)), "x".repeat(100))
  assert.equal(Model.normalizedManifestVersion("x".repeat(101)), "")

  const candidates = Model.githubReleaseCandidates(
    "git@github.com:acme/thing.git", "  1.2.3+build/one  ")
  assert.deepEqual(candidates, [
    {
      probeUrl: "https://api.github.com/repos/acme/thing/releases/tags/v1.2.3%2Bbuild%2Fone",
      preferredUrl: "https://github.com/acme/thing/releases/tag/v1.2.3%2Bbuild%2Fone"
    },
    {
      probeUrl: "https://api.github.com/repos/acme/thing/releases/tags/1.2.3%2Bbuild%2Fone",
      preferredUrl: "https://github.com/acme/thing/releases/tag/1.2.3%2Bbuild%2Fone"
    }
  ])

  assert.equal(Model.normalizedReleaseVersion("vv1.2.3"), "1.2.3")
  assert.equal(Model.releaseVersionLabel("V1.2.3"), "v1.2.3")
  assert.equal(Model.releaseVersionLabel("vv"), "")
  assert.deepEqual(Model.githubReleaseCandidates(
    "https://github.com/acme/thing", "v1.2.3"), [
    {
      probeUrl: "https://api.github.com/repos/acme/thing/releases/tags/v1.2.3",
      preferredUrl: "https://github.com/acme/thing/releases/tag/v1.2.3"
    },
    {
      probeUrl: "https://api.github.com/repos/acme/thing/releases/tags/1.2.3",
      preferredUrl: "https://github.com/acme/thing/releases/tag/1.2.3"
    }
  ])
})

test("catalog versions link only through exact GitHub release candidates with repository fallback", () => {
  const github = { repo: "https://github.com/acme/thing.git", version: "v1.2.3" }
  assert.equal(Model.catalogVersionLabel(github), "v1.2.3")
  assert.deepEqual(Model.catalogVersionReleaseCandidates(github),
    Model.githubReleaseCandidates(github.repo, "1.2.3"))
  assert.equal(Model.catalogVersionFallbackUrl(github), "https://github.com/acme/thing")

  const nonGithub = { repo: "https://gitlab.com/acme/thing", version: "1.2.3" }
  assert.equal(Model.catalogVersionLabel(nonGithub), "v1.2.3")
  assert.deepEqual(Model.catalogVersionReleaseCandidates(nonGithub), [])
  assert.equal(Model.catalogVersionFallbackUrl(nonGithub), "")

  for (const entry of [
    { repo: github.repo, version: "" },
    { repo: github.repo, version: "v" },
    { repo: github.repo, version: "x".repeat(101) },
    null
  ]) {
    assert.equal(Model.catalogVersionLabel(entry), "")
    assert.deepEqual(Model.catalogVersionReleaseCandidates(entry), [])
    assert.equal(Model.catalogVersionFallbackUrl(entry), "")
  }
})

test("installed version eligibility requires checkout, version, and hardened current GitHub origin, not exactTag", () => {
  const eligible = {
    gitManaged: true,
    localVersion: "1.0.3",
    exactTag: "",
    headSha: "a".repeat(40),
    remote: "ssh://git@github.com/Owner/repo.name.git"
  }
  assert.equal(Model.versionReleaseCandidates(eligible).length, 2)
  assert.equal(Model.versionFallbackUrl(eligible),
    "https://github.com/Owner/repo.name/tree/" + "a".repeat(40))

  for (const row of [
    { ...eligible, gitManaged: false },
    { ...eligible, localVersion: "" },
    { ...eligible, localVersion: "x".repeat(101) },
    { ...eligible, remote: "", clonedFrom: eligible.remote },
    { ...eligible, remote: "https://gitlab.com/acme/thing" },
    { ...eligible, remote: "https://github.com/acme/thing/tree/main" },
    null
  ]) {
    assert.deepEqual(Model.versionReleaseCandidates(row), [])
    assert.equal(Model.versionFallbackUrl(row), "")
  }
})

test("installed version fallback prefers exact tag, then loaded HEAD, then repository root", () => {
  const row = {
    gitManaged: true,
    localVersion: "1.0.3",
    exactTag: "v1.0.3",
    headSha: "a".repeat(40),
    remote: "https://github.com/acme/thing.git"
  }
  assert.equal(Model.versionFallbackUrl(row),
    "https://github.com/acme/thing/tree/v1.0.3")
  assert.equal(Model.versionFallbackUrl({ ...row, exactTag: "" }),
    "https://github.com/acme/thing/tree/" + "a".repeat(40))
  assert.equal(Model.versionFallbackUrl({ ...row, exactTag: "", headSha: "" }),
    "https://github.com/acme/thing")
  assert.equal(Model.versionFallbackUrl({ ...row, exactTag: "release-1.0.3" }),
    "https://github.com/acme/thing/tree/" + "a".repeat(40))
})

test("Release candidates preserve hardened GitHub owner and repository boundaries", () => {
  const accepted = [
    "https://github.com/Mixed-Case/.github.git",
    "git@github.com:owner-name/repo_name.git",
    "ssh://git@github.com/Owner/repo.name.git"
  ]
  for (const remote of accepted)
    assert.equal(Model.githubReleaseCandidates(remote, "1.0.0").length, 2)

  for (const remote of [
    "https://github.com/../repo",
    "https://github.com/%2e%2e/repo",
    "https://github.com/owner/..",
    "https://github.com/owner/repo/tree/main",
    "https://github.com/-owner/repo",
    "https://github.com/owner_name/repo",
    "https://github.com/" + "a".repeat(40) + "/repo",
    "https://github.com/owner/" + "r".repeat(101)
  ]) assert.deepEqual(Model.githubReleaseCandidates(remote, "1.0.0"), [], remote)
})

test("repoPreviewUrl points at the repo's own preview.png on the validated branch", () => {
  assert.equal(
    Model.repoPreviewUrl("https://github.com/acme/thing", "master"),
    "https://raw.githubusercontent.com/acme/thing/master/preview.png")
  assert.equal(
    Model.repoPreviewUrl("https://github.com/acme/thing.git", ""),
    "https://raw.githubusercontent.com/acme/thing/main/preview.png")
})

test("repoPreviewUrl only builds urls for github repos it can parse", () => {
  assert.equal(Model.repoPreviewUrl("https://gitlab.com/acme/thing", "main"), "")
  assert.equal(Model.repoPreviewUrl("https://github.com/acme", "main"), "")
  assert.equal(Model.repoPreviewUrl("", "main"), "")
})

test("previewCandidates tries the repo png before the registry webp", () => {
  const entry = { repoPreview: "https://raw.example/preview.png", thumbnail: "https://reg.example/x.webp" }
  assert.deepEqual(Model.previewCandidates(entry, true),
    ["https://raw.example/preview.png", "https://reg.example/x.webp"])
  // Once WebP is known undecodable the panel drops it from the walk.
  assert.deepEqual(Model.previewCandidates(entry, false), ["https://raw.example/preview.png"])
  assert.deepEqual(Model.previewCandidates({ repoPreview: "", thumbnail: "" }, true), [])
  assert.deepEqual(Model.previewCandidates(null, true), [])
})

// ---- Update checks ---------------------------------------------------------

const baseRows = [
  { id: "a.behind", sourceDir: "/plugins/a", name: "Behind", remote: "https://github.com/acme/behind.git", headSha: "a".repeat(40) },
  { id: "b.current", sourceDir: "/plugins/b", name: "Current", remote: "https://github.com/acme/current.git", headSha: "c".repeat(40) },
  { id: "c.unreachable", sourceDir: "/plugins/c", name: "Unreachable", headSha: "c".repeat(40) },
  { id: "d.notgit", sourceDir: "/plugins/d", name: "Not git" }
]

const sha40A = "a".repeat(40)
const sha40B = "b".repeat(40)
const sha40C = "c".repeat(40)
const sha64A = "a".repeat(64)
const sha64B = "b".repeat(64)

function updateRecord(overrides = {}) {
  return JSON.stringify({
    path: "/plugins/a",
    localSha: sha40A,
    remoteSha: sha40B,
    localVersion: "1.0.0",
    remoteVersion: "1.2.0",
    ...overrides
  })
}

const report = Model.parseUpdateReport([
  updateRecord(),
  updateRecord({ path: "/plugins/b", localSha: sha40C, remoteSha: sha40C, localVersion: "2.0.0", remoteVersion: "" }),
  updateRecord({ path: "/plugins/c", localSha: sha40C, remoteSha: "", localVersion: "3.0.0", remoteVersion: "" })
].join("\n"))

test("parseUpdateReport accepts exact JSONL records and keys on the plugin directory", () => {
  assert.deepEqual(Object.keys(report).sort(), ["/plugins/a", "/plugins/b", "/plugins/c"])
  assert.equal(report["/plugins/a"].remoteVersion, "1.2.0")
  assert.equal(report["/plugins/a"].localSha, sha40A)
})

test("parseUpdateReport rejects malformed JSON, legacy TSV, and the wrong schema", () => {
  const lines = [
    "not-json",
    "/plugins/legacy\t" + sha40A + "\t" + sha40B + "\t1\t2",
    "[]",
    "null",
    JSON.stringify({ path: "/plugins/missing", localSha: sha40A, remoteSha: sha40B, localVersion: "1" }),
    updateRecord({ path: "/plugins/extra", extra: "field" }),
    updateRecord({ path: "/plugins/legacy-tag", remoteTag: "v2" }),
    JSON.stringify({ path: "/plugins/type", localSha: sha40A, remoteSha: sha40B, localVersion: 1, remoteVersion: "2" }),
    updateRecord({ path: "/plugins/valid" })
  ]
  const parsed = Model.parseUpdateReport(lines.join("\n"))
  assert.deepEqual(Object.keys(parsed), ["/plugins/valid"])
})

test("parseUpdateReport keeps hostile path and version bytes inside their JSONL record", () => {
  const forgedPath = "/plugins/evil\n" + updateRecord({ path: "/plugins/victim" })
  const forgedVersion = "1.0\tforged\n" + updateRecord({ path: "/plugins/victim" })
  const parsed = Model.parseUpdateReport(updateRecord({
    path: forgedPath,
    localVersion: forgedVersion,
    remoteVersion: "2.0\rforged"
  }))

  assert.deepEqual(Object.keys(parsed), [forgedPath])
  assert.equal(parsed[forgedPath].localVersion, "1.0 forged " + updateRecord({ path: "/plugins/victim" }))
  assert.equal(parsed[forgedPath].remoteVersion, "2.0 forged")
  assert.equal(parsed["/plugins/victim"], undefined)
})

test("parseUpdateReport accepts only empty, 40-hex, or 64-hex object ids", () => {
  const accepted = Model.parseUpdateReport([
    updateRecord({ path: "/plugins/sha1", localSha: sha40A.toUpperCase(), remoteSha: sha40B.toUpperCase() }),
    updateRecord({ path: "/plugins/sha256", localSha: sha64A, remoteSha: sha64B }),
    updateRecord({ path: "/plugins/unknown", remoteSha: "" })
  ].join("\n"))
  assert.deepEqual(Object.keys(accepted), ["/plugins/sha1", "/plugins/sha256", "/plugins/unknown"])
  assert.equal(accepted["/plugins/sha1"].localSha, sha40A)

  const rejected = Model.parseUpdateReport([
    updateRecord({ path: "/plugins/short", localSha: "a".repeat(39) }),
    updateRecord({ path: "/plugins/long", remoteSha: "b".repeat(65) }),
    updateRecord({ path: "/plugins/nonhex", remoteSha: "g".repeat(40) })
  ].join("\n"))
  assert.deepEqual(rejected, {})
})

test("a differing remote head marks the row behind", () => {
  const rows = Model.applyUpdateReport(baseRows, report)
  const behind = rows.find(r => r.id === "a.behind")
  assert.equal(behind.behind, true)
  assert.equal(behind.updateChecked, true)
  assert.equal(behind.versionChanged, true)
  assert.equal(behind.localSha, sha40A)
  assert.equal(behind.remoteSha, sha40B)
})

test("applyUpdateReport replays report evidence only for an unchanged loaded HEAD", () => {
  const row = Model.applyUpdateReport(baseRows, report)[0]
  assert.equal(row.headSha, sha40A)
  assert.equal(row.behind, true)
  assert.equal(Model.updateCompareUrl(row),
    "https://github.com/acme/behind/compare/" + sha40A + "..." + sha40B)
})

test("a matching head is up to date, not behind", () => {
  const rows = Model.applyUpdateReport(baseRows, report)
  const current = rows.find(r => r.id === "b.current")
  assert.equal(current.behind, false)
  assert.equal(current.updateChecked, true)
})

test("an unreachable remote is 'not known', never 'up to date'", () => {
  // Being quietly told nothing is how a stale plugin sits there looking current.
  const rows = Model.applyUpdateReport(baseRows, report)
  const unknown = rows.find(r => r.id === "c.unreachable")
  assert.equal(unknown.updateChecked, false)
  assert.equal(unknown.behind, false)

  const missing = rows.find(r => r.id === "d.notgit")
  assert.equal(missing.updateChecked, false)
  assert.equal(missing.behind, false)
})

// The manifest read at load time is the only version a built-in or a
// non-git checkout ever gets; an update pass that skipped it must not blank it.
test("applyUpdateReport keeps a manifest version the git pass never saw", () => {
  const rows = Model.applyUpdateReport(
    [{ id: "e.local", sourceDir: "/plugins/e.local", localVersion: "3.1.4" }],
    report
  )
  assert.equal(rows[0].localVersion, "3.1.4")
})

test("applyUpdateReport flattens displayed versions and revalidates sha evidence", () => {
  const rows = Model.applyUpdateReport(
    [{ id: "e.direct", sourceDir: "/plugins/e.direct", localVersion: "old\nversion", headSha: sha40A }],
    { "/plugins/e.direct": {
      localSha: sha40A.toUpperCase(),
      remoteSha: "not-an-object-id",
      localVersion: "1.0\tlocal",
      remoteVersion: "2.0\nremote"
    } }
  )
  assert.equal(rows[0].localVersion, "1.0 local")
  assert.equal(rows[0].remoteVersion, "2.0 remote")
  assert.equal(rows[0].localSha, sha40A)
  assert.equal(rows[0].remoteSha, "")
  assert.equal(rows[0].updateChecked, false)
  assert.equal(rows[0].behind, false)
})

test("applyUpdateReport does not mutate the rows it was given", () => {
  const rows = Model.applyUpdateReport(baseRows, report)
  assert.equal(rows[0].behind, true)
  assert.equal(baseRows[0].behind, undefined)
})

test("applyUpdateReport clears stale shas when later evidence is absent or invalid", () => {
  const stale = [{
    id: "stale",
    sourceDir: "/plugins/stale",
    localVersion: "1.0.0",
    headSha: sha40A,
    localSha: sha40A,
    remoteSha: sha40B,
    updateChecked: true,
    behind: true
  }]
  const missing = Model.applyUpdateReport(stale, {})[0]
  assert.equal(missing.localSha, "")
  assert.equal(missing.remoteSha, "")
  assert.equal(missing.updateChecked, false)
  assert.equal(missing.behind, false)

  const invalid = Model.parseUpdateReport(updateRecord({
    path: "/plugins/stale",
    remoteSha: "not-an-object-id"
  }))
  const rejected = Model.applyUpdateReport(stale, invalid)[0]
  assert.equal(rejected.localSha, "")
  assert.equal(rejected.remoteSha, "")
  assert.equal(rejected.behind, false)
})

function assertUpdateEvidenceCleared(row) {
  assert.equal(row.localSha, "")
  assert.equal(row.remoteSha, "")
  assert.equal(row.remoteVersion, "")
  assert.equal(row.updateChecked, false)
  assert.equal(row.behind, false)
  assert.equal(row.versionChanged, false)
  assert.equal(Model.updateCompareUrl(row), "")
  assert.deepEqual(Model.updateReleaseCandidates(row), [])
}

test("changed loaded HEAD rejects a pending report and clears every derived target", () => {
  const freshlyLoaded = [{
    id: "a.behind",
    sourceDir: "/plugins/a",
    localVersion: "1.2.0",
    remote: "https://github.com/acme/behind.git",
    exactTag: "v1.2.0",
    headSha: sha40B,
    gitManaged: true,
    localSha: sha40A,
    remoteSha: sha40B,
    remoteVersion: "1.2.0",
    updateChecked: true,
    behind: true,
    versionChanged: true
  }]
  const row = Model.applyUpdateReport(freshlyLoaded, report)[0]
  assertUpdateEvidenceCleared(row)
  assert.equal(row.localVersion, "1.2.0")
  assert.equal(row.headSha, sha40B)
  assert.equal(row.exactTag, "v1.2.0")
  assert.equal(Model.versionFallbackUrl(row),
    "https://github.com/acme/behind/tree/v1.2.0")
})

test("absent or invalid loaded HEAD rejects otherwise valid report evidence", () => {
  for (const headSha of ["", "a".repeat(39), "g".repeat(40), null]) {
    const row = Model.applyUpdateReport([{
      ...baseRows[0],
      localVersion: "1.0.0",
      headSha,
      localSha: sha40A,
      remoteSha: sha40B,
      behind: true,
      versionChanged: true
    }], report)[0]
    assertUpdateEvidenceCleared(row)
    assert.equal(row.localVersion, "1.0.0")
    assert.equal(row.headSha, "")
  }
})

test("pending report lifecycle rejects an old generation and accepts a fresh matching generation", () => {
  const oldPending = Model.parseUpdateReport(updateRecord())
  const oldLoaded = Model.applyUpdateReport(baseRows, oldPending)[0]
  assert.equal(oldLoaded.behind, true)

  // A successful pull or external checkout change reloads both the manifest
  // version and its provenance before the old process result is replayed.
  const newLoaded = {
    ...baseRows[0],
    localVersion: "1.2.0",
    exactTag: "v1.2.0",
    headSha: sha40B
  }
  const replayed = Model.applyUpdateReport([newLoaded], oldPending)[0]
  assertUpdateEvidenceCleared(replayed)
  assert.equal(replayed.localVersion, "1.2.0")
  assert.equal(replayed.exactTag, "v1.2.0")

  // The same stale result arriving after the new load remains powerless.
  const lateOldResult = Model.applyUpdateReport([replayed], oldPending)[0]
  assertUpdateEvidenceCleared(lateOldResult)

  const freshPending = Model.parseUpdateReport(updateRecord({
    localSha: sha40B,
    remoteSha: sha40C,
    localVersion: "1.2.0",
    remoteVersion: "1.3.0"
  }))
  const fresh = Model.applyUpdateReport([lateOldResult], freshPending)[0]
  assert.equal(fresh.behind, true)
  assert.equal(fresh.versionChanged, true)
  assert.equal(fresh.localSha, sha40B)
  assert.equal(fresh.remoteSha, sha40C)
  assert.equal(Model.updateCompareUrl(fresh),
    "https://github.com/acme/behind/compare/" + sha40B + "..." + sha40C)
  assert.equal(Model.updateReleaseCandidates(fresh)[0].preferredUrl,
    "https://github.com/acme/behind/releases/tag/v1.3.0")
})

test("the badge only shows an arrow when the versions actually differ", () => {
  // Authors do not reliably bump the manifest, so equal versions across a real
  // update is the common case — "1.0.0 → 1.0.0" would read as a bug.
  assert.equal(Model.updateBadge({ behind: true, versionChanged: true, localVersion: "1.0.0", remoteVersion: "1.2.0" }), "1.0.0 → 1.2.0")
  assert.equal(Model.updateBadge({ behind: true, versionChanged: false, localVersion: "1.0.0", remoteVersion: "1.0.0" }), "update")
  assert.equal(Model.updateBadge({ behind: false }), "")
  assert.equal(Model.updateBadge(null), "")
})

test("updateCompareUrl builds the exact GitHub comparison for 40-hex and 64-hex evidence", () => {
  assert.equal(Model.updateCompareUrl({
    behind: true,
    localSha: sha40A,
    remoteSha: sha40B,
    remote: "https://github.com/acme/thing.git"
  }), "https://github.com/acme/thing/compare/" + sha40A + "..." + sha40B)

  assert.equal(Model.updateCompareUrl({
    behind: true,
    localSha: sha64A.toUpperCase(),
    remoteSha: sha64B.toUpperCase(),
    remote: "git@github.com:acme/thing.git"
  }), "https://github.com/acme/thing/compare/" + sha64A + "..." + sha64B)
})

test("updateCompareUrl supports GitHub SSH origins through the hardened slug parser", () => {
  const expected = "https://github.com/Owner/repo.name/compare/" + sha40A + "..." + sha40B
  assert.equal(Model.updateCompareUrl({
    behind: true,
    localSha: sha40A,
    remoteSha: sha40B,
    remote: "ssh://git@github.com/Owner/repo.name.git"
  }), expected)
  assert.equal(Model.updateCompareUrl({
    behind: true,
    localSha: sha40A,
    remoteSha: sha40B,
    remote: "git@github.com:Owner/repo.name.git"
  }), expected)
})

test("updateCompareUrl requires distinct valid object ids on a behind row", () => {
  const proven = {
    behind: true,
    localSha: sha40A,
    remoteSha: sha40B,
    remote: "https://github.com/acme/thing"
  }
  assert.equal(Model.updateCompareUrl({ ...proven, behind: false }), "")
  assert.equal(Model.updateCompareUrl({ ...proven, localSha: "" }), "")
  assert.equal(Model.updateCompareUrl({ ...proven, remoteSha: "" }), "")
  assert.equal(Model.updateCompareUrl({ ...proven, remoteSha: sha40A }), "")
  assert.equal(Model.updateCompareUrl({ ...proven, localSha: "a".repeat(39) }), "")
  assert.equal(Model.updateCompareUrl({ ...proven, remoteSha: "g".repeat(40) }), "")
  assert.equal(Model.updateCompareUrl(null), "")
})

test("updateCompareUrl trusts only the current GitHub origin", () => {
  const proven = { behind: true, localSha: sha40A, remoteSha: sha40B }
  assert.equal(Model.updateCompareUrl({
    ...proven,
    remote: "https://gitlab.com/acme/thing.git",
    clonedFrom: "https://github.com/acme/thing.git"
  }), "")
  assert.equal(Model.updateCompareUrl({
    ...proven,
    remote: "",
    clonedFrom: "https://github.com/acme/thing.git"
  }), "")
  assert.equal(Model.updateCompareUrl({
    ...proven,
    remote: "https://github.com/acme/thing/tree/main"
  }), "")
  assert.equal(Model.updateCompareUrl({
    ...proven,
    remote: "https://github.com/%2e%2e/thing"
  }), "")
})

test("changed remote versions build ordered encoded Release candidates without remote tag proof", () => {
  const row = {
    behind: true,
    versionChanged: true,
    localSha: sha40A,
    remoteSha: sha40B,
    remoteVersion: "2.0.0+build",
    remote: "ssh://git@github.com/Owner/repo.name.git"
  }
  assert.deepEqual(Model.updateReleaseCandidates(row).map(candidate => candidate.preferredUrl), [
    "https://github.com/Owner/repo.name/releases/tag/v2.0.0%2Bbuild",
    "https://github.com/Owner/repo.name/releases/tag/2.0.0%2Bbuild"
  ])
})

test("update Release lookup requires changed version plus exact comparison evidence", () => {
  const proven = {
    behind: true,
    versionChanged: true,
    localSha: sha40A,
    remoteSha: sha40B,
    remoteVersion: "2.0.0",
    remote: "https://github.com/acme/thing.git"
  }
  const rejected = [
    { ...proven, behind: false },
    { ...proven, versionChanged: false },
    { ...proven, localSha: "" },
    { ...proven, remoteSha: "" },
    { ...proven, remoteSha: sha40A },
    { ...proven, remoteVersion: "" },
    { ...proven, remoteVersion: "x".repeat(101) },
    { ...proven, remote: "", clonedFrom: proven.remote },
    { ...proven, remote: "https://gitlab.com/acme/thing", clonedFrom: proven.remote },
    null
  ]
  for (const row of rejected) assert.deepEqual(Model.updateReleaseCandidates(row), [])

  const sameVersion = { ...proven, versionChanged: false, remoteVersion: "1.0.0" }
  assert.deepEqual(Model.updateReleaseCandidates(sameVersion), [])
  assert.equal(Model.updateCompareUrl(sameVersion),
    "https://github.com/acme/thing/compare/" + sha40A + "..." + sha40B)
})

test("GitHub navigation accepts only constructed release, tree, compare, and repository URLs", () => {
  const release = "https://github.com/acme/thing/releases/tag/v1.2.0%2Bbuild"
  const api = "https://api.github.com/repos/acme/thing/releases/tags/v1.2.0%2Bbuild"
  const tree = "https://github.com/acme/thing/tree/v1.2.0%2Bbuild"
  const compare = "https://github.com/acme/thing/compare/" + sha40A + "..." + sha40B
  const repo = "https://github.com/acme/thing"
  assert.equal(Model.trustedGithubReleaseApiUrl(api), api)
  assert.equal(Model.trustedGithubReleaseUrl(release), release)
  assert.equal(Model.trustedGithubWebUrl(tree), tree)
  assert.equal(Model.trustedGithubWebUrl(compare), compare)
  assert.equal(Model.trustedGithubRepoUrl(repo), repo)
  assert.equal(Model.trustedGithubWebUrl(repo), repo)

  const rejected = [
    "http://github.com/acme/thing/tree/v1",
    "https://api.github.com/repos/acme/thing/releases/latest",
    "https://github.com/acme/thing/releases/tag/%0Aevil",
    "https://github.com/acme/thing/tree/v1?x=1",
    "https://github.com/acme/thing/compare/main...master",
    "https://github.com/acme/thing/issues"
  ]
  assert.equal(Model.trustedGithubReleaseApiUrl(rejected[1]), "")
  for (const url of rejected) assert.equal(Model.trustedGithubWebUrl(url), "")
})

test("click routing validates, pairs, deduplicates, and bounds Release candidates", () => {
  const api = "https://api.github.com/repos/acme/thing/releases/tags/v1.2.0"
  const release = "https://github.com/acme/thing/releases/tag/v1.2.0"
  const tree = "https://github.com/acme/thing/tree/v1.2.0"
  const compare = "https://github.com/acme/thing/compare/" + sha40A + "..." + sha40B
  const plain = {
    probeUrl: "https://api.github.com/repos/acme/thing/releases/tags/1.2.0",
    preferredUrl: "https://github.com/acme/thing/releases/tag/1.2.0"
  }
  assert.deepEqual(Model.githubNavigationRequest([
    { probeUrl: api, preferredUrl: release },
    { probeUrl: api, preferredUrl: release },
    plain,
    {
      probeUrl: "https://api.github.com/repos/acme/thing/releases/tags/third",
      preferredUrl: "https://github.com/acme/thing/releases/tag/third"
    }
  ], tree), {
    candidates: [{ probeUrl: api, preferredUrl: release }, plain], fallbackUrl: tree
  })
  assert.deepEqual(Model.githubNavigationRequest([], compare), {
    candidates: [], fallbackUrl: compare
  })
  assert.deepEqual(Model.githubNavigationRequest([
    { probeUrl: api, preferredUrl: "https://github.com/other/repo/releases/tag/v1.2.0" },
    { probeUrl: "https://evil.test", preferredUrl: release }
  ], tree), {
    candidates: [], fallbackUrl: tree
  })
  assert.deepEqual(Model.githubNavigationRequest([{ probeUrl: api, preferredUrl: release }], "https://evil.test"), {
    candidates: [], fallbackUrl: ""
  })
})

function releaseRequest(version) {
  return Model.githubNavigationRequest(
    Model.githubReleaseCandidates("https://github.com/acme/thing", version),
    `https://github.com/acme/thing/tree/${version}`)
}

function settleProbe(state, order, exitCode = 0, responseCode = "200") {
  const effects = []
  for (const event of order) {
    const transition = event === "exit"
      ? Model.releaseNavigationProbeExitedTransition(state, exitCode)
      : Model.releaseNavigationProbeOutputTransition(state, responseCode)
    effects.push(transition)
    state = transition.state
  }
  return { state, effects }
}

test("release navigation A then B starts only B after A fully settles", () => {
  const a = releaseRequest("v1"), b = releaseRequest("v2")
  let transition = Model.releaseNavigationRequestTransition(
    Model.releaseNavigationInitialState(), a)
  const aGeneration = transition.startRequest.generation
  let state = transition.state

  transition = Model.releaseNavigationRequestTransition(state, b)
  state = transition.state
  assert.equal(transition.stopProbe, true)
  assert.equal(transition.startRequest, null)
  assert.equal(state.activeGeneration, aGeneration)
  assert.equal(state.activeRequest, null)
  assert.equal(state.queuedRequest.request.candidates[0].preferredUrl, b.candidates[0].preferredUrl)

  const settled = settleProbe(state, ["exit", "output"])
  assert.equal(settled.effects[0].openUrl, "")
  assert.equal(settled.effects[0].scheduleStart, false)
  assert.equal(settled.effects[1].openUrl, "")
  assert.equal(settled.effects[1].scheduleStart, true)

  transition = Model.releaseNavigationStartQueuedTransition(settled.state)
  assert.equal(transition.startRequest.probeUrl, b.candidates[0].probeUrl)
  const completed = settleProbe(transition.state, ["output", "exit"])
  assert.equal(completed.effects[0].openUrl, "")
  assert.equal(completed.effects[1].openUrl, b.candidates[0].preferredUrl)
})

test("release navigation A then B then C coalesces to C", () => {
  const a = releaseRequest("v1"), b = releaseRequest("v2"), c = releaseRequest("v3")
  let transition = Model.releaseNavigationRequestTransition(
    Model.releaseNavigationInitialState(), a)
  transition = Model.releaseNavigationRequestTransition(transition.state, b)
  assert.equal(transition.state.queuedRequest.request.candidates[0].preferredUrl, b.candidates[0].preferredUrl)
  transition = Model.releaseNavigationRequestTransition(transition.state, c)
  assert.equal(transition.state.queuedRequest.request.candidates[0].preferredUrl, c.candidates[0].preferredUrl)
  assert.notEqual(transition.state.queuedRequest.request.candidates[0].preferredUrl, b.candidates[0].preferredUrl)

  const settled = settleProbe(transition.state, ["output", "exit"])
  transition = Model.releaseNavigationStartQueuedTransition(settled.state)
  assert.equal(transition.startRequest.probeUrl, c.candidates[0].probeUrl)
  const completed = settleProbe(transition.state, ["exit", "output"])
  assert.equal(completed.effects[1].openUrl, c.candidates[0].preferredUrl)
})

test("repository and direct fallback navigation revoke A and open immediately", () => {
  const a = releaseRequest("v1")
  const repo = "https://github.com/acme/thing"
  const compare = "https://github.com/acme/thing/compare/" + sha40A + "..." + sha40B

  for (const direct of [
    state => Model.releaseNavigationDirectTransition(state, repo),
    state => Model.releaseNavigationRequestTransition(
      state, Model.githubNavigationRequest([], compare))
  ]) {
    let transition = Model.releaseNavigationRequestTransition(
      Model.releaseNavigationInitialState(), a)
    transition = direct(transition.state)
    assert.equal(transition.stopProbe, true)
    assert.ok(transition.openUrl === repo || transition.openUrl === compare)
    assert.equal(transition.state.activeRequest, null)
    assert.equal(transition.state.queuedRequest, null)
    const settled = settleProbe(transition.state, ["exit", "output"])
    for (const effect of settled.effects) assert.equal(effect.openUrl, "")
  }
})

test("Browse Marketplace root URL survives direct navigation validation", () => {
  const url = "https://omarchyplugins.com/"
  const transition = Model.releaseNavigationDirectTransition(
    Model.releaseNavigationInitialState(), url)
  assert.equal(transition.openUrl, url)
})

test("actions, tab switches, reload, and close revoke A in either callback order", () => {
  const a = releaseRequest("v1")
  for (const order of [["exit", "output"], ["output", "exit"]]) {
    for (const choice of ["action", "tab", "reload", "close"]) {
      let transition = Model.releaseNavigationRequestTransition(
        Model.releaseNavigationInitialState(), a)
      transition = Model.releaseNavigationRevokeTransition(transition.state)
      assert.equal(transition.stopProbe, true, choice)
      assert.equal(transition.state.activeRequest, null, choice)
      const settled = settleProbe(transition.state, order)
      for (const effect of settled.effects) {
        assert.equal(effect.openUrl, "", choice)
        assert.equal(effect.startRequest, null, choice)
      }
    }
  }
})

test("canceled A callbacks cannot open or consume queued B in either order", () => {
  const a = releaseRequest("v1"), b = releaseRequest("v2")
  for (const order of [["exit", "output"], ["output", "exit"]]) {
    let transition = Model.releaseNavigationRequestTransition(
      Model.releaseNavigationInitialState(), a)
    transition = Model.releaseNavigationRequestTransition(transition.state, b)
    const first = settleProbe(transition.state, [order[0]])
    assert.equal(first.effects[0].openUrl, "")
    assert.equal(first.state.queuedRequest.request.candidates[0].preferredUrl, b.candidates[0].preferredUrl)
    assert.equal(first.state.activeGeneration !== 0, true)

    const second = settleProbe(first.state, [order[1]])
    assert.equal(second.effects[0].openUrl, "")
    assert.equal(second.effects[0].scheduleStart, true)
    assert.equal(second.state.queuedRequest.request.candidates[0].preferredUrl, b.candidates[0].preferredUrl)
    transition = Model.releaseNavigationStartQueuedTransition(second.state)
    assert.equal(transition.startRequest.probeUrl, b.candidates[0].probeUrl)
  }
})

test("ordered Release probes route first 200, second 200, both 404, and hard failures", () => {
  const request = releaseRequest("1.2.0")

  let started = Model.releaseNavigationRequestTransition(
    Model.releaseNavigationInitialState(), request)
  let completed = settleProbe(started.state, ["output", "exit"], 0, "200")
  assert.equal(completed.effects[1].openUrl, request.candidates[0].preferredUrl)

  started = Model.releaseNavigationRequestTransition(
    Model.releaseNavigationInitialState(), request)
  let first = settleProbe(started.state, ["exit", "output"], 0, "404")
  assert.equal(first.effects[1].openUrl, "")
  assert.equal(first.effects[1].scheduleStart, true)
  let second = Model.releaseNavigationStartQueuedTransition(first.state)
  assert.equal(second.startRequest.probeUrl, request.candidates[1].probeUrl)
  completed = settleProbe(second.state, ["output", "exit"], 0, "200")
  assert.equal(completed.effects[1].openUrl, request.candidates[1].preferredUrl)

  started = Model.releaseNavigationRequestTransition(
    Model.releaseNavigationInitialState(), request)
  first = settleProbe(started.state, ["output", "exit"], 0, "404")
  second = Model.releaseNavigationStartQueuedTransition(first.state)
  completed = settleProbe(second.state, ["exit", "output"], 0, "404")
  assert.equal(completed.effects[1].openUrl, request.fallbackUrl)
  assert.equal(completed.effects[1].scheduleStart, false)

  for (const failure of [
    { exitCode: 0, responseCode: "403" },
    { exitCode: 0, responseCode: "500" },
    { exitCode: 0, responseCode: "not-http" },
    { exitCode: 28, responseCode: "000" }
  ]) {
    started = Model.releaseNavigationRequestTransition(
      Model.releaseNavigationInitialState(), request)
    completed = settleProbe(
      started.state, ["exit", "output"], failure.exitCode, failure.responseCode)
    assert.equal(completed.effects[1].openUrl, request.fallbackUrl)
    assert.equal(completed.effects[1].scheduleStart, false)
  }
})

test("rapid replacement owns navigation at either candidate stage", () => {
  const a = releaseRequest("1"), b = releaseRequest("2")
  for (const candidateStage of [0, 1]) {
    let transition = Model.releaseNavigationRequestTransition(
      Model.releaseNavigationInitialState(), a)
    if (candidateStage === 1) {
      const first = settleProbe(transition.state, ["exit", "output"], 0, "404")
      transition = Model.releaseNavigationStartQueuedTransition(first.state)
      assert.equal(transition.startRequest.probeUrl, a.candidates[1].probeUrl)
    }

    transition = Model.releaseNavigationRequestTransition(transition.state, b)
    assert.equal(transition.stopProbe, true)
    assert.equal(transition.state.activeRequest, null)
    assert.equal(transition.state.queuedRequest.request.candidates[0].preferredUrl,
      b.candidates[0].preferredUrl)

    const oldSettled = settleProbe(transition.state, ["output", "exit"])
    const replacement = Model.releaseNavigationStartQueuedTransition(oldSettled.state)
    assert.equal(replacement.startRequest.probeUrl, b.candidates[0].probeUrl)
    const bCompleted = settleProbe(replacement.state, ["exit", "output"], 0, "200")
    assert.equal(bCompleted.effects[1].openUrl, b.candidates[0].preferredUrl)
  }
})

test("cancellation revokes navigation at either candidate stage", () => {
  const request = releaseRequest("1")
  for (const candidateStage of [0, 1]) {
    let transition = Model.releaseNavigationRequestTransition(
      Model.releaseNavigationInitialState(), request)
    if (candidateStage === 1) {
      const first = settleProbe(transition.state, ["output", "exit"], 0, "404")
      transition = Model.releaseNavigationStartQueuedTransition(first.state)
    }
    transition = Model.releaseNavigationRevokeTransition(transition.state)
    assert.equal(transition.stopProbe, true)
    const settled = settleProbe(transition.state, ["exit", "output"], 0, "200")
    for (const effect of settled.effects) {
      assert.equal(effect.openUrl, "")
      assert.equal(effect.startRequest, null)
    }
  }
})

test("release probe start failure clears busy state and uses the active fallback", () => {
  const request = releaseRequest("v1")
  const started = Model.releaseNavigationRequestTransition(
    Model.releaseNavigationInitialState(), request)
  const failed = Model.releaseNavigationProbeStartFailedTransition(started.state)
  assert.equal(failed.state.activeGeneration, 0)
  assert.equal(failed.openUrl, request.fallbackUrl)
})

test("repository and Release actions route browser ownership through Panel", () => {
  const panel = readFileSync(new URL("../Panel.qml", import.meta.url), "utf8")
  const pluginRow = readFileSync(new URL("../PluginRow.qml", import.meta.url), "utf8")
  const catalogCard = readFileSync(new URL("../CatalogCard.qml", import.meta.url), "utf8")
  const pluginDetails = readFileSync(new URL("../PluginDetails.qml", import.meta.url), "utf8")

  for (const delegate of [pluginRow, pluginDetails]) {
    assert.doesNotMatch(delegate, /Quickshell\.execDetached/)
    assert.match(delegate, /signal repositoryNavigationRequested\(string url\)/)
    assert.match(delegate, /repositoryNavigationRequested\(repoUrl\)/)
  }
  assert.doesNotMatch(catalogCard, /Quickshell\.execDetached|repositoryNavigationRequested/)
  assert.equal(panel.split('Quickshell.execDetached(["omarchy-launch-browser", trusted])').length - 1, 1)
  assert.equal(panel.split("onRepositoryNavigationRequested:").length - 1, 3)
  assert.equal(panel.split("onGithubNavigationRequested:").length - 1, 2)
  assert.match(pluginDetails, /signal githubNavigationRequested\(var candidates, string fallbackUrl\)/)
  assert.match(pluginDetails, /githubNavigationRequested\(versionReleaseCandidates, versionFallbackUrl\)/)
  assert.match(panel,
    /onGithubNavigationRequested: function\(candidates, fallbackUrl\) \{\s+root\.requestGithubNavigation\(candidates, fallbackUrl\)\s+\}/)
  assert.match(panel, /onClicked: root\.navigateExternalUrl\("https:\/\/omarchyplugins\.com\/"\)/)
  assert.match(panel, /onCloseRequested: \{ root\.revokeReleaseNavigation\(\); root\.close\(\) \}/)
  assert.match(panel, /onTabRequested: function\(direction\) \{ root\.revokeReleaseNavigation\(\); root\.switchPanel\(direction\) \}/)

  for (const name of [
    "switchTab", "reload", "loadCatalog", "askInstall",
    "askRemove", "askEnable", "askDisable", "startUpdate"
  ]) {
    const start = panel.indexOf(`function ${name}(`)
    const end = panel.indexOf("\n  }", start)
    assert.notEqual(start, -1, name)
    assert.match(panel.slice(start, end), /revokeReleaseNavigation\(\)/, name)
  }
})

test("the Installed tab has no url field: plugins are added from Browse only", () => {
  const panel = readFileSync(new URL("../Panel.qml", import.meta.url), "utf8")

  assert.doesNotMatch(panel, /urlField|addButton/)
  assert.doesNotMatch(panel, /function askAdd\(|function focusUrlField\(/)
  assert.doesNotMatch(panel, /https:\/\/github\.com\/user\/omarchy-plugin\.git/)
  assert.doesNotMatch(panel, /\ba add\b/)
  // The clone-and-place path survives: Browse still installs through it.
  assert.match(panel, /function startAdd\(section\)/)
})

test("Installed filters share the Browse shape: labels on top, Search on its own row", () => {
  const panel = readFileSync(new URL("../Panel.qml", import.meta.url), "utf8")

  assert.match(panel, /property string groupFilter: "all"/)
  assert.match(panel, /readonly property var groupOptions: Model\.groupOptions\(\)/)
  assert.match(panel, /Model\.filterRows\(rows, kindFilter, statusFilter, searchQuery, groupFilter\)/)
  assert.match(panel, /Model\.isFiltering\(kindFilter, statusFilter, searchQuery, groupFilter\)/)
  assert.match(panel, /Model\.emptyMessage\(root\.kindFilter, root\.statusFilter, root\.searchQuery, root\.groupFilter\)/)
  assert.match(panel, /function setGroupFilter\(group\)/)

  // The Installed row is one labelled block, Source · Kind · Status, sized in
  // equal columns exactly like the Browse row.
  const start = panel.indexOf("id: installedFilters")
  const end = panel.indexOf("id: browseFilters", start)
  assert.notEqual(start, -1)
  assert.notEqual(end, -1)
  const block = panel.slice(start, end)
  assert.match(block, /visible: !root\.browsing/)
  assert.match(block, /readonly property real optionWidth: Math\.floor\(\(width - gap \* 2\) \/ 3\)/)
  for (const label of ["Source", "Kind", "Status"]) {
    assert.match(block, new RegExp(`anchors\\.top: parent\\.top\\s+text: "${label}"`), label)
  }
  for (const id of ["groupDropdown", "kindDropdown", "statusDropdown"]) {
    assert.match(block, new RegExp(`id: ${id}\\s+anchors\\.left: parent\\.left\\s+anchors\\.right: parent\\.right\\s+anchors\\.bottom: parent\\.bottom`), id)
  }

  // Search sits below the filter row on both tabs, and the key catcher
  // yields to the new dropdown's popup like the others.
  assert.doesNotMatch(panel, /anchors\.left: root\.browsing \? parent\.left : statusFilterControl\.right/)
  assert.doesNotMatch(panel, /function dropdownWidth\(/)
  assert.match(panel, /groupDropdown\.popupOpen/)
})

test("the tab buttons sit in the same place on both tabs; Marketplace goes to their left", () => {
  const panel = readFileSync(new URL("../Panel.qml", import.meta.url), "utf8")

  const tabs = panel.slice(panel.indexOf("id: tabs"), panel.indexOf("id: marketplaceLink"))
  assert.match(tabs, /anchors\.right: refreshButton\.left/)
  assert.doesNotMatch(tabs, /root\.browsing/)

  const marketplace = panel.slice(panel.indexOf("id: marketplaceLink"), panel.indexOf("id: refreshButton"))
  assert.match(marketplace, /anchors\.right: tabs\.left/)
  assert.match(marketplace, /visible: root\.browsing/)
})

test("Marketplace is drawn as a link, in the same idiom as the repository links", () => {
  const panel = readFileSync(new URL("../Panel.qml", import.meta.url), "utf8")
  const link = panel.slice(panel.indexOf("id: marketplaceLink"), panel.indexOf("id: refreshButton"))

  assert.doesNotMatch(link, /^\s*Button \{/m)
  assert.doesNotMatch(link, /bordered: true/)
  assert.match(link, /textFormat: Text\.PlainText/)
  assert.match(link, /text: "󰖟  Marketplace"/)
  assert.match(link, /color: marketplaceMouse\.containsMouse \? Color\.accent : root\.secondaryForeground/)
  assert.match(link, /font\.underline: marketplaceMouse\.containsMouse/)
  assert.match(link, /cursorShape: Qt\.PointingHandCursor/)
  assert.match(link, /PanelToolTip \{\s+visible: marketplaceMouse\.containsMouse/)
  assert.match(link, /onClicked: root\.navigateExternalUrl\("https:\/\/omarchyplugins\.com\/"\)/)
  assert.doesNotMatch(panel, /marketplaceButton/)
})

test("browseFilterHints names the filter when neutral and its value when narrowing", () => {
  const options = {
    category: [{ value: "all", label: "All" }, { value: "Games", label: "Games" }],
    kind: [{ value: "all", label: "All" }, { value: "bar-widget", label: "bar-widget" }],
    availability: Model.catalogAvailabilityOptions(),
    sort: Model.catalogSortOptions()
  }

  assert.deepEqual(Model.browseFilterHints(
    { category: "all", kind: "all", availability: "all", sort: "recently-added" }, options), [
    { key: "c", text: "CATEGORY", active: false },
    { key: "f", text: "KIND", active: false },
    { key: "a", text: "AVAILABILITY", active: false },
    { key: "s", text: "RECENTLY ADDED", active: false }
  ])
  assert.deepEqual(Model.browseFilterHints(
    { category: "Games", kind: "bar-widget", availability: "installed", sort: "stars" }, options), [
    { key: "c", text: "GAMES", active: true },
    { key: "f", text: "BAR-WIDGET", active: true },
    { key: "a", text: "INSTALLED", active: true },
    { key: "s", text: "GITHUB STARS", active: true }
  ])
  // A value the options no longer carry still reads as itself, never blank.
  assert.equal(Model.browseFilterHints({ category: "gone" }, options)[0].text, "GONE")
})

test("installedFilterHints mirrors the Browse row for Source, Kind, and Status", () => {
  const options = {
    group: Model.groupOptions(),
    kind: [{ value: "all", label: "All" }, { value: "service", label: "Service" }],
    status: Model.statusOptions()
  }

  assert.deepEqual(Model.installedFilterHints({ group: "all", kind: "all", status: "all" }, options), [
    { key: "s", text: "SOURCE", active: false },
    { key: "f", text: "KIND", active: false },
    { key: "t", text: "STATUS", active: false }
  ])
  assert.deepEqual(Model.installedFilterHints({ group: "built-in", kind: "service", status: "update" }, options), [
    { key: "s", text: "BUILT-IN", active: true },
    { key: "f", text: "SERVICE", active: true },
    { key: "t", text: "UPDATE", active: true }
  ])
  assert.equal(Model.installedFilterHints({}, options)[0].text, "SOURCE")
})

test("actionHints lists the row actions of each tab in the same hint shape", () => {
  assert.deepEqual(Model.actionHints(true), [
    { key: "↵", text: "DETAILS", active: false },
    { key: "/", text: "SEARCH", active: false }
  ])
  assert.deepEqual(Model.actionHints(false), [
    { key: "↵", text: "UPDATE", active: false },
    { key: "⌦", text: "REMOVE", active: false },
    { key: "/", text: "SEARCH", active: false }
  ])
})

test("verifiedIdSet joins installed rows to the marketplace's verified listings by id", () => {
  const catalog = [
    { id: "acme.weather", verified: true },
    { id: "acme.dev", verified: false },
    { id: "constructor", verified: true },
    { id: "", verified: true }
  ]
  const ids = Model.verifiedIdSet(catalog)
  assert.equal(Model.isVerified({ id: "acme.weather" }, ids), true)
  assert.equal(Model.isVerified({ id: "acme.dev" }, ids), false)
  assert.equal(Model.isVerified({ id: "omarchy.clock" }, ids), false)
  // Untrusted ids never reach prototype machinery.
  assert.equal(Model.isVerified({ id: "constructor" }, ids), true)
  assert.equal(Model.isVerified({ id: "toString" }, ids), false)
  assert.equal(Model.isVerified(null, ids), false)
  assert.equal(Model.isVerified({ id: "acme.weather" }, Model.verifiedIdSet([])), false)
  assert.equal(Model.isVerified({ id: "acme.weather" }, null), false)
})

test("Installed rows wear the marketplace's verified pill beside the name", () => {
  const panel = readFileSync(new URL("../Panel.qml", import.meta.url), "utf8")
  const row = readFileSync(new URL("../PluginRow.qml", import.meta.url), "utf8")

  assert.match(panel, /readonly property var verifiedIds: Model\.verifiedIdSet\(catalog\)/)
  assert.equal(panel.split("verified: Model.isVerified(modelData, root.verifiedIds)").length - 1, 2)
  // The catalog is what knows who is verified, so opening the panel reads it
  // (cache first) even when Browse has never been visited.
  const opened = panel.slice(panel.indexOf("onOpenedChanged: {"), panel.indexOf("// ---- Processes"))
  assert.match(opened, /if \(!catalogLoaded && !catalogLoading\) loadCatalog\(false\)/)

  assert.match(row, /property bool verified: false/)
  const pill = row.slice(row.indexOf("id: verifiedPill"), row.indexOf("id: verifiedPill") + 900)
  assert.match(pill, /visible: root\.verified/)
  assert.match(pill, /text: "󰄬 verified"/)
  assert.match(pill, /color: Color\.accent/)
  assert.match(pill, /textFormat: Text\.PlainText/)
  // The name yields to the pill instead of eliding it off the row.
  assert.match(row, /id: name[\s\S]*?width: Math\.min\(implicitWidth, nameLine\.width - \(verifiedPill\.visible \? verifiedPill\.width \+ nameLine\.spacing : 0\)\)/)
})

test("the header refresh button is display-sized and spins instead of greying while refreshing", () => {
  const panel = readFileSync(new URL("../Panel.qml", import.meta.url), "utf8")
  assert.match(panel, /readonly property bool refreshing: browsing \? catalogLoading : \(loading \|\| checkingUpdates\)/)

  const button = panel.slice(panel.indexOf("id: refreshButton"), panel.indexOf("PanelSeparator {", panel.indexOf("id: refreshButton")))
  assert.match(button, /fontSize: Style\.font\.display/)
  // The button's own glyph steps aside while refreshing; the spinner takes its place.
  assert.match(button, /iconText: root\.refreshing \? "" : "󰑐"/)
  assert.doesNotMatch(button, /opacity: enabled \? 1 : 0\.4/)
  assert.match(button, /opacity: root\.busy \? 0\.4 : 1/)

  const spinner = button.slice(button.indexOf("id: refreshSpinner"))
  assert.match(spinner, /visible: root\.refreshing/)
  assert.match(spinner, /text: "󰑐"/)
  assert.match(spinner, /textFormat: Text\.PlainText/)
  assert.match(spinner, /RotationAnimation on rotation \{[\s\S]*?running: root\.refreshing[\s\S]*?from: 0[\s\S]*?to: 360[\s\S]*?direction: RotationAnimation\.Clockwise[\s\S]*?loops: Animation\.Infinite/)
})

test("the title puzzle piece snaps into place when the panel opens", () => {
  const panel = readFileSync(new URL("../Panel.qml", import.meta.url), "utf8")
  const icon = panel.slice(panel.indexOf("id: titleIcon"), panel.indexOf("id: title\n"))
  assert.match(icon, /transformOrigin: Item\.Center/)
  const intro = icon.slice(icon.indexOf("id: titleIconIntro"))
  assert.match(icon, /SequentialAnimation \{\s*id: titleIconIntro/)
  // Oversized, tilted and invisible on the way in; scale and rotation overshoot
  // so the piece "clicks" home rather than gliding.
  // A beat of stillness first: the popup's own fade-in would otherwise
  // swallow the opening frames. Then a slow, readable snap.
  assert.match(intro, /^\s*PauseAnimation \{ duration: 180 \}/m)
  assert.match(intro, /property: "scale"[\s\S]*?from: 3[\s\S]*?to: 1[\s\S]*?duration: 1000[\s\S]*?easing\.type: Easing\.OutBack/)
  assert.match(intro, /property: "rotation"[\s\S]*?from: -150[\s\S]*?to: 0[\s\S]*?duration: 1000[\s\S]*?easing\.type: Easing\.OutBack/)
  assert.match(intro, /property: "opacity"[\s\S]*?from: 0[\s\S]*?to: 1[\s\S]*?duration: 400/)
  // The settle wiggle always ends upright.
  const wiggle = intro.slice(intro.indexOf("id: titleIconSettle"))
  assert.match(wiggle, /property: "rotation"[\s\S]*?to: 8[\s\S]*?property: "rotation"[\s\S]*?to: -5[\s\S]*?property: "rotation"[\s\S]*?to: 0/)
  // Replayed on every open, and restart (not start) so a quick close/open
  // never leaves the piece mid-flight.
  assert.match(panel, /onOpenedChanged: \{\s*if \(!opened\) \{[^\n]*return \}\s*titleIconIntro\.restart\(\)/)
})

test("the row state bar is a 5px rule", () => {
  const row = readFileSync(new URL("../PluginRow.qml", import.meta.url), "utf8")
  const bar = row.slice(row.indexOf("id: stateBar"), row.indexOf("id: stateBar") + 500)
  assert.match(bar, /width: Style\.space\(5\)/)
})

test("the row's update and remove buttons use the large icon size", () => {
  const row = readFileSync(new URL("../PluginRow.qml", import.meta.url), "utf8")
  const update = row.slice(row.indexOf("id: updateButton"), row.indexOf("PanelActionButton {", row.indexOf("id: updateButton")))
  assert.match(update, /fontSize: Style\.font\.iconLarge/)
  const remove = row.slice(row.indexOf("PanelActionButton {", row.indexOf("id: updateButton")))
  assert.match(remove, /iconText: "󰩹"/)
  assert.match(remove, /fontSize: Style\.font\.iconLarge/)
})

test("a row's update button spins while that row is being updated", () => {
  const panel = readFileSync(new URL("../Panel.qml", import.meta.url), "utf8")
  const row = readFileSync(new URL("../PluginRow.qml", import.meta.url), "utf8")

  // The panel tracks the updating row by id, not by the (non-unique) label.
  assert.match(panel, /property string busyRowId: ""/)
  assert.match(panel, /function startUpdate\(row\) \{[\s\S]*?busyRowId = row\.id[\s\S]*?runAction\("update"/)
  assert.match(panel, /root\.busyId = ""\s+root\.busyRowId = ""/)
  assert.equal(panel.split('updating: root.busyKind === "update" && root.busyRowId === modelData.id').length - 1, 1)

  assert.match(row, /property bool updating: false/)
  const button = row.slice(row.indexOf("id: updateButton"), row.indexOf("PanelActionButton {", row.indexOf("id: updateButton")))
  assert.match(button, /iconText: root\.updating \? "" : "󰑐"/)
  assert.match(button, /opacity: root\.updating \? 1 : \(enabled \? 1 : 0\.4\)/)
  const spinner = button.slice(button.indexOf("id: updateSpinner"))
  assert.match(spinner, /visible: root\.updating/)
  assert.match(spinner, /text: "󰑐"/)
  assert.match(spinner, /color: updateButton\.foreground/)
  assert.match(spinner, /textFormat: Text\.PlainText/)
  assert.match(spinner, /RotationAnimation on rotation \{[\s\S]*?running: root\.updating[\s\S]*?from: 0[\s\S]*?to: 360[\s\S]*?direction: RotationAnimation\.Clockwise[\s\S]*?loops: Animation\.Infinite/)
})

test("upToDate is true only for a checked checkout that is not behind", () => {
  assert.equal(Model.upToDate({ updatable: true, updateChecked: true, behind: false }), true)
  assert.equal(Model.upToDate({ updatable: true, updateChecked: true, behind: true }), false)
  assert.equal(Model.upToDate({ updatable: true, updateChecked: false, behind: false }), false)
  assert.equal(Model.upToDate({ updatable: true }), false)
  assert.equal(Model.upToDate(null), false)
})

test("an up-to-date row's update button is disabled and never spins", () => {
  const panel = readFileSync(new URL("../Panel.qml", import.meta.url), "utf8")
  const row = readFileSync(new URL("../PluginRow.qml", import.meta.url), "utf8")

  assert.match(row, /readonly property bool upToDate: Model\.upToDate\(row\)/)
  const button = row.slice(row.indexOf("id: updateButton"), row.indexOf("PanelActionButton {", row.indexOf("id: updateButton")))
  assert.match(button, /enabled: root\.actionsEnabled && root\.updateEnabled && !root\.upToDate/)
  // Enter on a selected row goes through the same gate.
  assert.match(panel, /function startUpdate\(row\) \{\s+if \(!row \|\| !row\.updatable \|\| Model\.upToDate\(row\) \|\| busy/)
})

test("every keyboard-cycled filter replays its value into its dropdown", () => {
  const panel = readFileSync(new URL("../Panel.qml", import.meta.url), "utf8")
  // A mouse pick assigns Dropdown.value and breaks the binding; a later key
  // cycle must push the filter back in or the dropdown shows a stale choice.
  for (const [filter, dropdown] of [
    ["kindFilter", "kindDropdown"], ["groupFilter", "groupDropdown"], ["statusFilter", "statusDropdown"],
    ["categoryFilter", "categoryDropdown"], ["catalogKindFilter", "catalogKindDropdown"],
    ["availabilityFilter", "availabilityDropdown"], ["catalogSort", "sortDropdown"]
  ]) {
    const handler = "on" + filter[0].toUpperCase() + filter.slice(1) + "Changed"
    assert.match(panel, new RegExp(`${handler}: if \\(${dropdown} && ${dropdown}\\.value !== ${filter}\\)\\s+${dropdown}\\.value = ${filter}`), handler)
  }
})

test("nextOption cycles any option list and nextKind is that same walk", () => {
  const options = Model.catalogSortOptions()
  assert.equal(Model.nextOption(options, "recently-added"), "stars")
  assert.equal(Model.nextOption(options, "name"), "recently-added")
  assert.equal(Model.nextOption(options, "gone"), "recently-added")
  assert.equal(Model.nextKind(options, "hearts"), Model.nextOption(options, "hearts"))
})

test("one hint bar on both tabs: filter hints left, action hints right, keys cycle the dropdowns", () => {
  const panel = readFileSync(new URL("../Panel.qml", import.meta.url), "utf8")

  assert.match(panel, /readonly property var browseFilterHints: Model\.browseFilterHints\(/)
  assert.match(panel, /readonly property var installedFilterHints: Model\.installedFilterHints\(/)
  for (const name of ["cycleCategoryFilter", "cycleCatalogKindFilter", "cycleAvailabilityFilter", "cycleCatalogSort",
                      "cycleGroupFilter", "cycleKindFilter", "cycleStatusFilter"])
    assert.match(panel, new RegExp(`function ${name}\\(\\) \\{\\s+set\\w+\\(Model\\.nextOption\\(`), name)

  const keys = panel.slice(panel.indexOf("onTextKey:"), panel.indexOf("// ---- Fixed chrome"))
  assert.match(keys, /t === "f" \|\| t === "F"\) root\.browsing \? root\.cycleCatalogKindFilter\(\) : root\.cycleKindFilter\(\)/)
  assert.match(keys, /t === "s" \|\| t === "S"\) root\.browsing \? root\.cycleCatalogSort\(\) : root\.cycleGroupFilter\(\)/)
  assert.match(keys, /\(t === "c" \|\| t === "C"\) && root\.browsing\) root\.cycleCategoryFilter\(\)/)
  assert.match(keys, /\(t === "a" \|\| t === "A"\) && root\.browsing\) root\.cycleAvailabilityFilter\(\)/)
  assert.match(keys, /\(t === "t" \|\| t === "T"\) && !root\.browsing\) root\.cycleStatusFilter\(\)/)

  // The old centred hints line is gone; one bar carries both groups.
  assert.doesNotMatch(panel, /id: hints\b/)
  assert.doesNotMatch(panel, /select   ⏎/)
  const bar = panel.slice(panel.indexOf("id: hintBar"), panel.indexOf("id: listScroll"))
  assert.match(bar, /anchors\.bottom: parent\.bottom/)
  assert.match(bar, /PanelSeparator \{/)
  assert.match(bar, /id: filterHints\s+anchors\.left: parent\.left/)
  assert.match(bar, /id: actionHints\s+anchors\.right: parent\.right/)
  assert.match(bar, /model: root\.browsing \? root\.browseFilterHints : root\.installedFilterHints/)
  assert.match(bar, /model: Model\.actionHints\(root\.browsing\)/)
  // One delegate for both groups, keys shown uppercase in the accent.
  assert.equal(bar.split("delegate: hintDelegate").length - 1, 2)
  assert.match(bar, /text: "\[" \+ hint\.modelData\.key\.toUpperCase\(\) \+ "\]"\s+color: Color\.accent/)
  assert.match(bar, /color: hint\.modelData\.active \? root\.contentForeground : root\.secondaryForeground/)
  assert.doesNotMatch(bar, /Text\.RichText|Text\.AutoText|StyledText/)

  // Both scroll regions stop above the bar.
  const grid = panel.slice(panel.indexOf("id: catalogGrid"), panel.indexOf("id: catalogGrid") + 600)
  assert.match(grid, /anchors\.bottom: hintBar\.top/)
  const list = panel.slice(panel.indexOf("id: listScroll"), panel.indexOf("id: listScroll") + 600)
  assert.match(list, /anchors\.bottom: hintBar\.top/)
  assert.doesNotMatch(panel, /hints\.implicitHeight|hints\.top/)
})

test("plugin details lead with the same preview walk the Browse card uses", () => {
  const details = readFileSync(new URL("../PluginDetails.qml", import.meta.url), "utf8")
  const panel = readFileSync(new URL("../Panel.qml", import.meta.url), "utf8")

  assert.match(details, /property bool previewsEnabled: true/)
  assert.match(details, /signal previewUndecodable\(\)/)
  assert.match(details, /readonly property var previewSources: Model\.previewCandidates\(entry, previewsEnabled\)/)
  assert.match(details, /onEntryChanged: previewIndex = 0/)

  // The preview leads the scrolling body: it is the first child of the
  // details column, above the description.
  const bodyStart = details.indexOf("id: detailsContent")
  const previewStart = details.indexOf("id: detailsPreview", bodyStart)
  const descriptionStart = details.indexOf("root.entry.description", bodyStart)
  assert.notEqual(previewStart, -1)
  assert.ok(previewStart < descriptionStart)

  assert.match(details, /id: detailsThumbnail[\s\S]*source: root\.previewSource/)
  assert.match(details,
    /root\.previewSource === \(root\.entry \? root\.entry\.thumbnail : ""\)\) root\.previewUndecodable\(\)/)
  // Never cropped: the frame takes the picture's own aspect once it has
  // loaded (16:9 only as the placeholder tile), and the image fits inside it.
  assert.match(details, /id: detailsThumbnail[\s\S]*fillMode: Image\.PreserveAspectFit/)
  assert.doesNotMatch(details, /id: detailsThumbnail[\s\S]*PreserveAspectCrop/)
  assert.match(details, /id: detailsPreview[\s\S]*height: detailsThumbnail\.status === Image\.Ready && detailsThumbnail\.implicitWidth > 0\s+\? Math\.min\(width, Math\.round\(width \* detailsThumbnail\.implicitHeight \/ detailsThumbnail\.implicitWidth\)\)\s+: Math\.round\(width \* 9 \/ 16\)/)
  assert.match(details, /visible: detailsThumbnail\.status !== Image\.Ready/)
  // The accent tile is only the placeholder: once the picture is up, the
  // gutters around a fitted image are the panel background, not a tint.
  assert.match(details, /id: detailsPreview[\s\S]*color: root\.background/)
  assert.match(details, /gradient: detailsThumbnail\.status === Image\.Ready \? null : previewTileGradient/)
  assert.match(details, /Gradient \{\s+id: previewTileGradient/)

  // One WebP verdict for the whole panel: details report undecodable sources
  // to the same flag the grid does.
  const detailsSection = panel.slice(panel.indexOf("PluginDetails {"), panel.indexOf("ConfirmDialog {"))
  assert.match(detailsSection, /previewsEnabled: root\.previewsSupported/)
  assert.match(detailsSection, /onPreviewUndecodable: root\.previewsSupported = false/)
})

test("catalog cards stay compact while details own complete metadata and actions", () => {
  const panel = readFileSync(new URL("../Panel.qml", import.meta.url), "utf8")
  const card = readFileSync(new URL("../CatalogCard.qml", import.meta.url), "utf8")
  const details = readFileSync(new URL("../PluginDetails.qml", import.meta.url), "utf8")

  assert.match(card, /readonly property int descriptionLines: 3/)
  assert.match(card, /signal detailsRequested\(\)/)
  assert.match(card, /Model\.installBlockedReason\(entry\)/)
  assert.match(card, /id: creator[\s\S]*visible: root\.hasCreator[\s\S]*elide: Text\.ElideRight/)
  assert.match(card, /id: versionAndMetrics[\s\S]*visible: root\.hasVersionOrMetrics/)
  assert.match(card, /readonly property string starCountText: entry \? Model\.starLabel\(entry\.stars\) : ""/)
  assert.match(card, /readonly property string heartCountText: entry \? Model\.starLabel\(entry\.marketplaceHearts\) : ""/)
  assert.doesNotMatch(card, /GH ★|MP ♥/)
  assert.match(card, /id: metricsLabel[\s\S]*anchors\.right: parent\.right/)
  // The glyphs are their own Text so each can carry its own colour and size:
  // a yellow star and a red heart, larger than the caption counts beside them.
  const starIcon = card.slice(card.indexOf("id: starIcon"), card.indexOf("id: starCount"))
  // Nerd Font glyphs, not ★/♥: the mono font lacks ★ (so it fell back to a
  // colour emoji) and its ♥ is hollow. These are filled and stay in-family.
  assert.match(starIcon, /text: "󰓎"/)
  assert.doesNotMatch(starIcon, /anchors\.verticalCenter/)
  assert.match(starIcon, /color: root\.starColor/)
  assert.match(starIcon, /font\.pixelSize: Style\.font\.title/)
  assert.match(starIcon, /textFormat: Text\.PlainText/)
  const heartIcon = card.slice(card.indexOf("id: heartIcon"), card.indexOf("id: heartCount"))
  assert.match(heartIcon, /text: "󰋑"/)
  assert.doesNotMatch(heartIcon, /anchors\.verticalCenter/)
  assert.match(heartIcon, /color: root\.heartColor/)
  assert.match(heartIcon, /font\.pixelSize: Style\.font\.title/)
  assert.match(heartIcon, /textFormat: Text\.PlainText/)
  assert.match(card, /readonly property color starColor: "#f5c518"/)
  assert.match(card, /readonly property color heartColor: "#e5484d"/)
  // Counts sit on the glyph baseline so a 14px icon and a 10px number line up.
  assert.match(card, /id: starCount[\s\S]*?anchors\.baseline: starIcon\.baseline[\s\S]*?text: root\.starCountText[\s\S]*?font\.pixelSize: Style\.font\.caption/)
  assert.match(card, /id: heartCount[\s\S]*?anchors\.baseline: heartIcon\.baseline[\s\S]*?text: root\.heartCountText[\s\S]*?font\.pixelSize: Style\.font\.caption/)
  assert.match(card, /id: versionLabel[\s\S]*width: Math\.max\(0, Math\.min\(implicitWidth, availableWidth\)\)[\s\S]*elide: Text\.ElideRight/)
  assert.match(card, /creator\.height \+ versionAndMetrics\.height[\s\S]*creator\.visible && versionAndMetrics\.visible \? spacing : 0/)
  for (const label of [
    "Author", "Version", "Category", "Kind", "License", "GitHub stars",
    "Marketplace hearts", "Marketplace review", "Availability", "Placement"
  ]) assert.match(details, new RegExp(`label: "${label}"`), label)
  assert.match(details, /entry\.description/)
  assert.match(details, /entry\.categoryPresent === true && entry\.category !== ""/)
  assert.match(details, /Model\.installBlockedReason\(entry\)/)
  assert.match(details, /plugins run unsandboxed inside omarchy-shell/)
  assert.match(details, /kind: "repository"/)
  assert.match(details, /kind: "release"/)
  assert.match(details, /kind: "install"/)
  assert.match(panel, /readonly property real compactContentWidth: cellWidth\s+- compactDelegateMargin \* 2 - compactCardPadding \* 2/)
  assert.match(panel, /readonly property real compactActionHeight: Math\.max\(\s+Style\.space\(22\), Style\.font\.icon \+ Style\.spacing\.sm \* 2\)/)
  assert.match(card, /readonly property real footerHeight: Math\.max\(footerMetadataHeight, actionRow\.implicitHeight\)/)
  // The action buttons line up with the version/metrics line, not the middle
  // of the two-line metadata block, so they no longer float between the lines.
  const actionRow = card.slice(card.indexOf("id: actionRow"), card.indexOf("PanelActionButton {", card.indexOf("id: actionRow")))
  assert.doesNotMatch(actionRow, /anchors\.verticalCenter/)
  assert.match(actionRow, /y: metadata\.visible\s*\? metadata\.y \+ versionAndMetrics\.y \+ \(versionAndMetrics\.height - height\) \/ 2\s*: \(parent\.height - height\) \/ 2/)
  assert.match(card, /readonly property real requiredHeight: topContent\.implicitHeight \+ contentFooterGap\s+\+ footerHeight \+ contentPadding \* 2/)
  assert.match(panel, /readonly property real compactFooterHeight: Math\.max\(/)
  assert.match(panel, /Math\.ceil\(cardTextMetrics\.lineSpacing \* 4\)/)
  assert.match(panel, /\+ compactFooterHeight\s+\+ compactContentSpacing \* 4\s+\+ compactCardPadding \* 2\s+\+ compactDelegateMargin \* 2/)
  assert.match(card, /id: topContent[\s\S]*anchors\.top: parent\.top/)
  assert.match(card,
    /id: flexibleFooterGap[\s\S]*anchors\.top: topContent\.bottom[\s\S]*anchors\.topMargin: root\.contentFooterGap[\s\S]*anchors\.bottom: footer\.top/)
  assert.match(card,
    /id: footer[\s\S]*anchors\.bottom: parent\.bottom[\s\S]*height: root\.footerHeight/)
  const delegateStart = panel.indexOf("delegate: Item {", panel.indexOf("id: catalogGrid"))
  const delegateEnd = panel.indexOf("// Empty and loading", delegateStart)
  const delegate = panel.slice(delegateStart, delegateEnd)
  assert.match(delegate, /width: catalogGrid\.cellWidth\s+height: catalogGrid\.cellHeight/)
  assert.match(delegate, /CatalogCard \{[\s\S]*anchors\.fill: parent[\s\S]*anchors\.margins: Style\.space\(4\)/)
  assert.doesNotMatch(delegate, /height: catalogCard\.requiredHeight/)
})

test("Browse details and filters wire keyboard interaction through guarded modal ownership", () => {
  const panel = readFileSync(new URL("../Panel.qml", import.meta.url), "utf8")
  const details = readFileSync(new URL("../PluginDetails.qml", import.meta.url), "utf8")
  const choice = readFileSync(new URL("../ChoiceDialog.qml", import.meta.url), "utf8")

  assert.match(panel, /onActivateRequested: root\.browsing \? root\.openDetails\(root\.selectedEntry\)/)
  assert.match(panel, /onDetailsRequested:[\s\S]*root\.openDetails\(modelData\)/)
  assert.match(panel, /text: "Clear filters"[\s\S]*onClicked: root\.clearCatalogFilters\(\)/)
  assert.match(panel, /Model\.filterCatalog\(\s*catalog, categoryFilter, catalogKindFilter, availabilityFilter, searchQuery\)/)
  assert.match(panel, /Model\.sortCatalog\(filteredCatalog, catalogSort\)/)
  assert.match(details, /Qt\.Key_Escape/)
  assert.match(details, /Qt\.Key_Tab/)
  assert.match(details, /Qt\.Key_Return \|\| event\.key === Qt\.Key_Enter/)
  assert.match(details, /selected \? Color\.accent/)
  assert.match(choice, /Qt\.Key_Escape/)
  assert.match(choice, /Qt\.Key_Return \|\| event\.key === Qt\.Key_Enter/)

  const restoreStart = panel.indexOf("function returnFocusToList()")
  const restoreEnd = panel.indexOf("\n  }", restoreStart)
  const restore = panel.slice(restoreStart, restoreEnd)
  assert.match(restore, /root\.opened/)
  assert.match(restore, /Model\.browseModalFocusOwner\(root\.detailsOpen, root\.confirming, root\.placing\) === "list"/)
  assert.match(restore, /keyCatcher\.forceActiveFocus\(\)/)
  const modalSections = [
    panel.slice(panel.indexOf("PluginDetails {"), panel.indexOf("ConfirmDialog {")),
    panel.slice(panel.indexOf("ConfirmDialog {"), panel.indexOf("ChoiceDialog {")),
    panel.slice(panel.indexOf("ChoiceDialog {"))
  ]
  for (const section of modalSections)
    assert.match(section, /onOpenedChanged:[\s\S]*else root\.returnFocusToList\(\)/)
  assert.doesNotMatch(panel, /else Qt\.callLater\(function\(\) \{ if \(keyCatcher\)/)
  assert.match(panel, /id: confirm[\s\S]*confirm\.handleKey\(event\)/)
  assert.match(panel, /id: placement[\s\S]*placement\.handleKey\(event\)/)
  // These source checks prove the QML wiring only. The ownership truth table
  // above is the executable behavior seam; a live focus runtime remains a
  // separate integration boundary.
})

test("Panel keeps open details synchronized with catalog install state", () => {
  const panel = readFileSync(new URL("../Panel.qml", import.meta.url), "utf8")
  assert.match(panel,
    /var stampedState = Model\.restampCatalogInstallState\(\s*catalog, Model\.installedIdSet\(rows\), detailsEntry\)/)
  assert.match(panel, /catalog = stampedState\.entries/)
  assert.match(panel, /if \(detailsEntry\) detailsEntry = stampedState\.detailsEntry/)
  assert.match(panel, /var loadedCatalog = Model\.catalogEntries\(doc, Model\.installedIdSet\(rows\)\)/)
  assert.match(panel, /if \(detailsEntry\) detailsEntry = Model\.findRow\(loadedCatalog, detailsEntry\.id\)/)
})

test("add confirmation never promises placement after cloning", () => {
  const panel = readFileSync(new URL("../Panel.qml", import.meta.url), "utf8")
  assert.match(panel, /Model\.catalogPlacementConfirmationNote\(pendingPlacementNeeded\)/)
  assert.doesNotMatch(panel, /asked where to put it once it is cloned|where to put it once it is cloned/)
})

test("catalog projection joins the Marketplace engagement hearts endpoint by plugin id", () => {
  const model = readFileSync(new URL("../Model.js", import.meta.url), "utf8")
  const panel = readFileSync(new URL("../Panel.qml", import.meta.url), "utf8")

  assert.match(model, /MARKETPLACE_STATS_URL = "https:\/\/api\.omarchyplugins\.com\/v1\/stats"/)
  assert.match(panel, /Model\.MARKETPLACE_STATS_URL/)
  assert.match(panel, /marketplaceHearts: \(\$stats\[0\]\.plugins\[\$plugin\.id\]\.hearts \/\/ null\)/)
  assert.match(panel, /stars,addedAt,listedAt,marketplaceHearts:/)
  assert.match(panel, /projectionSchemaVersion: \$schema/)
  assert.match(panel, /printf '%s' '\{\\"plugins\\":\{\}\}'/)
})

test("catalog producer replaces a fresh legacy cache despite its age", () => {
  const root = mkdtempSync(join(tmpdir(), "plugin-catalog-legacy-refresh-test-"))
  const home = join(root, "home"), catalogPath = join(root, "catalog.json")
  const statsPath = join(root, "stats.json")
  const legacy = JSON.stringify({ generatedAt: "legacy", plugins: [{ id: "legacy" }] })
  try {
    mkdirSync(home, { recursive: true })
    const cachePath = catalogCache(home, legacy)
    writeFileSync(catalogPath, JSON.stringify({
      generatedAt: "remote",
      plugins: [{ id: "acme.clock", addedAt: "2026-08-20", listedAt: "2026-08-20T12:34:56.789Z" }]
    }))
    writeFileSync(statsPath, JSON.stringify({ plugins: {} }))

    const result = runCatalogScript(home, catalogPath, statsPath, "0")
    assert.equal(result.status, 0, result.stderr)
    const projected = JSON.parse(result.stdout)
    assert.equal(projected.projectionSchemaVersion, CATALOG_PROJECTION_SCHEMA_VERSION)
    assert.equal(projected.generatedAt, "remote")
    assert.equal(readFileSync(cachePath, "utf8"), result.stdout)
    assert.notEqual(result.stdout, legacy)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("catalog producer atomically replaces through a destination-local temp file", () => {
  const root = mkdtempSync(join(tmpdir(), "plugin-catalog-atomic-replace-test-"))
  const home = join(root, "home"), catalogPath = join(root, "catalog.json")
  const statsPath = join(root, "stats.json"), bin = join(root, "bin"), moveLog = join(root, "move.log")
  const cacheDir = join(home, ".cache", "omarchy-plugin-manager")
  const cachePath = join(cacheDir, "catalog.json")
  try {
    mkdirSync(home, { recursive: true })
    mkdirSync(bin)
    writeFileSync(join(bin, "mv"), `#!/usr/bin/env bash
source_path="$1"
destination_path="$2"
printf '%s\n' "$source_path" "$destination_path" > "$MV_LOG"
stat -c '%d' -- "$source_path" >> "$MV_LOG"
stat -c '%d' -- "\${destination_path%/*}" >> "$MV_LOG"
exec /usr/bin/mv "$@"
`)
    chmodSync(join(bin, "mv"), 0o755)
    writeFileSync(catalogPath, JSON.stringify({
      generatedAt: "remote",
      plugins: [{ id: "acme.clock", addedAt: "2026-08-20", listedAt: "2026-08-20T12:34:56.789Z" }]
    }))
    writeFileSync(statsPath, JSON.stringify({ plugins: {} }))

    const result = runCatalogScript(home, catalogPath, statsPath, "1", {
      PATH: `${bin}:${process.env.PATH}`,
      MV_LOG: moveLog
    })
    assert.equal(result.status, 0, result.stderr)
    const [sourcePath, destinationPath, sourceDevice, destinationDevice] =
      readFileSync(moveLog, "utf8").trimEnd().split("\n")
    assert.equal(sourcePath.startsWith(`${cacheDir}/.catalog.json.tmp.`), true)
    assert.equal(destinationPath, cachePath)
    assert.equal(sourceDevice, destinationDevice)
    assert.deepEqual(catalogProjectionTemps(home), [])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("catalog producer fails closed when atomic publication fails", () => {
  const root = mkdtempSync(join(tmpdir(), "plugin-catalog-publication-failure-test-"))
  const home = join(root, "home"), catalogPath = join(root, "catalog.json")
  const statsPath = join(root, "stats.json"), bin = join(root, "bin")
  const legacy = JSON.stringify({ generatedAt: "legacy", plugins: [{ id: "legacy" }] })
  try {
    mkdirSync(home, { recursive: true })
    mkdirSync(bin)
    writeFileSync(join(bin, "mv"), `#!/usr/bin/env bash
exit 73
`)
    chmodSync(join(bin, "mv"), 0o755)
    const cachePath = catalogCache(home, legacy)
    writeFileSync(catalogPath, JSON.stringify({
      generatedAt: "remote",
      plugins: [{ id: "acme.clock", addedAt: "2026-08-20", listedAt: "2026-08-20T12:34:56.789Z" }]
    }))
    writeFileSync(statsPath, JSON.stringify({ plugins: {} }))

    const result = runCatalogScript(home, catalogPath, statsPath, "1", {
      PATH: `${bin}:${process.env.PATH}`
    })
    assert.equal(result.status, 1, result.stderr)
    assert.equal(result.stdout, "")
    assert.equal(readFileSync(cachePath, "utf8"), legacy)
    assert.deepEqual(catalogProjectionTemps(home), [])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("catalog producer reuses a compatible fresh cache", () => {
  const root = mkdtempSync(join(tmpdir(), "plugin-catalog-compatible-cache-test-"))
  const home = join(root, "home"), missingCatalog = join(root, "missing.json")
  const missingStats = join(root, "missing-stats.json")
  const cached = JSON.stringify({
    projectionSchemaVersion: CATALOG_PROJECTION_SCHEMA_VERSION,
    generatedAt: "cached",
    plugins: [{ id: "cached", addedAt: null, listedAt: null }]
  })
  try {
    mkdirSync(home, { recursive: true })
    catalogCache(home, cached)

    const result = runCatalogScript(home, missingCatalog, missingStats, "0")
    assert.equal(result.status, 0, result.stderr)
    assert.equal(result.stdout, cached)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("catalog producer rejects incompatible cache contracts when refresh fails", async t => {
  for (const scenario of [
    {
      name: "legacy cache without schema",
      value: { generatedAt: "legacy", plugins: [{ id: "legacy" }] }
    },
    {
      name: "wrong projection schema",
      value: { projectionSchemaVersion: 2, generatedAt: "wrong", plugins: [] }
    },
    {
      name: "plugins is not an array",
      value: { projectionSchemaVersion: CATALOG_PROJECTION_SCHEMA_VERSION, generatedAt: "wrong", plugins: {} }
    }
  ]) await t.test(scenario.name, () => {
    const root = mkdtempSync(join(tmpdir(), "plugin-catalog-incompatible-cache-test-"))
    const home = join(root, "home"), missingCatalog = join(root, "missing.json")
    const statsPath = join(root, "stats.json"), cached = JSON.stringify(scenario.value)
    try {
      mkdirSync(home, { recursive: true })
      const cachePath = catalogCache(home, cached)
      writeFileSync(statsPath, JSON.stringify({ plugins: {} }))

      const result = runCatalogScript(home, missingCatalog, statsPath, "0")
      assert.equal(result.status, 1, result.stderr)
      assert.equal(result.stdout, "")
      assert.equal(readFileSync(cachePath, "utf8"), cached)
      assert.deepEqual(catalogProjectionTemps(home), [])
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})

test("catalog producer rejects an oversized catalog and serves the bounded cache", () => {
  const root = mkdtempSync(join(tmpdir(), "plugin-catalog-limit-test-"))
  const home = join(root, "home"), catalogPath = join(root, "catalog.json")
  const statsPath = join(root, "stats.json")
  const cached = JSON.stringify({
    projectionSchemaVersion: CATALOG_PROJECTION_SCHEMA_VERSION,
    generatedAt: "cached",
    plugins: [{ id: "cached", addedAt: null, listedAt: null }]
  })
  try {
    mkdirSync(home, { recursive: true })
    const cachePath = catalogCache(home, cached)
    writeFileSync(catalogPath, JSON.stringify({
      generatedAt: "remote",
      plugins: [{ id: "oversized", description: "x".repeat(CATALOG_DOWNLOAD_LIMIT) }]
    }))
    writeFileSync(statsPath, JSON.stringify({ plugins: {} }))

    const result = runCatalogScript(home, catalogPath, statsPath)
    assert.equal(result.status, 0, result.stderr)
    assert.equal(result.stdout, cached)
    assert.equal(readFileSync(cachePath, "utf8"), cached)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("catalog producer joins valid stats and treats unavailable inputs as missing", async t => {
  for (const scenario of [
    {
      name: "valid stats",
      stats: JSON.stringify({ plugins: { "acme.clock": { hearts: 42 } } }),
      expectedHearts: 42
    },
    {
      name: "oversized stats",
      stats: JSON.stringify({ plugins: { "acme.clock": { hearts: 42 } }, padding: "x".repeat(STATS_DOWNLOAD_LIMIT) }),
      expectedHearts: null
    },
    { name: "malformed stats", stats: "{not-json", expectedHearts: null },
    { name: "missing stats", stats: null, expectedHearts: null }
  ]) await t.test(scenario.name, () => {
    const root = mkdtempSync(join(tmpdir(), "plugin-stats-limit-test-"))
    const home = join(root, "home"), catalogPath = join(root, "catalog.json")
    const statsPath = join(root, "stats.json")
    try {
      mkdirSync(home, { recursive: true })
      writeFileSync(catalogPath, JSON.stringify({
        generatedAt: "remote",
        plugins: [{
          id: "acme.clock", name: "Clock", addedAt: "2026-08-20",
          listedAt: "2026-08-20T12:34:56.789Z"
        }]
      }))
      if (scenario.stats !== null) writeFileSync(statsPath, scenario.stats)

      const result = runCatalogScript(home, catalogPath, statsPath)
      assert.equal(result.status, 0, result.stderr)
      const projection = JSON.parse(result.stdout)
      const projected = projection.plugins[0]
      assert.equal(projection.projectionSchemaVersion, CATALOG_PROJECTION_SCHEMA_VERSION)
      assert.equal(projected.marketplaceHearts, scenario.expectedHearts)
      assert.equal(projected.addedAt, "2026-08-20")
      assert.equal(projected.listedAt, "2026-08-20T12:34:56.789Z")
      assert.equal(readFileSync(join(home, ".cache", "omarchy-plugin-manager", "catalog.json"), "utf8"), result.stdout)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})

test("catalog producer bounds projection amplification before replacing the cache", () => {
  const root = mkdtempSync(join(tmpdir(), "plugin-projection-limit-test-"))
  const home = join(root, "home"), catalogPath = join(root, "catalog.json")
  const statsPath = join(root, "stats.json")
  const cached = JSON.stringify({
    projectionSchemaVersion: CATALOG_PROJECTION_SCHEMA_VERSION,
    generatedAt: "cached",
    plugins: [{ id: "cached", addedAt: null, listedAt: null }]
  })
  try {
    mkdirSync(home, { recursive: true })
    const cachePath = catalogCache(home, cached)
    const plugins = Array.from({ length: 40_000 }, () => ({ id: "repeat" }))
    const catalog = JSON.stringify({ generatedAt: "remote", plugins })
    assert.ok(catalog.length < CATALOG_DOWNLOAD_LIMIT)
    writeFileSync(catalogPath, catalog)
    writeFileSync(statsPath, JSON.stringify({ plugins: {} }))

    const result = runCatalogScript(home, catalogPath, statsPath)
    assert.equal(result.status, 0, result.stderr)
    assert.equal(result.stdout, cached)
    assert.equal(readFileSync(cachePath, "utf8"), cached)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("catalog producer never emits an oversized pre-existing cache", () => {
  const root = mkdtempSync(join(tmpdir(), "plugin-cache-limit-test-"))
  const home = join(root, "home"), missingCatalog = join(root, "missing.json")
  const statsPath = join(root, "stats.json")
  try {
    mkdirSync(home, { recursive: true })
    catalogCache(home, "x".repeat(CATALOG_PROJECTION_LIMIT + 1))
    writeFileSync(statsPath, JSON.stringify({ plugins: {} }))

    const result = runCatalogScript(home, missingCatalog, statsPath)
    assert.equal(result.status, 1, result.stderr)
    assert.equal(result.stdout, "")
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("secondary text uses one panel-derived foreground without brightening disabled chrome", () => {
  const panel = readFileSync(new URL("../Panel.qml", import.meta.url), "utf8")
  const pluginRow = readFileSync(new URL("../PluginRow.qml", import.meta.url), "utf8")
  const catalogCard = readFileSync(new URL("../CatalogCard.qml", import.meta.url), "utf8")
  const pluginDetails = readFileSync(new URL("../PluginDetails.qml", import.meta.url), "utf8")

  assert.match(panel,
    /readonly property color secondaryForeground: Util\.alpha\(contentForeground, 0\.54\)/)
  assert.equal(panel.split("placeholderTextColor: root.secondaryForeground").length - 1, 1)
  assert.equal(panel.split("secondaryForeground: root.secondaryForeground").length - 1, 4)
  assert.ok(panel.split("color: root.secondaryForeground").length - 1 >= 8)

  assert.match(pluginRow, /required property color secondaryForeground/)
  assert.match(pluginRow,
    /color: versionMouse\.containsMouse \? Color\.accent : root\.secondaryForeground/)
  assert.match(pluginRow,
    /color: repoMouse\.containsMouse \? Color\.accent : root\.secondaryForeground/)
  assert.match(pluginRow,
    /color: Model\.hasDescription\(root\.row\) \? root\.foreground : root\.secondaryForeground/)
  assert.match(pluginRow, /color: Color\.muted\s+opacity: 0\.35/)
  assert.match(pluginRow, /opacity: root\.canToggle \? 1 : 0\.4/)

  assert.match(catalogCard, /required property color secondaryForeground/)
  assert.match(catalogCard, /opacity: enabled \? 1 : 0\.45/)
  assert.match(pluginDetails, /required property color secondaryForeground/)
})

test("release probe uses fixed bounded curl argv and returns only the HTTP status", () => {
  const root = mkdtempSync(join(tmpdir(), "plugin-release-probe-test-"))
  const curl = join(root, "curl"), argvLog = join(root, "argv")
  const api = "https://api.github.com/repos/acme/thing/releases/tags/v1.2.0"
  try {
    writeFileSync(curl, `#!/usr/bin/env bash
printf '%s\\n' "$@" > "$PROBE_ARGV"
printf '%s' "$PROBE_CODE"
exit "$PROBE_EXIT"
`)
    chmodSync(curl, 0o755)
    const command = Model.releaseProbeCommand(api)
    assert.deepEqual(command, [
      "curl", "--silent", "--show-error", "--output", "/dev/null",
      "--request", "GET", "--connect-timeout", "3", "--max-time", "5",
      "--header", "Accept: application/vnd.github+json",
      "--header", "X-GitHub-Api-Version: 2022-11-28",
      "--write-out", "%{http_code}", api
    ])
    assert.deepEqual(Model.releaseProbeCommand("https://evil.test"), [])

    const run = (code, exit) => spawnSync(command[0], command.slice(1), {
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${root}:${process.env.PATH}`,
        PROBE_ARGV: argvLog,
        PROBE_CODE: code,
        PROBE_EXIT: String(exit)
      }
    })
    let result = run("200", 0)
    assert.equal(result.status, 0)
    assert.equal(result.stdout, "200")
    assert.deepEqual(readFileSync(argvLog, "utf8").trim().split("\n"), command.slice(1))

    result = run("404", 0)
    assert.equal(result.stdout, "404")
    result = run("000", 28)
    assert.equal(result.status, 28)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("versionLabel stays silent when no version is known", () => {
  assert.equal(Model.versionLabel({ localVersion: "1.2.3" }), "v1.2.3")
  assert.equal(Model.versionLabel({ localVersion: "v1.2.3" }), "v1.2.3")
  assert.equal(Model.versionLabel({ localVersion: "  " }), "")
  assert.equal(Model.versionLabel({}), "")
})

test("countBehind counts only rows a check actually found behind", () => {
  assert.equal(Model.countBehind(Model.applyUpdateReport(baseRows, report)), 1)
  assert.equal(Model.countBehind([
    { behind: true },
    { behind: false },
    { behind: "unknown" },
    { behind: 1 },
    null
  ]), 1)
  assert.equal(Model.countBehind([]), 0)
})

test("bar update dot projects the panel's confirmed count without changing button behavior", () => {
  const barWidget = readFileSync(new URL("../BarWidget.qml", import.meta.url), "utf8")

  assert.match(barWidget,
    /readonly property int updateCount: panelLoader\.item \? panelLoader\.item\.behindCount : 0/)
  assert.match(barWidget, /visible: root\.updateCount > 0/)
  assert.match(barWidget,
    /anchors\.right: button\.right\s+anchors\.rightMargin: Style\.space\(3\)\s+anchors\.top: button\.top\s+anchors\.topMargin: Style\.space\(5\)/)
  assert.match(barWidget,
    /width: Style\.space\(6\)\s+height: width\s+radius: width \/ 2\s+color: Color\.accent/)
  assert.doesNotMatch(barWidget, /id: badgeLabel|String\(root\.updateCount\)/)
  assert.match(barWidget, /enabled: false/)
  const tooltipExpression = /tooltipText:\s*(.+)/.exec(barWidget)?.[1]
  assert.ok(tooltipExpression)
  const tooltipText = new Function("root", `return ${tooltipExpression}`)
  assert.equal(tooltipText({ updateCount: 0 }), "Plugins")
  assert.equal(tooltipText({ updateCount: 2 }), "Plugins - 2 to update")
  assert.equal(tooltipText({ updateCount: 12 }), "Plugins - 12 to update")
  assert.match(barWidget,
    /if \(b === Qt\.MiddleButton\) root\.refresh\(\)\s+else root\.togglePanel\(\)/)
})
