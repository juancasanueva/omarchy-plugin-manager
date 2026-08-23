// Model.js is loaded by QML, so it has no module system of its own. Reading
// and evaluating the source keeps the shipped file free of node-isms while
// still letting the parsing rules be tested outside a running shell.
import { spawnSync } from "node:child_process"
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
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
    matchesQuery, filterRows, isFiltering, emptyMessage,
    parseCatalog, catalogEntries, installedIdSet, installUrlFor, markInstalled, plainText,
    catalogAssetUrl,
    catalogCategories, filterCatalog, matchesCatalogQuery, catalogEmptyMessage,
    installState, installBlockedReason, starLabel, accentColor, installedTint,
    repoShortLabel, browsableUrl, repoWebUrl, rowRepoUrl,
    normalizedManifestVersion, githubReleaseCandidates, versionReleaseCandidates,
    versionFallbackUrl, repoPreviewUrl, previewCandidates,
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
    catalogNeedsPlacement
  }`
)()

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

test("statusOptions exposes exactly All, Enabled, and Disabled", () => {
  assert.deepEqual(Model.statusOptions(), [
    { value: "all", label: "All" },
    { value: "enabled", label: "Enabled" },
    { value: "disabled", label: "Disabled" }
  ])
})

test("filterRows applies status, kind, and search together", () => {
  const rows = Model.mergePlugins(listEntries, catalogEntries, gitMap)

  assert.deepEqual(Model.filterRows(rows, "all", "all", "").map(r => r.id), ["acme.dev", "acme.weather", "omarchy.clock"])
  assert.deepEqual(Model.filterRows(rows, "all", "enabled", "").map(r => r.id), ["acme.weather", "omarchy.clock"])
  assert.deepEqual(Model.filterRows(rows, "all", "disabled", "").map(r => r.id), ["acme.dev"])
  assert.deepEqual(Model.filterRows(rows, "all", "enabled", "acme").map(r => r.id), ["acme.weather"])
  assert.deepEqual(Model.filterRows(rows, "bar-widget", "enabled", "acme").map(r => r.id), ["acme.weather"])
  assert.deepEqual(Model.filterRows(rows, "service", "disabled", "dev").map(r => r.id), ["acme.dev"])
  assert.deepEqual(Model.filterRows(rows, "service", "enabled", "weather").map(r => r.id), [])
})

test("status filtering preserves both section classes and their flat selection order", () => {
  const rows = Model.mergePlugins([
    { id: "z.installed-on", name: "Zed", kinds: ["service"], enabled: true, firstParty: false },
    { id: "a.installed-off", name: "Alpha", kinds: ["service"], enabled: false, firstParty: false },
    { id: "z.builtin-on", name: "Zulu", kinds: ["service"], enabled: true, firstParty: true },
    { id: "a.builtin-off", name: "Able", kinds: ["service"], enabled: false, firstParty: true }
  ], [], {})
  const filtered = Model.filterRows(rows, "service", "disabled", "a")
  const rejoined = [...Model.rowsInGroup(filtered, "installed"), ...Model.rowsInGroup(filtered, "built-in")]

  assert.deepEqual(Model.filterByStatus(rows, "all").map(r => r.id), rows.map(r => r.id))
  assert.deepEqual(rejoined.map(r => r.id), ["a.installed-off", "a.builtin-off"])
  assert.deepEqual(rejoined.map(r => r.group), ["installed", "built-in"])
  assert.deepEqual(rejoined.map(r => r.id), filtered.map(r => r.id))
})

test("isFiltering includes status and clears only when all controls are neutral", () => {
  assert.equal(Model.isFiltering("all", "all", ""), false)
  assert.equal(Model.isFiltering("all", "all", "   "), false)
  assert.equal(Model.isFiltering("service", "all", ""), true)
  assert.equal(Model.isFiltering("all", "enabled", ""), true)
  assert.equal(Model.isFiltering("all", "disabled", ""), true)
  assert.equal(Model.isFiltering("all", "all", "clock"), true)
})

test("emptyMessage names every active exclusion, including status", () => {
  assert.equal(Model.emptyMessage("all", "all", "zzz"), "No plugins match “zzz”.")
  assert.equal(Model.emptyMessage("service", "all", "zzz"), "No service plugins match “zzz”.")
  assert.equal(Model.emptyMessage("all", "disabled", "zzz"), "No disabled plugins match “zzz”.")
  assert.equal(Model.emptyMessage("service", "disabled", "zzz"), "No disabled service plugins match “zzz”.")
  assert.equal(Model.emptyMessage("service", "enabled", ""), "No enabled service plugins found.")
  assert.equal(Model.emptyMessage("all", "disabled", ""), "No disabled plugins found.")
  assert.equal(Model.emptyMessage("bar-widget", "all", ""), "No bar-widget plugins found.")
  assert.equal(Model.emptyMessage("all", "all", ""), "No plugins found.")
})

// ---- Marketplace catalog ---------------------------------------------------

const catalogDoc = {
  generatedAt: "2026-08-20T21:33:17.660Z",
  plugins: [
    {
      id: "acme.weather", name: "Weather", description: "Forecast in the bar",
      author: "acme", category: "Widgets", kind: "Bar widget",
      repo: "https://github.com/acme/omarchy-weather",
      installCommand: "omarchy plugin add https://github.com/acme/omarchy-weather.git --enable",
      installAvailable: true, verificationStatus: "verified", sourceType: "community",
      stars: 120, accent: "cyan", initials: "WE", previewThumbnail: "assets/img/w-card.webp"
    },
    {
      id: "acme.suite", name: "Suite", description: "A whole shell",
      author: "acme", category: "Desktop", kind: "Suite",
      repo: "https://github.com/acme/suite", installCommand: "",
      installAvailable: false, installNote: "This repository has its own installer.",
      verificationStatus: "unverified", sourceType: "community",
      stars: 9, accent: "violet", initials: "SU"
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

test("catalogEntries sorts by popularity, not alphabetically", () => {
  const entries = Model.catalogEntries(catalogDoc, {})
  assert.deepEqual(entries.map(e => e.stars), [120, 9])
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

test("installedIdSet indexes the installed rows by id", () => {
  const set = Model.installedIdSet([{ id: "a.b" }, { id: "c.d" }, null])
  assert.ok(Object.prototype.hasOwnProperty.call(set, "a.b"))
  assert.ok(Object.prototype.hasOwnProperty.call(set, "c.d"))
  assert.equal(Object.keys(set).length, 2)
})

test("catalog search covers author and description, unlike the installed search", () => {
  // Browsing is how you find something you cannot already name.
  const entry = { name: "Weather", id: "acme.weather", author: "acme", description: "Forecast in the bar" }
  assert.equal(Model.matchesCatalogQuery(entry, "forecast"), true)
  assert.equal(Model.matchesCatalogQuery(entry, "acme"), true)
  assert.equal(Model.matchesCatalogQuery(entry, "zzz"), false)
})

test("filterCatalog applies category and query together", () => {
  const entries = Model.catalogEntries(catalogDoc, {})
  assert.equal(Model.filterCatalog(entries, "all", "").length, 2)
  assert.equal(Model.filterCatalog(entries, "Widgets", "").length, 1)
  assert.equal(Model.filterCatalog(entries, "Widgets", "suite").length, 0)
  assert.equal(Model.filterCatalog(entries, "all", "suite").length, 1)
})

test("catalogCategories is derived from the catalog and led by All", () => {
  const entries = Model.catalogEntries(catalogDoc, {})
  assert.deepEqual(Model.catalogCategories(entries).map(o => o.value), ["all", "Desktop", "Widgets"])
})

test("catalogEmptyMessage names what excluded everything", () => {
  assert.match(Model.catalogEmptyMessage("all", "zzz"), /No plugins match “zzz”/)
  assert.match(Model.catalogEmptyMessage("Widgets", "zzz"), /No Widgets plugins match “zzz”/)
  assert.match(Model.catalogEmptyMessage("Widgets", ""), /No Widgets plugins in the catalog/)
})

test("starLabel keeps big counts short", () => {
  assert.equal(Model.starLabel(0), "0")
  assert.equal(Model.starLabel(999), "999")
  assert.equal(Model.starLabel(1200), "1.2k")
  assert.equal(Model.starLabel(undefined), "0")
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

test("repository and Marketplace delegates route browser ownership through Panel", () => {
  const panel = readFileSync(new URL("../Panel.qml", import.meta.url), "utf8")
  const pluginRow = readFileSync(new URL("../PluginRow.qml", import.meta.url), "utf8")
  const catalogCard = readFileSync(new URL("../CatalogCard.qml", import.meta.url), "utf8")

  for (const delegate of [pluginRow, catalogCard]) {
    assert.doesNotMatch(delegate, /Quickshell\.execDetached/)
    assert.match(delegate, /signal repositoryNavigationRequested\(string url\)/)
    assert.match(delegate, /repositoryNavigationRequested\(repoUrl\)/)
  }
  assert.equal(panel.split('Quickshell.execDetached(["omarchy-launch-browser", trusted])').length - 1, 1)
  assert.equal(panel.split("onRepositoryNavigationRequested:").length - 1, 3)
  assert.match(panel, /onClicked: root\.navigateExternalUrl\("https:\/\/omarchyplugins\.com\/"\)/)
  assert.match(panel, /onCloseRequested: \{ root\.revokeReleaseNavigation\(\); root\.close\(\) \}/)
  assert.match(panel, /onTabRequested: function\(direction\) \{ root\.revokeReleaseNavigation\(\); root\.switchPanel\(direction\) \}/)

  for (const name of [
    "switchTab", "reload", "loadCatalog", "askInstall", "askAdd",
    "askRemove", "askEnable", "askDisable", "startUpdate"
  ]) {
    const start = panel.indexOf(`function ${name}(`)
    const end = panel.indexOf("\n  }", start)
    assert.notEqual(start, -1, name)
    assert.match(panel.slice(start, end), /revokeReleaseNavigation\(\)/, name)
  }
})

test("secondary text uses one panel-derived foreground without brightening disabled chrome", () => {
  const panel = readFileSync(new URL("../Panel.qml", import.meta.url), "utf8")
  const pluginRow = readFileSync(new URL("../PluginRow.qml", import.meta.url), "utf8")
  const catalogCard = readFileSync(new URL("../CatalogCard.qml", import.meta.url), "utf8")

  assert.match(panel,
    /readonly property color secondaryForeground: Util\.alpha\(contentForeground, 0\.54\)/)
  assert.equal(panel.split("placeholderTextColor: root.secondaryForeground").length - 1, 2)
  assert.equal(panel.split("secondaryForeground: root.secondaryForeground").length - 1, 3)
  assert.equal(panel.split("color: root.secondaryForeground").length - 1, 8)

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
  assert.match(catalogCard,
    /color: repoMouse\.containsMouse \? Color\.accent : root\.secondaryForeground/)
  assert.match(catalogCard, /opacity: enabled \? 1 : 0\.45/)
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
  assert.equal(Model.versionLabel({ localVersion: "  " }), "")
  assert.equal(Model.versionLabel({}), "")
})

test("countBehind counts only rows a check actually found behind", () => {
  assert.equal(Model.countBehind(Model.applyUpdateReport(baseRows, report)), 1)
  assert.equal(Model.countBehind([]), 0)
})
