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
var SECTION_MANIFEST = "===manifest==="

// The two lists the panel draws. What you installed is what you can act on;
// the built-ins are the backdrop. Splitting them means the buttons in a
// section are the same buttons all the way down, instead of half the rows
// having greyed-out controls for reasons you have to infer.
var GROUP_INSTALLED = "installed"
var GROUP_BUILT_IN = "built-in"

var ALL_KINDS = "all"
var ALL_STATUSES = "all"
var STATUS_ENABLED = "enabled"
var STATUS_DISABLED = "disabled"
var STATUS_UPDATE = "update"

// The loader emits four fixed sections in order. Anything else — a truncated
// stream, a section that never printed — is a failed read, not empty data.
function splitSections(raw) {
  var text = String(raw || "")
  var atList = text.indexOf(SECTION_LIST)
  var atCatalog = text.indexOf(SECTION_CATALOG)
  var atGit = text.indexOf(SECTION_GIT)
  var atManifest = text.indexOf(SECTION_MANIFEST)
  if (atList < 0 || atCatalog < 0 || atGit < 0 || atManifest < 0) return null
  if (!(atList < atCatalog && atCatalog < atGit && atGit < atManifest)) return null

  return {
    list: text.slice(atList + SECTION_LIST.length, atCatalog),
    catalog: text.slice(atCatalog + SECTION_CATALOG.length, atGit),
    git: text.slice(atGit + SECTION_GIT.length, atManifest),
    manifest: text.slice(atManifest + SECTION_MANIFEST.length)
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

// One compact JSON object per line, with path, remote, exactTag and the
// checkout HEAD that proved that tag. The HEAD also binds later update reports
// to the exact checkout generation they inspected.
// JSON framing matters here: git config and filesystem names are untrusted,
// and tabs or newlines in either must stay data rather than becoming another
// checkout record. There is deliberately no legacy TSV fallback.
function parseGitMap(raw) {
  var map = {}
  var lines = String(raw || "").split("\n")
  for (var i = 0; i < lines.length; i++) {
    var line = lines[i].replace(/\r$/, "")
    if (line === "") continue
    var record
    try {
      record = JSON.parse(line)
    } catch (error) {
      continue
    }
    if (!record || Array.isArray(record) || typeof record !== "object") continue
    var keys = Object.keys(record).sort()
    if (keys.join(",") !== "exactTag,headSha,path,remote") continue
    if (typeof record.path !== "string" || record.path === ""
        || typeof record.remote !== "string" || typeof record.exactTag !== "string"
        || typeof record.headSha !== "string") continue
    var headSha = record.headSha === "" ? "" : normalizeGitObjectId(record.headSha)
    if (record.headSha !== "" && headSha === "") continue
    // Git ref names cannot contain controls. An impossible tag makes the
    // producer record malformed; it must not contribute provenance.
    if (/[\u0000-\u001f\u007f]/.test(record.exactTag)) continue
    map[record.path] = { remote: record.remote, exactTag: record.exactTag, headSha: headSha }
  }
  return map
}

// "<id>\t<author>\t<version>" per line, straight out of each manifest.json.
// Both trailing fields are routinely empty — a manifest is allowed to name
// neither — so, as with the git map, only the line ending may be trimmed.
function parseManifestMeta(raw) {
  var map = {}
  var lines = String(raw || "").split("\n")

  for (var i = 0; i < lines.length; i++) {
    var parts = lines[i].replace(/\r$/, "").split("\t")
    if (parts.length < 2 || parts[0] === "") continue
    map[parts[0]] = {
      author: String(parts[1] || "").trim(),
      version: String(parts[2] || "").trim()
    }
  }
  return map
}

// Text that came from somewhere else — a public registry, a stranger's
// manifest, a checkout's git config — on its way to a Text item.
//
// Qt's Text defaults to `Text.AutoText`, which inspects the string and renders
// anything tag-shaped as rich text. `<img src="https://…">` in a plugin name
// is therefore a fetch, made by the long-lived shell process, chosen by
// whoever wrote the listing. The shell's own Ui components set no textFormat
// either, so this cannot be fixed only at the components this plugin owns:
// untrusted text is cleaned as it enters the model, once, and every sink
// downstream is safe by construction.
//
// Angle brackets go rather than get escaped: an escaped entity still trips
// AutoText's sniffing, and nothing legitimate in a plugin name or blurb needs
// them. Newlines go too — a one-line label is a place to hide the rest of a
// confirmation prompt.
function plainText(value) {
  return String(value === null || value === undefined ? "" : value)
    .replace(/[<>]/g, "")
    .replace(/[\u0000-\u001f\u007f]+/g, " ")
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
  for (var i = 0; i < (value || []).length; i++) out.push(plainText(value[i]))
  return out
}

// `list` carries enabled/first-party state, `catalog` carries the source
// directory and description, `gitMap` says which checkouts a pull can reach
// and which exact version tag (if any) is proven at HEAD, and `manifestMeta`
// carries what only the manifest knows — who wrote it and what version is on
// disk. One row per plugin, joined on id.
function mergePlugins(listEntries, catalogEntries, gitMap, manifestMeta) {
  var catalog = indexById(catalogEntries)
  var git = gitMap || {}
  var manifests = manifestMeta || {}
  var rows = []

  for (var i = 0; i < (listEntries || []).length; i++) {
    var item = listEntries[i]
    if (!item || !item.id) continue

    var id = String(item.id)
    var meta = catalog[id] || {}
    var sourceDir = String(meta.sourceDir || "")
    var gitManaged = sourceDir !== "" && git.hasOwnProperty(sourceDir)
    var gitInfo = gitManaged ? (git[sourceDir] || {}) : {}
    var firstParty = item.firstParty === true
    var manifest = manifests[id] || {}

    rows.push({
      id: id,
      name: plainText(item.name || id),
      author: plainText(manifest.author),
      // Read at load time so every row can state its version, not just the
      // git-managed ones an update check happens to reach.
      localVersion: plainText(manifest.version),
      description: plainText(meta.description),
      kinds: toStringList(item.kinds && item.kinds.length ? item.kinds : meta.kinds),
      enabled: item.enabled === true,
      // A bar has no off, only a successor — the shell says so per plugin
      // rather than making every caller work it out from kinds again.
      canDisable: item.canDisable === true,
      firstParty: firstParty,
      group: firstParty ? GROUP_BUILT_IN : GROUP_INSTALLED,
      clonedFrom: plainText(item.clonedFrom),
      sourceDir: sourceDir,
      remote: gitManaged ? plainText(gitInfo.remote) : "",
      exactTag: gitManaged ? plainText(gitInfo.exactTag) : "",
      headSha: gitManaged ? normalizeGitObjectId(gitInfo.headSha) : "",
      gitManaged: gitManaged,
      // Built-ins live in /usr/share and are not ours to delete. Everything
      // under the user plugin directory — installed or cloned — is.
      removable: !firstParty && sourceDir !== "",
      // A checkout with no origin has nothing to fast-forward from, so it
      // gets the git badge but no update button — offering one that can only
      // fail is worse than offering none.
      updatable: gitManaged && String(gitInfo.remote || "") !== ""
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

// Compact filter labels. "bar-widget" is the id the manifest uses, but full
// kind names waste the limited width of the filter row.
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

// A plugin that replaces the whole bar and one that mounts inside it both
// answer "what is in my bar?", so two options asked the same question twice.
// They fold into one for filtering only — a row still names its own kind.
var FILTER_KIND_ALIASES = {
  "bar": "bar-widget"
}

function filterKind(kind) {
  var name = String(kind)
  return FILTER_KIND_ALIASES.hasOwnProperty(name) ? FILTER_KIND_ALIASES[name] : name
}

// The merged option covers two kinds, so it cannot borrow either one's row
// label without claiming to be narrower than it is.
var FILTER_KIND_LABELS = {
  "bar-widget": "Bar-widget"
}

function filterKindLabel(kind) {
  var name = filterKind(kind)
  return FILTER_KIND_LABELS.hasOwnProperty(name) ? FILTER_KIND_LABELS[name] : kindLabel(name)
}

function kindsLabel(kinds) {
  var parts = []
  for (var i = 0; i < (kinds || []).length; i++) parts.push(kindLabel(kinds[i]))
  return parts.length ? parts.join(" · ") : "no kind"
}

// Derived from what is actually installed rather than from a fixed list, so a
// kind this build has never heard of still gets an option instead of being
// quietly unfilterable.
function kindOptions(rows) {
  var seen = {}
  for (var i = 0; i < (rows || []).length; i++) {
    var kinds = rows[i].kinds || []
    for (var j = 0; j < kinds.length; j++) seen[filterKind(kinds[j])] = true
  }

  var names = Object.keys(seen).sort()
  var options = [{ value: ALL_KINDS, label: "All" }]
  for (var k = 0; k < names.length; k++) options.push({ value: names[k], label: filterKindLabel(names[k]) })
  return options
}

function hasFilterKind(row, wanted) {
  var kinds = (row && row.kinds) || []
  for (var i = 0; i < kinds.length; i++) {
    if (filterKind(kinds[i]) === wanted) return true
  }
  return false
}

function filterByKind(rows, kind) {
  if (!kind || kind === ALL_KINDS) return rows || []
  var wanted = filterKind(kind)
  var out = []
  for (var i = 0; i < (rows || []).length; i++) {
    if (hasFilterKind(rows[i], wanted)) out.push(rows[i])
  }
  return out
}

// Enabled state and update availability are already authoritative row facts.
// Filtering projects those booleans; it does not maintain another status.
function statusOptions() {
  return [
    { value: ALL_STATUSES, label: "All" },
    { value: STATUS_ENABLED, label: "Enabled" },
    { value: STATUS_DISABLED, label: "Disabled" },
    { value: STATUS_UPDATE, label: "Update" }
  ]
}

function filterByStatus(rows, status) {
  if (!status || status === ALL_STATUSES) return rows || []
  if (status !== STATUS_ENABLED && status !== STATUS_DISABLED && status !== STATUS_UPDATE) return []

  var out = []
  for (var i = 0; i < (rows || []).length; i++) {
    if (status === STATUS_UPDATE) {
      if (rows[i].behind === true) out.push(rows[i])
    } else if (rows[i].enabled === (status === STATUS_ENABLED)) {
      out.push(rows[i])
    }
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

function filterRows(rows, kind, status, query) {
  var byKind = filterByKind(rows, kind)
  var byStatus = filterByStatus(byKind, status)
  if (String(query || "").trim() === "") return byStatus

  var out = []
  for (var i = 0; i < byStatus.length; i++) {
    if (matchesQuery(byStatus[i], query)) out.push(byStatus[i])
  }
  return out
}

function isFiltering(kind, status, query) {
  return (kind !== undefined && kind !== null && kind !== ALL_KINDS)
    || (status !== undefined && status !== null && status !== ALL_STATUSES)
    || String(query || "").trim() !== ""
}

// Naming what actually excluded everything, so an empty list is never a
// mystery — one active dropdown behind another is easy to forget about.
function emptyMessage(kind, status, query) {
  var needle = String(query || "").trim()
  var kindNarrowed = kind && kind !== ALL_KINDS
  var updateNarrowed = status === STATUS_UPDATE
  var statusNarrowed = status === STATUS_ENABLED || status === STATUS_DISABLED || updateNarrowed
  var prefix = statusNarrowed ? status + " " : ""

  if (updateNarrowed && needle !== "" && kindNarrowed)
    return "No confirmed " + filterKindLabel(kind).toLowerCase() + " plugin updates match “" + needle + "”."
  if (updateNarrowed && needle !== "")
    return "No confirmed plugin updates match “" + needle + "”."
  if (updateNarrowed && kindNarrowed)
    return "No confirmed " + filterKindLabel(kind).toLowerCase() + " plugin updates found."
  if (updateNarrowed)
    return "No confirmed updates found."
  if (needle !== "" && kindNarrowed)
    return "No " + prefix + filterKindLabel(kind).toLowerCase() + " plugins match “" + needle + "”."
  if (needle !== "")
    return "No " + prefix + "plugins match “" + needle + "”."
  if (kindNarrowed)
    return "No " + prefix + filterKindLabel(kind).toLowerCase() + " plugins found."
  if (statusNarrowed)
    return "No " + status + " plugins found."
  return "No plugins found."
}

// Wraps around, so the cycle key never dead-ends on the last option.
function nextKind(options, current) {
  var list = options || []
  if (list.length === 0) return ALL_KINDS
  for (var i = 0; i < list.length; i++) {
    if (list[i].value === current) return list[(i + 1) % list.length].value
  }
  return list[0].value
}

// ---- Row text -------------------------------------------------------------

// Who published this. The manifest is the honest source, but plenty of them
// leave `author` out — and an Omarchy id is namespaced by its publisher, so
// the prefix says the same thing. An id with no namespace says nothing, and
// echoing it back as an author would be a guess dressed up as a fact.
function authorLabel(row) {
  if (!row) return ""
  var author = String(row.author || "").trim()
  if (author !== "") return author
  var id = String(row.id || "")
  var dot = id.indexOf(".")
  return dot > 0 ? id.slice(0, dot) : ""
}

// The line under the name: who made it and what it plugs into. The id is not
// here — the name above says which plugin this is, and the namespace already
// surfaces as the author.
function metaLine(row) {
  if (!row) return ""
  var author = authorLabel(row)
  var kinds = kindsLabel(row.kinds)
  return author === "" ? kinds : author + "  ·  " + kinds
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

// ---- Enabling -------------------------------------------------------------
//
// Installing a plugin and running it are two different things. `omarchy plugin
// add` clones the folder and registers the manifest; a bar widget still has no
// place in the bar until someone says which section it goes in. That is why a
// freshly installed widget sits in the list greyed out — it is not broken, it
// is unplaced — and why the section has to be asked for rather than guessed.

var BAR_SECTIONS = ["left", "center", "right"]

// Before an install there is no manifest to read, so the registry's own
// human-readable kind is all there is to go on: "Bar widget", "Service + Bar
// widget", "Menu + Bar widget". "Bar" alone is a whole-bar replacement and
// takes no place in a section — and it is a prefix of "Bar widget", so this
// matches the phrase rather than the word.
function catalogNeedsPlacement(entry) {
  if (!entry) return false
  return String(entry.kind || "").toLowerCase().indexOf("bar widget") >= 0
}

// By id, never by index: a background reload can rebuild the list while a
// question about one of its rows is still on screen.
function findRow(rows, id) {
  var wanted = String(id || "")
  if (wanted === "") return null
  for (var i = 0; i < (rows || []).length; i++) {
    if (rows[i] && String(rows[i].id) === wanted) return rows[i]
  }
  return null
}

function canEnable(row) {
  return !!row && String(row.id || "") !== "" && row.enabled !== true
}

// A bar widget takes a place in a section. A plugin whose kind is `bar` IS the
// bar — it replaces the one in use rather than sitting inside it — and
// `omarchy plugin enable` fails outright if handed a placement for one.
// The exact inverse of enable: it takes a widget out of the bar layout and
// leaves the plugin on disk, so it is not destructive and asks nothing.
function canDisable(row) {
  return !!row && String(row.id || "") !== "" && row.enabled === true && row.canDisable === true
}

// Both of these end up in a desktop notification rather than the panel's own
// status line: switching a bar widget on or off rewrites `bar.layout`, the bar
// rebuilds its widgets, and this panel is torn down with them before it could
// show anything.
function enableNote(section) {
  if (BAR_SECTIONS.indexOf(String(section || "")) < 0) return "It is switched on now."
  return "It has a place in the " + section + " section of the bar now."
}

function disableNote() {
  return "It is off the bar, but still installed."
}

function disableCommand(row) {
  if (!row || String(row.id || "") === "") return []
  return ["omarchy", "plugin", "disable", String(row.id)]
}

function needsPlacement(row) {
  if (!row) return false
  var kinds = row.kinds || []
  if (kinds.indexOf("bar") >= 0) return false
  return kinds.indexOf("bar-widget") >= 0
}

function placementOptions() {
  return [
    { value: "left", label: "Left" },
    { value: "center", label: "Center" },
    { value: "right", label: "Right" }
  ]
}

// The section reaches a CLI as an argv element. It comes from a fixed set of
// buttons today, but it is checked against the same fixed set here anyway —
// the guarantee should live with the command, not with whichever UI happens to
// be calling it.
function enableCommand(row, section) {
  if (!row || String(row.id || "") === "") return []
  var command = ["omarchy", "plugin", "enable", String(row.id)]
  if (BAR_SECTIONS.indexOf(String(section || "")) >= 0) command.push(String(section))
  return command
}

function actionVerb(kind) {
  if (kind === "add") return "Add"
  if (kind === "update") return "Update"
  if (kind === "remove") return "Remove"
  if (kind === "enable") return "Enable"
  if (kind === "disable") return "Disable"
  return "Action"
}

function successMessage(kind, label) {
  if (kind === "add") return "Added " + label
  if (kind === "update") return "Updated " + label
  if (kind === "remove") return "Removed " + label
  if (kind === "enable") return "Enabled " + label
  if (kind === "disable") return "Disabled " + label
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
  if (kind === "enable") return "Enabling"
  if (kind === "disable") return "Disabling"
  return "Working"
}

// ---- Marketplace catalog --------------------------------------------------
//
// omarchyplugins.com publishes the same resolved catalog its own site renders
// from: name, description, author, category, GitHub stars, verification state,
// and a curated install command per plugin. Anonymous Marketplace hearts come
// from the site's engagement API and are joined by plugin id before parsing.
// We read the install command, we never execute it — the install url is parsed
// out and validated, then run through the same argv array the Installed tab uses.

var CATALOG_URL = "https://omarchyplugins.com/catalog.json"
var MARKETPLACE_STATS_URL = "https://api.omarchyplugins.com/v1/stats"
var CATALOG_ASSET_BASE = "https://omarchyplugins.com/"

// The registry publishes thumbnails as paths under its own host. Anything
// absolute or protocol-relative in that field is pointing the shell's image
// loader somewhere the registry does not control, so it gets no request at
// all rather than a request to a url built by concatenation.
function catalogAssetUrl(path) {
  var text = plainText(path).trim()
  if (text === "" || text.indexOf("//") === 0 || /^[a-z][a-z0-9+.-]*:/i.test(text)) return ""
  return CATALOG_ASSET_BASE + text.replace(/^\/+/, "")
}
var ALL_CATEGORIES = "all"
var ALL_CATALOG_KINDS = "all"
var CATALOG_AVAILABILITY_ALL = "all"
var CATALOG_AVAILABILITY_AVAILABLE = "available"
var CATALOG_AVAILABILITY_INSTALLED = "installed"
var CATALOG_SORT_STARS = "stars"
var CATALOG_SORT_HEARTS = "hearts"
var CATALOG_SORT_RECENTLY_ADDED = "recently-added"
var CATALOG_SORT_NAME = "name"

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

// "Installed" has to read as installed at a glance, and green is the only
// colour that says that without a caption. Omarchy themes carry no success
// role to borrow — foreground, background, accent, urgent, muted, and that is
// all — so the badge brings its own, in the two shades it takes to stay
// legible at both ends of the theme range (>=5:1 against either default).
var INSTALLED_ON_DARK = "#5fb37a"
var INSTALLED_ON_LIGHT = "#1f7a4d"

function installedTint(background) {
  if (!background) return INSTALLED_ON_DARK
  // Weighted for how the eye actually reads brightness: a full-blue panel is
  // dark and a full-green one is light, which neither an average nor a max
  // would get right.
  var lightness = 0.2126 * Number(background.r || 0)
    + 0.7152 * Number(background.g || 0)
    + 0.0722 * Number(background.b || 0)
  return lightness > 0.5 ? INSTALLED_ON_LIGHT : INSTALLED_ON_DARK
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
  // Plugin ids are untrusted property names. A null prototype keeps valid ids
  // such as `constructor` and `__proto__` from becoming object machinery.
  var set = Object.create(null)
  for (var i = 0; i < (rows || []).length; i++) {
    if (rows[i] && rows[i].id) set[String(rows[i].id)] = true
  }
  return set
}

function hasOwnKey(object, key) {
  return object !== null && object !== undefined
    && Object.prototype.hasOwnProperty.call(object, String(key))
}

// Counts are remote facts, so malformed and absent values remain unknown. In
// particular, coercing either to zero would display a number the source never
// supplied. A real zero is preserved and may be shown.
function catalogCount(value) {
  if (typeof value !== "number" || !isFinite(value)) return null
  if (value < 0 || Math.floor(value) !== value || value > 9007199254740991) return null
  return value
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

    var sourceCategory = plainText(p.category).trim()
    var categoryPresent = sourceCategory !== ""
    var entry = {
      id: plainText(p.id),
      name: plainText(p.name || p.id),
      description: plainText(p.description).trim(),
      author: plainText(p.author).trim(),
      version: plainText(p.version).trim(),
      // Missing categories still belong in the useful Other browse group, but
      // presence travels separately so details never present that fallback as
      // a fact supplied by the listing.
      category: categoryPresent ? sourceCategory : "Other",
      categoryPresent: categoryPresent,
      kind: plainText(p.kind),
      repo: plainText(p.repo),
      installCommand: plainText(p.installCommand),
      installAvailable: p.installAvailable === true,
      installNote: plainText(p.installNote).trim(),
      verified: p.verificationStatus === "verified",
      stars: catalogCount(p.stars),
      marketplaceHearts: catalogCount(p.marketplaceHearts),
      listedAt: plainText(p.listedAt).trim(),
      addedAt: plainText(p.addedAt).trim(),
      accent: String(p.accent || ""),
      initials: plainText(p.initials).toUpperCase(),
      license: plainText(p.license).trim(),
      thumbnail: catalogAssetUrl(p.previewThumbnail),
      branch: String(p.listingValidatedBranch || ""),
      repoPreview: repoPreviewUrl(p.repo, p.listingValidatedBranch),
      installed: hasOwnKey(installed, p.id)
    }
    entry.installUrl = installUrlFor(entry)
    // A listing with no usable url cannot be installed from here whatever the
    // registry claims, so the flag follows the url rather than the other way.
    entry.installable = entry.installAvailable && entry.installUrl !== "" && !entry.installed
    out.push(entry)
  }

  return sortCatalog(out, CATALOG_SORT_STARS)
}

function compareCatalogText(leftValue, rightValue) {
  var left = String(leftValue || "").toLowerCase()
  var right = String(rightValue || "").toLowerCase()
  if (left < right) return -1
  if (left > right) return 1
  // Case-insensitive ordering is the contract; raw text only makes values
  // that differ by case deterministic rather than engine-dependent.
  left = String(leftValue || "")
  right = String(rightValue || "")
  if (left < right) return -1
  if (left > right) return 1
  return 0
}

function isCatalogListedTimestamp(value) {
  var match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?Z$/.exec(value)
  if (!match) return false

  var year = Number(match[1])
  var month = Number(match[2])
  var day = Number(match[3])
  var hour = Number(match[4])
  var minute = Number(match[5])
  var second = Number(match[6])
  if (month < 1 || month > 12 || hour > 23 || minute > 59 || second > 59) return false

  var daysInMonth = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]
  if (year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0)) daysInMonth[1] = 29
  return day >= 1 && day <= daysInMonth[month - 1]
}

function catalogTimestamp(entry) {
  var listedAt = plainText(entry && entry.listedAt).trim()
  var addedAt = plainText(entry && entry.addedAt).trim()
  var value = isCatalogListedTimestamp(listedAt) ? listedAt : addedAt
  if (value === "") return null
  var timestamp = Date.parse(value)
  return isFinite(timestamp) ? timestamp : null
}

function compareCatalogEntries(a, b, sort, leftTimestamp, rightTimestamp) {
  var mode = sort || CATALOG_SORT_STARS
  if (mode === CATALOG_SORT_RECENTLY_ADDED) {
    var leftHasTimestamp = leftTimestamp !== null
    var rightHasTimestamp = rightTimestamp !== null
    if (leftHasTimestamp !== rightHasTimestamp) return leftHasTimestamp ? -1 : 1
    if (leftHasTimestamp && leftTimestamp !== rightTimestamp) return leftTimestamp > rightTimestamp ? -1 : 1
  } else if (mode === CATALOG_SORT_STARS || mode === CATALOG_SORT_HEARTS) {
    var field = mode === CATALOG_SORT_HEARTS ? "marketplaceHearts" : "stars"
    var leftMetric = a[field] === null ? -1 : a[field]
    var rightMetric = b[field] === null ? -1 : b[field]
    if (leftMetric !== rightMetric) return rightMetric - leftMetric
  }

  var leftName = String(a.name || "").toLowerCase()
  var rightName = String(b.name || "").toLowerCase()
  var byName = leftName < rightName ? -1 : (leftName > rightName ? 1 : 0)
  if (byName !== 0) return byName
  var leftId = String(a.id || "").toLowerCase()
  var rightId = String(b.id || "").toLowerCase()
  if (leftId < rightId) return -1
  if (leftId > rightId) return 1
  var byRawId = compareCatalogText(a.id, b.id)
  if (byRawId !== 0) return byRawId
  return compareCatalogText(a.name, b.name)
}

// Decorate with the original index so exact duplicates stay stable even on a
// QML JavaScript engine whose Array.sort stability is not guaranteed.
function sortCatalog(entries, sort) {
  var mode = sort || CATALOG_SORT_STARS
  var decorated = []
  for (var i = 0; i < (entries || []).length; i++) {
    decorated.push({
      entry: entries[i],
      index: i,
      timestamp: mode === CATALOG_SORT_RECENTLY_ADDED ? catalogTimestamp(entries[i]) : null
    })
  }
  decorated.sort(function(a, b) {
    return compareCatalogEntries(a.entry, b.entry, mode, a.timestamp, b.timestamp) || a.index - b.index
  })

  var out = []
  for (var j = 0; j < decorated.length; j++) out.push(decorated[j].entry)
  return out
}

function catalogCategories(entries) {
  var seen = Object.create(null)
  for (var i = 0; i < (entries || []).length; i++) seen[entries[i].category] = true

  var names = Object.keys(seen).sort()
  var options = [{ value: ALL_CATEGORIES, label: "All" }]
  for (var k = 0; k < names.length; k++) options.push({ value: names[k], label: names[k] })
  return options
}

function catalogKindKey(kind) {
  return String(kind || "").trim().toLowerCase()
}

function catalogKindOptions(entries) {
  var byKey = Object.create(null)
  for (var i = 0; i < (entries || []).length; i++) {
    var kind = String(entries[i] && entries[i].kind || "").trim()
    var key = catalogKindKey(kind)
    if (key !== "" && !hasOwnKey(byKey, key)) byKey[key] = kind
  }

  var keys = Object.keys(byKey)
  keys.sort(compareCatalogText)
  var options = [{ value: ALL_CATALOG_KINDS, label: "All" }]
  for (var k = 0; k < keys.length; k++) options.push({ value: keys[k], label: byKey[keys[k]] })
  return options
}

function catalogAvailabilityOptions() {
  return [
    { value: CATALOG_AVAILABILITY_ALL, label: "All" },
    { value: CATALOG_AVAILABILITY_AVAILABLE, label: "Available" },
    { value: CATALOG_AVAILABILITY_INSTALLED, label: "Installed" }
  ]
}

function catalogSortOptions() {
  return [
    { value: CATALOG_SORT_RECENTLY_ADDED, label: "Recently added" },
    { value: CATALOG_SORT_STARS, label: "GitHub stars" },
    { value: CATALOG_SORT_HEARTS, label: "Hearts" },
    { value: CATALOG_SORT_NAME, label: "Name" }
  ]
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

function filterCatalog(entries, category, kind, availability, query) {
  var out = []
  for (var i = 0; i < (entries || []).length; i++) {
    var entry = entries[i]
    if (category && category !== ALL_CATEGORIES && entry.category !== category) continue
    if (kind && kind !== ALL_CATALOG_KINDS
        && catalogKindKey(entry.kind) !== catalogKindKey(kind)) continue
    if (availability === CATALOG_AVAILABILITY_AVAILABLE && !entry.installable) continue
    if (availability === CATALOG_AVAILABILITY_INSTALLED && !entry.installed) continue
    if (!matchesCatalogQuery(entry, query)) continue
    out.push(entry)
  }
  return out
}

function catalogIsFiltering(category, kind, availability, query) {
  return !!(category && category !== ALL_CATEGORIES)
    || !!(kind && kind !== ALL_CATALOG_KINDS)
    || availability === CATALOG_AVAILABILITY_AVAILABLE
    || availability === CATALOG_AVAILABILITY_INSTALLED
    || String(query || "").trim() !== ""
}

function clearedCatalogFilters() {
  return {
    category: ALL_CATEGORIES,
    kind: ALL_CATALOG_KINDS,
    availability: CATALOG_AVAILABILITY_ALL,
    query: ""
  }
}

function catalogEmptyMessage(category, kind, availability, query) {
  var needle = String(query || "").trim()
  var narrowed = catalogIsFiltering(category, kind, availability, "")

  if (needle !== "" && narrowed) return "No plugins match “" + needle + "” and the selected filters."
  if (needle !== "") return "No plugins match “" + needle + "”."
  if (narrowed) return "No plugins match the selected filters."
  return "The catalog is empty."
}

function starLabel(count) {
  var stars = catalogCount(count)
  if (stars === null) return ""
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
    var isInstalled = hasOwnKey(installed, entry.id)
    var copy = {}
    for (var key in entry) copy[key] = entry[key]
    copy.installed = isInstalled
    copy.installable = entry.installAvailable && entry.installUrl !== "" && !isInstalled
    out.push(copy)
  }
  return out
}

function restampCatalogInstallState(entries, installedIds, detailsEntry) {
  var stamped = markInstalled(entries, installedIds)
  return {
    entries: stamped,
    detailsEntry: detailsEntry ? findRow(stamped, detailsEntry.id) : null
  }
}

// Modal visibility can overlap for one synchronous handoff. The successor has
// ownership, and a deferred list-focus restore may run only when none remains.
function browseModalFocusOwner(detailsOpen, confirming, placing) {
  if (placing) return "placement"
  if (confirming) return "confirmation"
  if (detailsOpen) return "details"
  return "list"
}

function catalogPlacementConfirmationNote(needsPlacement) {
  return needsPlacement
    ? "\n\nNext, choose its bar section. Cloning starts only after that choice."
    : ""
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
  return /^https:\/\/[^\/\s]+\/.*/.test(text) ? text : ""
}

// Plugin repositories overwhelmingly ship a preview.png at their root — 31 of
// a 40-repo sample — and PNG is a format Qt always reads. The registry's own
// thumbnails are WebP, which needs an optional system package, so the repo's
// own screenshot is tried first and the curated thumbnail is the fallback
// rather than the other way round.
// An installed plugin names its origin the way git does — an scp-style
// `git@host:owner/repo.git`, an ssh:// url, a trailing .git — none of which a
// browser opens. This converts what it recognises and then hands the result
// to browsableUrl, so there stays exactly one place that decides whether a
// string is safe to launch.
function repoWebUrl(url) {
  var text = normalizeGitUrl(url)
  if (text === "") return ""

  var scp = text.match(/^[^@\s]+@([^:\s]+):(.+)$/)
  if (scp) text = "https://" + scp[1] + "/" + scp[2]
  else text = text.replace(/^ssh:\/\/(?:[^@\/\s]+@)?/, "https://")

  return browsableUrl(text.replace(/\.git$/, "").replace(/\/+$/, ""))
}

// Where the row's plugin lives on the web. The origin remote first: that is
// where an update actually pulls from. `clonedFrom` is only a record of how
// the plugin first arrived, and a checkout can be repointed since.
function rowRepoUrl(row) {
  if (!row) return ""
  return repoWebUrl(row.remote) || repoWebUrl(row.clonedFrom)
}

// Only an exact two-segment GitHub repository is eligible for URLs that claim
// something about repository contents. Other hosts remain valid row links;
// they simply do not gain GitHub-specific paths by inference.
function githubRepoSlug(url) {
  var web = repoWebUrl(url)
  var match = web.match(/^https:\/\/github\.com\/([^\/]+)\/([^\/]+)$/i)
  if (!match) return ""

  var owner = match[1]
  var repo = match[2]
  // GitHub owner names are at most 39 alphanumeric/hyphen characters and may
  // not start or end with a hyphen. Repository names are at most 100
  // alphanumeric/dot/underscore/hyphen characters; dot path segments are not
  // repositories. The narrow character sets also reject percent escapes,
  // backslashes, queries and fragments before a browser can normalize them.
  if (owner.length > 39 || !/^[A-Za-z0-9]+(?:-[A-Za-z0-9]+)*$/.test(owner)) return ""
  if (repo.length > 100 || !/^[A-Za-z0-9._-]+$/.test(repo) || repo === "." || repo === "..") return ""
  return owner + "/" + repo
}

// Manifest versions are display data first and untrusted URL path data second.
// Plain-text normalization matches the row label; the bound prevents a crafted
// manifest from producing unreasonably large probe URLs.
function normalizedManifestVersion(value) {
  var text = plainText(value).trim()
  return text !== "" && text.length <= 100 ? text : ""
}

// Release names conventionally add one `v` to the manifest version. Catalogs
// and manifests are not consistent about whether they already included it, so
// remove every leading v/V before constructing either the display label or the
// ordered release candidates. A value made only of prefixes is not a version.
function normalizedReleaseVersion(value) {
  var text = normalizedManifestVersion(value)
  while (text.length > 0 && text.charAt(0).toLowerCase() === "v") text = text.substr(1)
  return text
}

function releaseVersionLabel(value) {
  var version = normalizedReleaseVersion(value)
  return version === "" ? "" : "v" + version
}

// Local tag proof is no longer link eligibility. It remains the best fallback
// because it names the exact source ref already proven at this checkout's HEAD.
function provenLocalTag(row) {
  if (!row || row.gitManaged !== true) return ""

  var version = normalizedReleaseVersion(row.localVersion)
  var exactTag = String(row.exactTag || "").trim()
  if (version === "" || (exactTag !== version && exactTag !== "v" + version)) return ""
  if (/[\u0000-\u001f\u007f]/.test(exactTag)) return ""
  return exactTag
}

function githubTagUrl(remote, tag, base, path) {
  var slug = githubRepoSlug(remote)
  if (slug === "" || tag === "" || tag.length > 256) return ""
  return base + slug + path + encodeURIComponent(tag)
}

function githubReleaseCandidates(remote, versionValue) {
  var version = normalizedReleaseVersion(versionValue)
  if (version === "" || githubRepoSlug(remote) === "") return []

  var names = ["v" + version, version]
  var seen = {}, out = []
  for (var i = 0; i < names.length; i++) {
    var name = names[i]
    if (seen[name]) continue
    seen[name] = true
    out.push({
      probeUrl: githubTagUrl(remote, name,
        "https://api.github.com/repos/", "/releases/tags/"),
      preferredUrl: githubTagUrl(remote, name,
        "https://github.com/", "/releases/tag/")
    })
  }
  return out
}

function versionReleaseCandidates(row) {
  if (!row || row.gitManaged !== true) return []
  return githubReleaseCandidates(row.remote, row.localVersion)
}

// Release absence never weakens provenance: fall back from a locally proven
// version tag, to the loaded checkout commit, to the validated current origin.
function versionFallbackUrl(row) {
  if (versionReleaseCandidates(row).length === 0) return ""
  var exactTag = provenLocalTag(row)
  if (exactTag !== "") return githubTagUrl(
    row.remote, exactTag, "https://github.com/", "/tree/")
  var headSha = normalizeGitObjectId(row.headSha)
  if (headSha !== "") return githubTagUrl(
    row.remote, headSha, "https://github.com/", "/tree/")
  return githubRepositoryUrl(row.remote)
}

function githubRepositoryUrl(remote) {
  var slug = githubRepoSlug(remote)
  return slug === "" ? "" : "https://github.com/" + slug
}

function catalogVersionLabel(entry) {
  return releaseVersionLabel(entry ? entry.version : "")
}

function catalogVersionReleaseCandidates(entry) {
  if (!entry) return []
  return githubReleaseCandidates(entry.repo, entry.version)
}

// Browse entries have no local checkout provenance. Their exact validated
// GitHub repository is therefore the only honest fallback when neither
// published Release exists or the click-time probe fails.
function catalogVersionFallbackUrl(entry) {
  if (catalogVersionReleaseCandidates(entry).length === 0) return ""
  return githubRepositoryUrl(entry.repo)
}

function repoPreviewUrl(repo, branch) {
  var slug = githubRepoSlug(repo)
  if (slug === "") return ""

  var ref = String(branch || "").trim()
  return "https://raw.githubusercontent.com/" + slug + "/" + (ref !== "" ? ref : "main") + "/preview.png"
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

// ---- Update checks ---------------------------------------------------------
//
// Whether a plugin has an update is decided by commits, not by version
// strings. Authors do not reliably bump the manifest on every change — two of
// the checkouts this was built against were genuinely behind while reporting
// the same version at both ends — so a version comparison would have shown
// nothing for a real update. The local and remote HEAD are the truth; the
// version pair is shown alongside only when it actually says something.

// Remote manifest versions are untrusted input that may become Git ref
// arguments. Keep the accepted shape deliberately narrower than Git itself:
// it covers conventional release versions, caps work sent to git/URLs, and
// rejects every ref metacharacter that has caused ambiguous revisions.
function normalizeGitObjectId(value) {
  var text = String(value || "")
  return /^(?:[0-9a-fA-F]{40}|[0-9a-fA-F]{64})$/.test(text) ? text.toLowerCase() : ""
}

// One compact JSON object per checkout. Filesystem paths and manifest versions
// are untrusted, so JSON escaping — not tabs and newlines — owns the framing.
// There is deliberately no legacy TSV fallback.
function parseUpdateReport(raw) {
  var map = {}
  var lines = String(raw || "").split("\n")

  for (var i = 0; i < lines.length; i++) {
    var line = lines[i].replace(/\r$/, "")
    if (line === "") continue
    var record
    try {
      record = JSON.parse(line)
    } catch (error) {
      continue
    }
    if (!record || Array.isArray(record) || typeof record !== "object") continue
    var keys = Object.keys(record).sort()
    if (keys.join(",") !== "localSha,localVersion,path,remoteSha,remoteVersion") continue
    if (typeof record.path !== "string" || record.path === ""
        || typeof record.localSha !== "string" || typeof record.remoteSha !== "string"
        || typeof record.localVersion !== "string" || typeof record.remoteVersion !== "string") continue

    var localSha = record.localSha === "" ? "" : normalizeGitObjectId(record.localSha)
    var remoteSha = record.remoteSha === "" ? "" : normalizeGitObjectId(record.remoteSha)
    if ((record.localSha !== "" && localSha === "")
        || (record.remoteSha !== "" && remoteSha === "")) continue

    map[record.path] = {
      localSha: localSha,
      remoteSha: remoteSha,
      localVersion: plainText(record.localVersion),
      remoteVersion: plainText(record.remoteVersion)
    }
  }
  return map
}

// An unreachable remote reports an empty sha. That is "we could not tell",
// which must not render as "up to date" — being quietly told nothing is how a
// stale plugin sits there for months looking current.
function applyUpdateReport(rows, report) {
  var byDir = report || {}
  var out = []

  for (var i = 0; i < (rows || []).length; i++) {
    var row = rows[i]
    var info = byDir[row.sourceDir]
    var copy = {}
    for (var key in row) copy[key] = row[key]

    // A report describes one checkout generation, not merely one filesystem
    // path. A reload may rebuild the same row after pull or an external
    // checkout change while an older process is still finishing. Only the
    // freshly loaded HEAD can authorize that report to restore update state.
    var loadedHead = normalizeGitObjectId(row.headSha)
    var reportHead = info ? normalizeGitObjectId(info.localSha) : ""
    var usableInfo = loadedHead !== "" && reportHead !== "" && loadedHead === reportHead
      ? info
      : null
    copy.headSha = loadedHead

    // The git pass only reaches checkouts with a remote. Everything else keeps
    // the version the manifest already gave it at load time.
    var reportedLocalVersion = usableInfo ? plainText(usableInfo.localVersion) : ""
    copy.localVersion = reportedLocalVersion !== "" ? reportedLocalVersion : plainText(row.localVersion)
    copy.remoteVersion = usableInfo ? plainText(usableInfo.remoteVersion) : ""
    // Always overwrite these: a later failed or malformed check must not leave
    // an earlier comparison URL attached to a row whose evidence is now gone.
    copy.localSha = usableInfo ? reportHead : ""
    copy.remoteSha = usableInfo ? normalizeGitObjectId(usableInfo.remoteSha) : ""
    copy.updateChecked = copy.localSha !== "" && copy.remoteSha !== ""
    copy.behind = copy.updateChecked && copy.localSha !== copy.remoteSha
    // Only when both ends name a version and they disagree. Equal versions
    // across a real update is the common case, not an error.
    copy.versionChanged = copy.behind
      && copy.localVersion !== ""
      && copy.remoteVersion !== ""
      && copy.localVersion !== copy.remoteVersion
    out.push(copy)
  }
  return out
}

// What the row's badge should say. The version arrow when the numbers differ,
// otherwise a plain word, because "1.0.0 → 1.0.0" reads as a bug.
function updateBadge(row) {
  if (!row || !row.behind) return ""
  if (row.versionChanged) return row.localVersion + " → " + row.remoteVersion
  return "update"
}

// GitHub generates this comparison from the exact commits already used to
// decide `behind`; it is not a release and requires no API or extra request.
function updateCompareUrl(row) {
  if (!row || row.behind !== true) return ""

  var localSha = normalizeGitObjectId(row.localSha)
  var remoteSha = normalizeGitObjectId(row.remoteSha)
  if (localSha === "" || remoteSha === "" || localSha === remoteSha) return ""

  // As with version tags, only the checkout's current origin is authoritative.
  var slug = githubRepoSlug(row.remote)
  if (slug === "") return ""
  return "https://github.com/" + slug + "/compare/" + localSha + "..." + remoteSha
}

function updateReleaseCandidates(row) {
  if (!row || row.versionChanged !== true || updateCompareUrl(row) === "") return []
  return githubReleaseCandidates(row.remote, row.remoteVersion)
}

// Click routing revalidates every URL even though the model constructed it.
// This makes the Panel boundary explicit: only exact GitHub release probes and
// locally-built release/tree/compare pages can reach curl or the browser.
function trustedGithubTagUrl(url, expression, base, path) {
  var text = String(url || "")
  var match = text.match(expression)
  if (!match) return ""

  var slug = githubRepoSlug("https://github.com/" + match[1] + "/" + match[2])
  if (slug === "") return ""
  var tag
  try {
    tag = decodeURIComponent(match[3])
  } catch (error) {
    return ""
  }
  if (tag === "" || tag.length > 256 || /[\u0000-\u001f\u007f]/.test(tag)) return ""
  var canonical = githubTagUrl("https://github.com/" + slug, tag, base, path)
  return canonical === text ? text : ""
}

function trustedGithubReleaseApiUrl(url) {
  return trustedGithubTagUrl(url,
    /^https:\/\/api\.github\.com\/repos\/([^\/]+)\/([^\/]+)\/releases\/tags\/([^\/?#\s]+)$/,
    "https://api.github.com/repos/", "/releases/tags/")
}

function trustedGithubReleaseUrl(url) {
  return trustedGithubTagUrl(url,
    /^https:\/\/github\.com\/([^\/]+)\/([^\/]+)\/releases\/tag\/([^\/?#\s]+)$/,
    "https://github.com/", "/releases/tag/")
}

function trustedGithubTreeUrl(url) {
  return trustedGithubTagUrl(url,
    /^https:\/\/github\.com\/([^\/]+)\/([^\/]+)\/tree\/([^\/?#\s]+)$/,
    "https://github.com/", "/tree/")
}

function trustedGithubCompareUrl(url) {
  var text = String(url || "")
  var match = text.match(/^https:\/\/github\.com\/([^\/]+)\/([^\/]+)\/compare\/([^\.\/]+)\.\.\.([^\/]+)$/)
  if (!match) return ""
  var slug = githubRepoSlug("https://github.com/" + match[1] + "/" + match[2])
  var localSha = normalizeGitObjectId(match[3])
  var remoteSha = normalizeGitObjectId(match[4])
  if (slug === "" || localSha === "" || remoteSha === "" || localSha === remoteSha) return ""
  var canonical = "https://github.com/" + slug + "/compare/" + localSha + "..." + remoteSha
  return canonical === text ? text : ""
}

function trustedGithubRepoUrl(url) {
  var text = String(url || "")
  var slug = githubRepoSlug(text)
  var canonical = slug === "" ? "" : "https://github.com/" + slug
  return canonical === text ? text : ""
}

function trustedGithubWebUrl(url) {
  return trustedGithubReleaseUrl(url) || trustedGithubTreeUrl(url)
    || trustedGithubCompareUrl(url) || trustedGithubRepoUrl(url)
}

function trustedGithubReleaseCandidate(value) {
  var probe = trustedGithubReleaseApiUrl(value ? value.probeUrl : "")
  var preferred = trustedGithubReleaseUrl(value ? value.preferredUrl : "")
  if (probe === "" || preferred === "") return null
  var expected = probe
    .replace("https://api.github.com/repos/", "https://github.com/")
    .replace("/releases/tags/", "/releases/tag/")
  return expected === preferred ? { probeUrl: probe, preferredUrl: preferred } : null
}

function githubNavigationRequest(candidateValues, fallbackUrl) {
  var fallback = trustedGithubWebUrl(fallbackUrl)
  if (fallback === "") return { candidates: [], fallbackUrl: "" }

  var values = Array.isArray(candidateValues) ? candidateValues : []
  var candidates = [], seen = {}
  for (var i = 0; i < values.length && candidates.length < 2; i++) {
    var candidate = trustedGithubReleaseCandidate(values[i])
    if (!candidate || seen[candidate.probeUrl]) continue
    seen[candidate.probeUrl] = true
    candidates.push(candidate)
  }
  return { candidates: candidates, fallbackUrl: fallback }
}

function releaseProbeCommand(apiUrl) {
  var probe = trustedGithubReleaseApiUrl(apiUrl)
  if (probe === "") return []
  return [
    "curl", "--silent", "--show-error", "--output", "/dev/null",
    "--request", "GET", "--connect-timeout", "3", "--max-time", "5",
    "--header", "Accept: application/vnd.github+json",
    "--header", "X-GitHub-Api-Version: 2022-11-28",
    "--write-out", "%{http_code}", probe
  ]
}

// Release navigation is asynchronous, while every other click in the panel is
// immediate. Keeping the generation and process lifecycle in one explicit
// value makes "latest choice wins" testable without relying on QML callback
// timing. Transitions return effects; Panel.qml alone performs those effects.
function releaseNavigationInitialState() {
  return {
    generation: 0,
    activeGeneration: 0,
    activeRequest: null,
    activeCandidateIndex: 0,
    queuedRequest: null,
    probeExited: false,
    probeOutputFinished: false,
    probeExitCode: -1,
    probeResponseCode: ""
  }
}

function copyReleaseNavigationState(state) {
  var current = state || {}
  return {
    generation: Number(current.generation) || 0,
    activeGeneration: Number(current.activeGeneration) || 0,
    activeRequest: current.activeRequest || null,
    activeCandidateIndex: Number(current.activeCandidateIndex) || 0,
    queuedRequest: current.queuedRequest || null,
    probeExited: current.probeExited === true,
    probeOutputFinished: current.probeOutputFinished === true,
    probeExitCode: Number(current.probeExitCode),
    probeResponseCode: String(current.probeResponseCode || "")
  }
}

function releaseNavigationResult(state) {
  return {
    state: state,
    stopProbe: false,
    startRequest: null,
    scheduleStart: false,
    openUrl: ""
  }
}

function clearActiveReleaseNavigation(state) {
  state.activeGeneration = 0
  state.activeRequest = null
  state.activeCandidateIndex = 0
  state.probeExited = false
  state.probeOutputFinished = false
  state.probeExitCode = -1
  state.probeResponseCode = ""
}

function activateReleaseNavigation(state, entry) {
  state.activeGeneration = entry.generation
  state.activeRequest = entry.request
  state.activeCandidateIndex = 0
  state.queuedRequest = null
  state.probeExited = false
  state.probeOutputFinished = false
  state.probeExitCode = -1
  state.probeResponseCode = ""
}

function activeReleaseNavigationStart(state) {
  if (!state || state.activeGeneration === 0 || !state.activeRequest) return null
  var candidates = state.activeRequest.candidates || []
  var candidate = candidates[state.activeCandidateIndex]
  if (!candidate) return null
  return { generation: state.activeGeneration, probeUrl: candidate.probeUrl }
}

// A release click revokes the active generation before deciding whether the
// new request needs a probe. If a process is still settling, only the newest
// request remains queued; its probe cannot start until both old callbacks land.
function releaseNavigationRequestTransition(state, value) {
  var next = copyReleaseNavigationState(state)
  var hadActive = next.activeGeneration !== 0
  next.generation++
  next.queuedRequest = null
  if (hadActive) next.activeRequest = null

  var request = githubNavigationRequest(
    value ? value.candidates : [], value ? value.fallbackUrl : "")
  var result = releaseNavigationResult(next)
  result.stopProbe = hadActive
  if (request.fallbackUrl === "") return result
  if (request.candidates.length === 0) {
    result.openUrl = request.fallbackUrl
    return result
  }

  var entry = { generation: next.generation, request: request }
  if (hadActive) {
    next.queuedRequest = entry
    return result
  }

  activateReleaseNavigation(next, entry)
  result.startRequest = activeReleaseNavigationStart(next)
  return result
}

// Actions and non-release navigation are newer human choices too. Active URLs
// are quarantined immediately; late callbacks may settle the process but can
// no longer navigate or consume a queued request.
function releaseNavigationRevokeTransition(state) {
  var next = copyReleaseNavigationState(state)
  var hadActive = next.activeGeneration !== 0
  next.generation++
  next.queuedRequest = null
  if (hadActive) next.activeRequest = null
  var result = releaseNavigationResult(next)
  result.stopProbe = hadActive
  return result
}

function releaseNavigationDirectTransition(state, url) {
  var result = releaseNavigationRevokeTransition(state)
  result.openUrl = browsableUrl(url)
  return result
}

function settleReleaseNavigation(state) {
  var next = copyReleaseNavigationState(state)
  var result = releaseNavigationResult(next)
  if (next.activeGeneration === 0 || !next.probeExited || !next.probeOutputFinished) return result

  if (next.activeGeneration === next.generation && next.activeRequest) {
    var candidates = next.activeRequest.candidates || []
    var candidate = candidates[next.activeCandidateIndex]
    var responseCode = String(next.probeResponseCode || "").trim()
    if (candidate && Number(next.probeExitCode) === 0 && responseCode === "200") {
      result.openUrl = trustedGithubReleaseUrl(candidate.preferredUrl)
    } else if (candidate && Number(next.probeExitCode) === 0 && responseCode === "404"
        && next.activeCandidateIndex + 1 < candidates.length) {
      next.activeCandidateIndex++
      next.probeExited = false
      next.probeOutputFinished = false
      next.probeExitCode = -1
      next.probeResponseCode = ""
      result.scheduleStart = true
      return result
    } else {
      result.openUrl = trustedGithubWebUrl(next.activeRequest.fallbackUrl)
    }
  }
  clearActiveReleaseNavigation(next)
  result.scheduleStart = !!next.queuedRequest
    && next.queuedRequest.generation === next.generation
  return result
}

function releaseNavigationProbeExitedTransition(state, exitCode) {
  var next = copyReleaseNavigationState(state)
  if (next.activeGeneration === 0) return releaseNavigationResult(next)
  next.probeExited = true
  next.probeExitCode = Number(exitCode)
  return settleReleaseNavigation(next)
}

function releaseNavigationProbeOutputTransition(state, responseCode) {
  var next = copyReleaseNavigationState(state)
  if (next.activeGeneration === 0) return releaseNavigationResult(next)
  next.probeOutputFinished = true
  next.probeResponseCode = String(responseCode || "").trim()
  return settleReleaseNavigation(next)
}

function releaseNavigationStartQueuedTransition(state) {
  var next = copyReleaseNavigationState(state)
  var result = releaseNavigationResult(next)
  if (next.activeGeneration !== 0) {
    if (next.activeGeneration === next.generation && next.activeRequest)
      result.startRequest = activeReleaseNavigationStart(next)
    else if (!next.activeRequest) clearActiveReleaseNavigation(next)
    if (result.startRequest || next.activeGeneration !== 0) return result
  }
  var entry = next.queuedRequest
  if (!entry || entry.generation !== next.generation) {
    next.queuedRequest = null
    return result
  }
  activateReleaseNavigation(next, entry)
  result.startRequest = activeReleaseNavigationStart(next)
  return result
}

// The request and command validators share the same API URL boundary, so this
// is defensive rather than expected. It prevents a validator disagreement
// from leaving a generation permanently busy when no process was started.
function releaseNavigationProbeStartFailedTransition(state) {
  var next = copyReleaseNavigationState(state)
  var result = releaseNavigationResult(next)
  if (next.activeGeneration === next.generation && next.activeRequest)
    result.openUrl = trustedGithubWebUrl(next.activeRequest.fallbackUrl)
  clearActiveReleaseNavigation(next)
  result.scheduleStart = !!next.queuedRequest
    && next.queuedRequest.generation === next.generation
  return result
}

function versionLabel(row) {
  if (!row) return ""
  return releaseVersionLabel(row.localVersion)
}

function countBehind(rows) {
  var total = 0
  for (var i = 0; i < (rows || []).length; i++) if (rows[i].behind) total++
  return total
}
