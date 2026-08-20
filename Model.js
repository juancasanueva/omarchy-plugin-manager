// Pure data helpers for the plugin manager.
//
// Everything that turns CLI output into rows lives here rather than in the
// QML, so the parsing rules can be read on their own — and so a partial or
// broken read is distinguishable from an honestly empty one. `null` means
// "could not read"; an empty array means "read fine, nothing there". A panel
// that renders those two the same way lies to the user.

var SECTION_LIST = "===list==="
var SECTION_CATALOG = "===catalog==="
var SECTION_GIT = "===git==="

// The two lists the panel draws. What you installed is what you can act on;
// the built-ins are the backdrop. Splitting them means the buttons in a
// section are the same buttons all the way down, instead of half the rows
// having greyed-out controls for reasons you have to infer.
var GROUP_INSTALLED = "installed"
var GROUP_BUILT_IN = "built-in"

var ALL_KINDS = "all"

// The loader emits three fixed sections in order. Anything else — a truncated
// stream, a section that never printed — is a failed read, not empty data.
function splitSections(raw) {
  var text = String(raw || "")
  var atList = text.indexOf(SECTION_LIST)
  var atCatalog = text.indexOf(SECTION_CATALOG)
  var atGit = text.indexOf(SECTION_GIT)
  if (atList < 0 || atCatalog < 0 || atGit < 0) return null
  if (!(atList < atCatalog && atCatalog < atGit)) return null

  return {
    list: text.slice(atList + SECTION_LIST.length, atCatalog),
    catalog: text.slice(atCatalog + SECTION_CATALOG.length, atGit),
    git: text.slice(atGit + SECTION_GIT.length)
  }
}

// Returns null rather than [] when the payload is not a JSON array, so the
// caller can tell a failed command from a genuinely empty result.
function parseArray(raw) {
  try {
    var value = JSON.parse(String(raw || "").trim())
    return Array.isArray(value) ? value : null
  } catch (error) {
    return null
  }
}

// "<plugin dir>\t<origin url>" per line. The url is empty for a checkout with
// no origin remote — a working copy under development, typically. That line
// ends in a bare tab, so only the line ending may be trimmed here: stripping
// trailing whitespace would eat the separator and drop the entry entirely,
// making a git checkout look like a hand-dropped folder.
function parseGitMap(raw) {
  var map = {}
  var lines = String(raw || "").split("\n")
  for (var i = 0; i < lines.length; i++) {
    var line = lines[i].replace(/\r$/, "")
    if (line === "") continue
    var tab = line.indexOf("\t")
    if (tab < 0) continue
    var dir = line.slice(0, tab)
    if (dir === "") continue
    map[dir] = line.slice(tab + 1)
  }
  return map
}

function indexById(entries) {
  var byId = {}
  for (var i = 0; i < (entries || []).length; i++) {
    var entry = entries[i]
    if (entry && entry.id) byId[String(entry.id)] = entry
  }
  return byId
}

function toStringList(value) {
  var out = []
  for (var i = 0; i < (value || []).length; i++) out.push(String(value[i]))
  return out
}

// `list` carries enabled/first-party state, `catalog` carries the source
// directory and description, and `gitMap` says which checkouts a pull can
// reach. One row per plugin, joined on id.
function mergePlugins(listEntries, catalogEntries, gitMap) {
  var catalog = indexById(catalogEntries)
  var git = gitMap || {}
  var rows = []

  for (var i = 0; i < (listEntries || []).length; i++) {
    var item = listEntries[i]
    if (!item || !item.id) continue

    var id = String(item.id)
    var meta = catalog[id] || {}
    var sourceDir = String(meta.sourceDir || "")
    var gitManaged = sourceDir !== "" && git.hasOwnProperty(sourceDir)
    var firstParty = item.firstParty === true

    rows.push({
      id: id,
      name: String(item.name || id),
      description: String(meta.description || ""),
      kinds: toStringList(item.kinds && item.kinds.length ? item.kinds : meta.kinds),
      enabled: item.enabled === true,
      firstParty: firstParty,
      group: firstParty ? GROUP_BUILT_IN : GROUP_INSTALLED,
      clonedFrom: String(item.clonedFrom || ""),
      sourceDir: sourceDir,
      remote: gitManaged ? String(git[sourceDir]) : "",
      gitManaged: gitManaged,
      // Built-ins live in /usr/share and are not ours to delete. Everything
      // under the user plugin directory — installed or cloned — is.
      removable: !firstParty && sourceDir !== "",
      // A checkout with no origin has nothing to fast-forward from, so it
      // gets the git badge but no update button — offering one that can only
      // fail is worse than offering none.
      updatable: gitManaged && String(git[sourceDir] || "") !== ""
    })
  }

  rows.sort(compareRows)
  return rows
}

// What you installed comes first: this panel exists to manage those, and the
// built-ins are the backdrop they sit against.
function compareRows(a, b) {
  if (a.firstParty !== b.firstParty) return a.firstParty ? 1 : -1
  var left = a.name.toLowerCase()
  var right = b.name.toLowerCase()
  if (left < right) return -1
  if (left > right) return 1
  return 0
}

function countRemovable(rows) {
  var total = 0
  for (var i = 0; i < (rows || []).length; i++) if (rows[i].removable) total++
  return total
}

// ---- Grouping -------------------------------------------------------------

// mergePlugins already sorts installed ahead of built-in, so each group is a
// contiguous run and these two slices reassemble into the original order —
// which is what lets one flat selection index address both lists.
function rowsInGroup(rows, group) {
  var out = []
  for (var i = 0; i < (rows || []).length; i++) if (rows[i].group === group) out.push(rows[i])
  return out
}

function groupLabel(group) {
  return group === GROUP_BUILT_IN ? "Built-in" : "Installed"
}

function sectionHeading(rows, group) {
  var count = rowsInGroup(rows, group).length
  return groupLabel(group).toUpperCase() + "  ·  " + count
}

// ---- Kinds ----------------------------------------------------------------

// Short chip labels. "bar-widget" is the id the manifest uses, but a row of
// full kind names does not fit across the panel.
var KIND_LABELS = {
  "bar-widget": "Widget",
  "panel": "Panel",
  "overlay": "Overlay",
  "menu": "Menu",
  "service": "Service",
  "bar": "Bar"
}

function kindLabel(kind) {
  var name = String(kind)
  return KIND_LABELS.hasOwnProperty(name) ? KIND_LABELS[name] : name
}

function kindsLabel(kinds) {
  var parts = []
  for (var i = 0; i < (kinds || []).length; i++) parts.push(kindLabel(kinds[i]))
  return parts.length ? parts.join(" · ") : "no kind"
}

// Derived from what is actually installed rather than from a fixed list, so a
// kind this build has never heard of still gets a chip instead of being
// quietly unfilterable.
function kindOptions(rows) {
  var seen = {}
  for (var i = 0; i < (rows || []).length; i++) {
    var kinds = rows[i].kinds || []
    for (var j = 0; j < kinds.length; j++) seen[String(kinds[j])] = true
  }

  var names = Object.keys(seen).sort()
  var options = [{ value: ALL_KINDS, label: "All" }]
  for (var k = 0; k < names.length; k++) options.push({ value: names[k], label: kindLabel(names[k]) })
  return options
}

function filterByKind(rows, kind) {
  if (!kind || kind === ALL_KINDS) return rows || []
  var out = []
  for (var i = 0; i < (rows || []).length; i++) {
    if ((rows[i].kinds || []).indexOf(kind) >= 0) out.push(rows[i])
  }
  return out
}

// ---- Search ---------------------------------------------------------------

// Name and id both, because the id is the namespaced form of the name and
// typing "hyprmoncfg" should find `crmne.hyprmoncfg`. Descriptions are
// deliberately excluded: a search that matched prose would surface plugins
// whose names look nothing like what was typed, which reads as a bug.
function matchesQuery(row, query) {
  var needle = String(query || "").trim().toLowerCase()
  if (needle === "") return true
  if (!row) return false
  return String(row.name || "").toLowerCase().indexOf(needle) >= 0
    || String(row.id || "").toLowerCase().indexOf(needle) >= 0
}

function filterRows(rows, kind, query) {
  var byKind = filterByKind(rows, kind)
  if (String(query || "").trim() === "") return byKind

  var out = []
  for (var i = 0; i < byKind.length; i++) {
    if (matchesQuery(byKind[i], query)) out.push(byKind[i])
  }
  return out
}

function isFiltering(kind, query) {
  return (kind !== undefined && kind !== null && kind !== ALL_KINDS)
    || String(query || "").trim() !== ""
}

// Naming what actually excluded everything, so an empty list is never a
// mystery — a stale search box behind a kind chip is easy to forget about.
function emptyMessage(kind, query) {
  var needle = String(query || "").trim()
  var narrowed = kind && kind !== ALL_KINDS

  if (needle !== "" && narrowed)
    return "No " + kindLabel(kind).toLowerCase() + " plugins match “" + needle + "”."
  if (needle !== "")
    return "No plugins match “" + needle + "”."
  if (narrowed)
    return "No " + kindLabel(kind).toLowerCase() + " plugins installed."
  return "No plugins found."
}

// Wraps around, so the cycle key never dead-ends on the last chip.
function nextKind(options, current) {
  var list = options || []
  if (list.length === 0) return ALL_KINDS
  for (var i = 0; i < list.length; i++) {
    if (list[i].value === current) return list[(i + 1) % list.length].value
  }
  return list[0].value
}

// ---- Row text -------------------------------------------------------------

function metaLine(row) {
  if (!row) return ""
  return row.id + "  ·  " + kindsLabel(row.kinds)
}

// A plugin with no description is a fact worth stating: it means the author
// left it out of the manifest, not that the panel failed to read it.
function descriptionLine(row) {
  if (!row) return ""
  var text = String(row.description || "").trim()
  return text !== "" ? text : "No description in this plugin's manifest."
}

function hasDescription(row) {
  return !!row && String(row.description || "").trim() !== ""
}

// Built-ins live in /usr/share and are never removed or pulled, so the badge
// would only ever repeat what their section header already said.
function sourceBadge(row) {
  if (!row || row.firstParty) return ""
  return row.gitManaged ? "git" : "local"
}

function normalizeGitUrl(raw) {
  return String(raw || "").trim()
}

// Deliberately narrow. The url becomes one argv element for `omarchy plugin
// add`, so a leading dash would read as a flag, and whitespace never belongs
// in a clone target. Anything that is not plainly https/ssh/scp-style git is
// rejected here rather than handed to the CLI to fail on.
function isValidGitUrl(raw) {
  var url = normalizeGitUrl(raw)
  if (url === "") return false
  if (/\s/.test(url)) return false
  if (/^https:\/\/[^\/\s]+\/.+/.test(url)) return true
  if (/^ssh:\/\/[^\/\s]+\/.+/.test(url)) return true
  if (/^git@[^:\s]+:.+/.test(url)) return true
  return false
}

// The repo name is a better confirm-dialog subject than the full url, which
// wraps badly and buries the part you actually check.
function repoLabel(url) {
  var text = normalizeGitUrl(url)
  var withoutSuffix = text.replace(/\.git$/, "")
  var parts = withoutSuffix.split(/[\/:]/)
  var last = ""
  for (var i = parts.length - 1; i >= 0; i--) {
    if (parts[i] !== "") { last = parts[i]; break }
  }
  return last === "" ? text : last
}

function lastLine(text) {
  var lines = String(text || "").split("\n")
  for (var i = lines.length - 1; i >= 0; i--) {
    var line = lines[i].trim()
    if (line !== "") return line
  }
  return ""
}

function actionVerb(kind) {
  if (kind === "add") return "Add"
  if (kind === "update") return "Update"
  if (kind === "remove") return "Remove"
  return "Action"
}

function successMessage(kind, label) {
  if (kind === "add") return "Added " + label + " — enabled"
  if (kind === "update") return "Updated " + label
  if (kind === "remove") return "Removed " + label
  return "Done"
}

// The CLI's own last line of stderr is almost always the useful sentence.
// When it says nothing, the exit code is at least honest about the failure.
function failureMessage(kind, stderrText, exitCode) {
  var detail = lastLine(stderrText)
  if (detail !== "") return actionVerb(kind) + " failed: " + detail
  return actionVerb(kind) + " failed (exit " + String(exitCode) + ")"
}

// "Updateing" is what naive suffixing gets you; the in-flight line reads too
// often to leave it broken.
function actionGerund(kind) {
  if (kind === "add") return "Adding"
  if (kind === "update") return "Updating"
  if (kind === "remove") return "Removing"
  return "Working"
}

// ---- Marketplace catalog --------------------------------------------------
//
// omarchyplugins.com publishes the same resolved catalog its own site renders
// from: name, description, author, category, stars, verification state, and a
// curated install command per plugin. We read it, we never execute it — the
// install url is parsed out and validated, then run through the same argv
// array the Installed tab uses.

var CATALOG_URL = "https://omarchyplugins.com/catalog.json"
var CATALOG_ASSET_BASE = "https://omarchyplugins.com/"
var ALL_CATEGORIES = "all"

// The registry assigns every plugin an accent and a pair of initials — its
// own fallback tile for listings with no screenshot. We reuse them, which
// also covers the case where the previews cannot be decoded at all (they are
// WebP, and Qt only reads it when qt6-imageformats is installed).
var ACCENT_COLORS = {
  rose: "#e0708f",
  violet: "#9d7cd8",
  cyan: "#4fb3c8",
  coral: "#e08a63",
  amber: "#d6a44f",
  lime: "#8ebf62"
}

function accentColor(name) {
  var key = String(name || "").toLowerCase()
  return ACCENT_COLORS.hasOwnProperty(key) ? ACCENT_COLORS[key] : ACCENT_COLORS.violet
}

function parseCatalog(raw) {
  try {
    var doc = JSON.parse(String(raw || "").trim())
    if (!doc || !Array.isArray(doc.plugins)) return null
    return doc
  } catch (error) {
    return null
  }
}

function installedIdSet(rows) {
  var set = {}
  for (var i = 0; i < (rows || []).length; i++) {
    if (rows[i] && rows[i].id) set[String(rows[i].id)] = true
  }
  return set
}

// The curated installCommand carries the exact clone url — including the .git
// suffix that `repo` often omits — so the url is taken from there. It is
// pulled out and validated rather than run: a command string from the network
// is data, never something to hand to a shell.
function installUrlFor(entry) {
  if (!entry) return ""
  var parts = String(entry.installCommand || "").trim().split(/\s+/)
  for (var i = 0; i < parts.length; i++) {
    if (isValidGitUrl(parts[i])) return parts[i]
  }
  return isValidGitUrl(entry.repo) ? normalizeGitUrl(entry.repo) : ""
}

function catalogEntries(doc, installedIds) {
  if (!doc || !Array.isArray(doc.plugins)) return []
  var installed = installedIds || {}
  var out = []

  for (var i = 0; i < doc.plugins.length; i++) {
    var p = doc.plugins[i]
    if (!p || !p.id) continue
    // Built-ins ship with Omarchy and are always present; listing them under
    // "browse and install" would be offering something you already have.
    if (p.sourceType === "builtin") continue

    var entry = {
      id: String(p.id),
      name: String(p.name || p.id),
      description: String(p.description || "").trim(),
      author: String(p.author || "").trim(),
      version: String(p.version || "").trim(),
      category: String(p.category || "Other"),
      kind: String(p.kind || ""),
      repo: String(p.repo || ""),
      installCommand: String(p.installCommand || ""),
      installAvailable: p.installAvailable === true,
      installNote: String(p.installNote || "").trim(),
      verified: p.verificationStatus === "verified",
      stars: Number(p.stars) || 0,
      accent: String(p.accent || ""),
      initials: String(p.initials || "").toUpperCase(),
      license: String(p.license || "").trim(),
      thumbnail: p.previewThumbnail ? CATALOG_ASSET_BASE + String(p.previewThumbnail) : "",
      branch: String(p.listingValidatedBranch || ""),
      repoPreview: repoPreviewUrl(p.repo, p.listingValidatedBranch),
      installed: installed.hasOwnProperty(String(p.id))
    }
    entry.installUrl = installUrlFor(entry)
    // A listing with no usable url cannot be installed from here whatever the
    // registry claims, so the flag follows the url rather than the other way.
    entry.installable = entry.installAvailable && entry.installUrl !== "" && !entry.installed
    out.push(entry)
  }

  out.sort(compareCatalogEntries)
  return out
}

// Popularity first: a storefront that opens on an alphabetical list buries
// everything anyone actually uses.
function compareCatalogEntries(a, b) {
  if (a.stars !== b.stars) return b.stars - a.stars
  var left = a.name.toLowerCase()
  var right = b.name.toLowerCase()
  if (left < right) return -1
  if (left > right) return 1
  return 0
}

function catalogCategories(entries) {
  var seen = {}
  for (var i = 0; i < (entries || []).length; i++) seen[entries[i].category] = true

  var names = Object.keys(seen).sort()
  var options = [{ value: ALL_CATEGORIES, label: "All" }]
  for (var k = 0; k < names.length; k++) options.push({ value: names[k], label: names[k] })
  return options
}

// Author and tags join name and id here, unlike the installed-plugin search:
// browsing is how you find something you cannot already name, so "solitaire"
// or an author you follow both have to land.
function matchesCatalogQuery(entry, query) {
  var needle = String(query || "").trim().toLowerCase()
  if (needle === "") return true
  if (!entry) return false
  return String(entry.name).toLowerCase().indexOf(needle) >= 0
    || String(entry.id).toLowerCase().indexOf(needle) >= 0
    || String(entry.author).toLowerCase().indexOf(needle) >= 0
    || String(entry.description).toLowerCase().indexOf(needle) >= 0
}

function filterCatalog(entries, category, query) {
  var out = []
  for (var i = 0; i < (entries || []).length; i++) {
    var entry = entries[i]
    if (category && category !== ALL_CATEGORIES && entry.category !== category) continue
    if (!matchesCatalogQuery(entry, query)) continue
    out.push(entry)
  }
  return out
}

function catalogEmptyMessage(category, query) {
  var needle = String(query || "").trim()
  var narrowed = category && category !== ALL_CATEGORIES

  if (needle !== "" && narrowed) return "No " + category + " plugins match “" + needle + "”."
  if (needle !== "") return "No plugins match “" + needle + "”."
  if (narrowed) return "No " + category + " plugins in the catalog."
  return "The catalog is empty."
}

function starLabel(count) {
  var stars = Number(count) || 0
  if (stars >= 1000) return (Math.round(stars / 100) / 10) + "k"
  return String(stars)
}

// What the card's button should say. The registry lists plenty of things that
// are not one-command installable — suites with their own installers, repos
// that are not plugin-shaped — and each carries a note saying why. Showing the
// reason beats showing a button that cannot work.
function installState(entry) {
  if (!entry) return "unavailable"
  if (entry.installed) return "installed"
  if (entry.installable) return "installable"
  return "unavailable"
}

function installBlockedReason(entry) {
  if (!entry) return ""
  if (entry.installNote !== "") return entry.installNote
  if (entry.installUrl === "") return "This listing has no usable clone url."
  return "This plugin cannot be installed from here."
}

// Re-stamps install state onto an already-built catalog. Installing something
// changes which cards should say "installed", and re-deriving the whole list
// from the raw document to learn that would throw away the sort and the fetch.
function markInstalled(entries, installedIds) {
  var installed = installedIds || {}
  var out = []
  for (var i = 0; i < (entries || []).length; i++) {
    var entry = entries[i]
    var isInstalled = installed.hasOwnProperty(entry.id)
    var copy = {}
    for (var key in entry) copy[key] = entry[key]
    copy.installed = isInstalled
    copy.installable = entry.installAvailable && entry.installUrl !== "" && !isInstalled
    out.push(copy)
  }
  return out
}

// "https://github.com/acme/omarchy-weather" -> "acme/omarchy-weather". The
// host is the same for effectively every listing, so printing it on each card
// spends width on the one part that carries no information.
function repoShortLabel(url) {
  var text = normalizeGitUrl(url).replace(/\.git$/, "").replace(/\/+$/, "")
  var match = text.match(/^https?:\/\/[^\/]+\/(.+)$/)
  if (match) return match[1]
  var scp = text.match(/^git@[^:]+:(.+)$/)
  if (scp) return scp[1]
  return text
}

// Only http(s) is ever handed to a browser. The repo field arrives over the
// network, and a url that is not a web page has no business being opened as
// one — javascript:, file:, and anything else are refused rather than passed
// through to the launcher.
function browsableUrl(url) {
  var text = normalizeGitUrl(url)
  if (/\s/.test(text)) return ""
  return /^https:\/\/[^\/\s]+\/.+/.test(text) ? text : ""
}

// Plugin repositories overwhelmingly ship a preview.png at their root — 31 of
// a 40-repo sample — and PNG is a format Qt always reads. The registry's own
// thumbnails are WebP, which needs an optional system package, so the repo's
// own screenshot is tried first and the curated thumbnail is the fallback
// rather than the other way round.
function repoPreviewUrl(repo, branch) {
  var text = normalizeGitUrl(repo).replace(/\.git$/, "").replace(/\/+$/, "")
  var match = text.match(/^https:\/\/github\.com\/([^\/\s]+\/[^\/\s]+)$/)
  if (!match) return ""

  var ref = String(branch || "").trim()
  return "https://raw.githubusercontent.com/" + match[1] + "/" + (ref !== "" ? ref : "main") + "/preview.png"
}

// Ordered best-first. A card walks this list as each source fails, and lands
// on the accent tile when none of them decode.
function previewCandidates(entry, allowWebp) {
  if (!entry) return []
  var out = []
  if (entry.repoPreview) out.push(entry.repoPreview)
  if (allowWebp && entry.thumbnail) out.push(entry.thumbnail)
  return out
}
