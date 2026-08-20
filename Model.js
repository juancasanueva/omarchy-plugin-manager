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

function subtitle(row) {
  if (!row) return ""
  var kinds = row.kinds.length ? row.kinds.join(", ") : "no kind"
  return row.id + "  ·  " + kinds
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
