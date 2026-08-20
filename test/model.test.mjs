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
    rowsInGroup, groupLabel, sectionHeading,
    kindLabel, kindsLabel, kindOptions, filterByKind, nextKind,
    matchesQuery, filterRows, isFiltering, emptyMessage,
    parseCatalog, catalogEntries, installedIdSet, installUrlFor, markInstalled,
    catalogCategories, filterCatalog, matchesCatalogQuery, catalogEmptyMessage,
    installState, installBlockedReason, starLabel, accentColor,
    repoShortLabel, browsableUrl, repoPreviewUrl, previewCandidates,
    parseUpdateReport, applyUpdateReport, updateBadge, versionLabel, countBehind,
    metaLine, descriptionLine, hasDescription, sourceBadge,
    normalizeGitUrl, isValidGitUrl, repoLabel, lastLine,
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
    { value: "bar-widget", label: "Widget" },
    { value: "service", label: "Service" }
  ])
})

test("kindOptions gives an unknown kind a chip rather than hiding it", () => {
  const rows = Model.mergePlugins(
    [{ id: "a.b", name: "B", kinds: ["hologram"], firstParty: false }], [], {})
  assert.deepEqual(Model.kindOptions(rows).map(o => o.value), ["all", "hologram"])
  assert.equal(Model.kindLabel("hologram"), "hologram")
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

test("metaLine pairs the id with readable kind labels", () => {
  assert.equal(Model.metaLine({ id: "a.b", kinds: [] }), "a.b  ·  no kind")
  assert.equal(Model.metaLine({ id: "a.b", kinds: ["bar-widget", "service"] }), "a.b  ·  Widget · Service")
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

test("successMessage says that an added plugin is now live", () => {
  assert.match(Model.successMessage("add", "omarchy-clock"), /enabled/)
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

test("filterRows applies the kind chip and the search box together", () => {
  const rows = Model.mergePlugins(listEntries, catalogEntries, gitMap)

  assert.deepEqual(Model.filterRows(rows, "all", "").map(r => r.id), ["acme.dev", "acme.weather", "omarchy.clock"])
  assert.deepEqual(Model.filterRows(rows, "all", "acme").map(r => r.id), ["acme.dev", "acme.weather"])
  assert.deepEqual(Model.filterRows(rows, "bar-widget", "acme").map(r => r.id), ["acme.weather"])
  assert.deepEqual(Model.filterRows(rows, "service", "weather").map(r => r.id), [])
})

test("filterRows keeps the installed-before-built-in order the sections rely on", () => {
  const rows = Model.mergePlugins(listEntries, catalogEntries, gitMap)
  const filtered = Model.filterRows(rows, "all", "e")
  const rejoined = [...Model.rowsInGroup(filtered, "installed"), ...Model.rowsInGroup(filtered, "built-in")]
  assert.deepEqual(rejoined.map(r => r.id), filtered.map(r => r.id))
})

test("isFiltering knows when either control is narrowing the list", () => {
  assert.equal(Model.isFiltering("all", ""), false)
  assert.equal(Model.isFiltering("all", "   "), false)
  assert.equal(Model.isFiltering("service", ""), true)
  assert.equal(Model.isFiltering("all", "clock"), true)
})

test("emptyMessage names whichever control actually excluded everything", () => {
  assert.match(Model.emptyMessage("all", "zzz"), /No plugins match “zzz”\./)
  assert.match(Model.emptyMessage("service", "zzz"), /No service plugins match “zzz”\./)
  assert.match(Model.emptyMessage("service", ""), /No service plugins installed\./)
  assert.match(Model.emptyMessage("all", ""), /No plugins found\./)
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
  { id: "a.behind", sourceDir: "/plugins/a", name: "Behind" },
  { id: "b.current", sourceDir: "/plugins/b", name: "Current" },
  { id: "c.unreachable", sourceDir: "/plugins/c", name: "Unreachable" },
  { id: "d.notgit", sourceDir: "/plugins/d", name: "Not git" }
]

const report = Model.parseUpdateReport([
  "/plugins/a\tlocalsha\tremotesha\t1.0.0\t1.2.0",
  "/plugins/b\tsamesha\tsamesha\t2.0.0\t",
  "/plugins/c\tlocalsha\t\t3.0.0\t"     // remote unreachable: empty sha
].join("\n"))

test("parseUpdateReport keys on the plugin directory", () => {
  assert.deepEqual(Object.keys(report).sort(), ["/plugins/a", "/plugins/b", "/plugins/c"])
  assert.equal(report["/plugins/a"].remoteVersion, "1.2.0")
})

test("parseUpdateReport skips malformed lines instead of inventing entries", () => {
  const parsed = Model.parseUpdateReport("\nno-tabs-here\n\t\t\n/plugins/x\tl\tr\n")
  assert.deepEqual(Object.keys(parsed), ["/plugins/x"])
})

test("a differing remote head marks the row behind", () => {
  const rows = Model.applyUpdateReport(baseRows, report)
  const behind = rows.find(r => r.id === "a.behind")
  assert.equal(behind.behind, true)
  assert.equal(behind.updateChecked, true)
  assert.equal(behind.versionChanged, true)
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

test("applyUpdateReport does not mutate the rows it was given", () => {
  const rows = Model.applyUpdateReport(baseRows, report)
  assert.equal(rows[0].behind, true)
  assert.equal(baseRows[0].behind, undefined)
})

test("the badge only shows an arrow when the versions actually differ", () => {
  // Authors do not reliably bump the manifest, so equal versions across a real
  // update is the common case — "1.0.0 → 1.0.0" would read as a bug.
  assert.equal(Model.updateBadge({ behind: true, versionChanged: true, localVersion: "1.0.0", remoteVersion: "1.2.0" }), "1.0.0 → 1.2.0")
  assert.equal(Model.updateBadge({ behind: true, versionChanged: false, localVersion: "1.0.0", remoteVersion: "1.0.0" }), "update")
  assert.equal(Model.updateBadge({ behind: false }), "")
  assert.equal(Model.updateBadge(null), "")
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
