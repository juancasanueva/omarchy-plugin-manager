import QtQuick
import Quickshell
import Quickshell.Io
import qs.Commons
import qs.Ui
import "Model.js" as Model

// The plugin manager's popup: every plugin the shell discovered, split into
// what you installed and what ships with Omarchy, with the three lifecycle
// actions the CLI already exposes — add a repo, update a checkout, remove an
// install.
//
// The split is not cosmetic. Built-ins live in /usr/share and can be neither
// pulled nor deleted, so mixing them into one list means half the rows carry
// controls that do nothing. Two sections make the available actions constant
// within each one.
//
// The list is read from `omarchy plugin list` and `omarchy plugin catalog`
// rather than from shell.json, so it shows what the shell actually found, not
// what the config claims. Actions shell out to the same `omarchy plugin`
// commands a terminal would run; nothing here touches the plugin directory
// itself. Every command runs as an argv array, never through a shell, so a
// repository url can never become a command.
//
// Add and remove both confirm first. Adding clones and runs unsandboxed code
// inside the shell process, and removing deletes a directory — neither is a
// thing to do on a mis-click.
//
// BarWidget.qml owns the bar icon and hands this panel the button to anchor
// against.
Panel {
  id: root
  moduleName: "io.github.juancasanueva.plugin-manager"
  ipcTarget: "io.github.juancasanueva.plugin-manager"
  manageIpc: false

  property var anchorItem: null

  // The bar tracks the widget mounted in its slot — BarWidget.qml — not this
  // nested panel, so everything the bar identifies a panel by has to be that
  // widget.
  property var hostWidget: null
  readonly property var barIdentity: hostWidget || root

  // Guarded so the panel renders before the bar is injected (the bar-widget
  // contract instantiates it bare).
  readonly property color contentForeground: bar ? bar.foreground : Color.foreground
  readonly property string contentFontFamily: bar ? bar.fontFamily : Style.font.family

  // ---- Data ---------------------------------------------------------------

  property var rows: []
  property bool loading: false
  property string loadError: ""
  property int selectedIndex: -1

  property string kindFilter: "all"
  readonly property var kindOptions: Model.kindOptions(rows)
  readonly property string searchQuery: searchField.text

  // One flat filtered list drives selection; the two section slices below are
  // views onto it, in the same order, so a single index addresses both.
  readonly property var visibleRows: Model.filterRows(rows, kindFilter, searchQuery)
  readonly property var installedRows: Model.rowsInGroup(visibleRows, "installed")
  readonly property var builtinRows: Model.rowsInGroup(visibleRows, "built-in")

  // Checked in the background after the rows are already on screen, so the
  // panel never waits on the network to show you what you have installed.
  property bool checkingUpdates: false
  readonly property int behindCount: Model.countBehind(rows)

  readonly property int installedTotal: Model.countRemovable(rows)
  readonly property bool filtered: Model.isFiltering(kindFilter, searchQuery)

  // ---- Browse tab ---------------------------------------------------------
  //
  // The marketplace catalog omarchyplugins.com publishes. Fetched on first
  // visit and cached on disk, so opening the panel costs nothing until you
  // actually go looking for something new.

  property string activeTab: "installed"   // "installed" | "browse"
  readonly property bool browsing: activeTab === "browse"
  readonly property var tabOptions: [
    { value: "installed", label: "Installed" },
    { value: "browse", label: "Browse" }
  ]

  property var catalog: []
  property bool catalogLoading: false
  property bool catalogLoaded: false
  property string catalogError: ""
  property string categoryFilter: "all"

  // The registry's previews are WebP, which Qt only decodes when
  // qt6-imageformats is installed. Rather than probing for it, the first card
  // that fails tells us, and every card falls back to the registry's own
  // accent-and-initials tile from then on.
  property bool previewsSupported: true

  readonly property var categoryOptions: Model.catalogCategories(catalog)
  readonly property var visibleCatalog: Model.filterCatalog(catalog, categoryFilter, searchQuery)

  function switchTab(tab) {
    if (activeTab === tab) return
    activeTab = tab
    resetSelection()
    if (tab === "browse" && !catalogLoaded && !catalogLoading) loadCatalog(false)
  }

  // Any narrowing rebuilds the list under the selection, so the index is
  // dropped rather than left pointing at whatever now sits in that slot —
  // that is how a Delete keypress lands on the wrong plugin.
  onSearchQueryChanged: resetSelection()

  // Installing something changes which cards should read "installed". Re-stamp
  // rather than rebuild: the catalog's sort and its fetch both survive.
  onRowsChanged: {
    if (catalog.length === 0) return
    catalog = Model.markInstalled(catalog, Model.installedIdSet(rows))
  }
  readonly property var selectedRow: selectedIndex >= 0 && selectedIndex < visibleRows.length
    ? visibleRows[selectedIndex]
    : null

  // One selection index serves both tabs; which list it indexes into is the
  // only thing that changes.
  readonly property var selectedEntry: selectedIndex >= 0 && selectedIndex < visibleCatalog.length
    ? visibleCatalog[selectedIndex]
    : null
  readonly property int selectableCount: browsing ? visibleCatalog.length : visibleRows.length

  // ---- In-flight action ---------------------------------------------------

  property string busyKind: ""   // "add" | "update" | "remove"
  property string busyId: ""
  readonly property bool busy: busyKind !== ""

  // Kept past the exit so a late stderr can still upgrade the message it
  // belongs to (see actionProc below).
  property string actionStderr: ""
  property string lastActionKind: ""
  property int lastExitCode: 0

  property string status: ""
  property bool statusIsError: false

  // ---- Pending confirmation -----------------------------------------------

  property string pendingKind: ""
  property string pendingId: ""
  property string pendingLabel: ""
  property string pendingUrl: ""
  property bool pendingVerified: false
  readonly property bool confirming: pendingKind !== "" && pendingKind !== "place"

  // ---- Pending placement --------------------------------------------------
  //
  // Enabling a bar widget is a different question from the yes/no ones above:
  // not "are you sure" but "where". It gets its own dialog rather than a
  // default section, because a widget dropped into a section the user did not
  // choose is a widget they have to go hunting for.
  readonly property bool placing: pendingKind === "place"

  // Whether the plugin being added takes a place in the bar. Read off the
  // registry listing, since the manifest that would say so is not on disk yet.
  property bool pendingPlacementNeeded: false

  // The section chosen for a plugin that is not installed yet. Held from the
  // moment the question is answered until the install command is built, since
  // by the time the clone lands this panel no longer exists to be asked.
  property string pendingPlacement: ""

  readonly property var placementChoices: Model.placementOptions()
  readonly property string placementMessage:
    "Where in the bar should " + pendingLabel + " go?"

  readonly property string confirmMessage: {
    if (pendingKind === "add")
      return "Clone " + pendingLabel + "?\n\n"
        + pendingUrl + "\n\n"
        // Stated as a review rather than a guarantee. A badge that reads as a
        // safety promise is worse than no badge, because it retires the
        // judgement the next sentence is asking for.
        + (pendingVerified ? "The registry lists this plugin as verified, which is a review and not a guarantee. " : "")
        + "Plugins run unsandboxed inside omarchy-shell. Only add repositories whose code you are willing to run."
        + "\n\nYou will be asked where to put it once it is cloned."
    if (pendingKind === "remove")
      return "Remove " + pendingLabel + "?\n\nIts folder under ~/.config/omarchy/plugins is deleted."
    if (pendingKind === "disable")
      return "Disable " + pendingLabel + "?\n\n"
        + "This is the panel you are looking at. It leaves the bar and this window closes with it — "
        + "nothing is uninstalled, but you will need a terminal to put it back:\n\n"
        + "omarchy plugin enable " + moduleName + " right"
    return ""
  }

  // ---- Loading ------------------------------------------------------------

  function reload() {
    if (loadProc.running) return
    loading = true
    loadProc.running = true
  }

  function applyLoad(raw) {
    loading = false

    var sections = Model.splitSections(raw)
    var listEntries = sections ? Model.parseArray(sections.list) : null
    if (!sections || !listEntries) {
      // Deliberately keep the rows we already have. An empty list would read
      // as "no plugins installed", which is a different and much scarier
      // claim than "could not read".
      loadError = "Could not read the plugin list"
      return
    }

    loadError = ""
    rows = Model.mergePlugins(
      listEntries,
      Model.parseArray(sections.catalog) || [],
      Model.parseGitMap(sections.git),
      Model.parseManifestMeta(sections.manifest))
    clampSelection()
    if (pendingUpdateReport !== "") applyUpdateReport(pendingUpdateReport)
  }

  // ---- Update checks ------------------------------------------------------

  function checkUpdates() {
    if (updateProc.running) return
    checkingUpdates = true
    updateProc.running = true
  }

  // Held so a report that lands while the rows are being rebuilt is not lost;
  // a reload after an install would otherwise wipe every badge until the next
  // check.
  property string pendingUpdateReport: ""

  function applyUpdateReport(raw) {
    checkingUpdates = false
    pendingUpdateReport = raw
    if (rows.length === 0) return
    rows = Model.applyUpdateReport(rows, Model.parseUpdateReport(raw))
  }

  // ---- Filtering ----------------------------------------------------------

  function setKindFilter(kind) {
    if (kindFilter === kind) return
    kindFilter = kind
    resetSelection()
  }

  function resetSelection() {
    selectedIndex = -1
    listScroll.contentY = 0
    catalogGrid.contentY = 0
  }

  function clearSearch() {
    searchField.text = ""
  }

  function setCategoryFilter(category) {
    if (categoryFilter === category) return
    categoryFilter = category
    resetSelection()
  }

  // ---- Catalog ------------------------------------------------------------

  function loadCatalog(force) {
    if (catalogProc.running) return
    catalogLoading = true
    catalogError = ""
    catalogProc.command = ["bash", "-c", catalogScript, "catalog", force === true ? "1" : "0"]
    catalogProc.running = true
  }

  function applyCatalog(raw) {
    catalogLoading = false

    var doc = Model.parseCatalog(raw)
    if (!doc) {
      // Keep whatever was already on screen. An empty grid would claim the
      // marketplace has nothing in it.
      catalogError = "Could not read the plugin catalog"
      return
    }

    catalog = Model.catalogEntries(doc, Model.installedIdSet(rows))
    catalogLoaded = true
    catalogError = ""
  }

  // Installing from the catalog runs the same argv array as the url field —
  // the registry's own install command is read for its url and never executed.
  function askInstall(entry) {
    if (!entry || !entry.installable || busy) return
    pendingUrl = entry.installUrl
    pendingLabel = entry.name
    pendingId = entry.id
    pendingVerified = entry.verified === true
    pendingPlacementNeeded = Model.catalogNeedsPlacement(entry)
    pendingKind = "add"
  }

  function cycleKindFilter() {
    setKindFilter(Model.nextKind(kindOptions, kindFilter))
  }

  function clampSelection() {
    if (selectedIndex >= visibleRows.length) selectedIndex = visibleRows.length - 1
  }

  // ---- Actions ------------------------------------------------------------

  function setStatus(text, isError) {
    status = text
    statusIsError = isError === true
  }

  function askAdd() {
    var url = Model.normalizeGitUrl(urlField.text)
    if (!Model.isValidGitUrl(url)) {
      setStatus("Enter an https://, ssh://, or git@ repository url", true)
      return
    }
    pendingUrl = url
    pendingLabel = Model.repoLabel(url)
    // A bare url says nothing about what is inside it. The plugin is cloned
    // and left off; the row it becomes carries its own Enable button, which
    // asks the same question once there is a manifest to answer it from.
    pendingId = ""
    pendingVerified = false
    pendingPlacementNeeded = false
    pendingKind = "add"
  }

  function askRemove(row) {
    if (!row || !row.removable || busy) return
    pendingId = row.id
    pendingLabel = row.name
    pendingUrl = ""
    pendingKind = "remove"
  }

  // Enabling is not destructive and needs no "are you sure" — but a bar widget
  // has to be told where it goes, and only the user knows that.
  function askEnable(row) {
    if (!Model.canEnable(row) || busy) return

    if (!Model.needsPlacement(row)) {
      // A service, an overlay, or a whole-bar plugin: nothing to place, so the
      // question would have exactly one answer.
      startEnable(row, "")
      return
    }

    pendingId = row.id
    pendingLabel = row.name
    pendingUrl = ""
    pendingKind = "place"
  }

  // Disabling takes a widget out of the bar and leaves it on disk, so it is
  // reversible from the row it just greyed out — no confirmation needed. With
  // one exception: this panel's own row, whose Enable button leaves with it.
  function askDisable(row) {
    if (!Model.canDisable(row) || busy) return

    if (row.id === moduleName) {
      pendingId = row.id
      pendingLabel = row.name
      pendingUrl = ""
      pendingKind = "disable"
      return
    }

    startDisable(row)
  }

  function startDisable(row) {
    runDetached(Model.successMessage("disable", row.name),
                Model.disableNote(),
                Model.disableCommand(row))
  }

  // Detached, and announced through a notification rather than the status
  // line — for the same reason installing is. Switching a bar widget on or off
  // rewrites `bar.layout`; the bar rebuilds its widgets, and this panel is one
  // of them. It is gone before `onExited` could fire, so a status message here
  // is written to something nobody can read, and a Process owned by a
  // destroyed panel is not a safe place for the command itself either.
  function runDetached(summary, detail, command) {
    if (command.length === 0) return
    Quickshell.execDetached(["bash", "-c", noticeScript, "notice", summary, detail].concat(command))
    setStatus(summary, false)
  }

  function startEnable(row, section) {
    runDetached(Model.successMessage("enable", row.name),
                Model.enableNote(section),
                Model.enableCommand(row, section))
  }

  function confirmPlacement(section) {
    // Two questions share this dialog: where to put a plugin being installed,
    // and where to put one already sitting in the list switched off.
    if (pendingPlacementNeeded) {
      startAdd(section)
      return
    }

    var row = Model.findRow(rows, pendingId)
    var label = pendingLabel
    cancelPending()
    if (!row) {
      // The list was reloaded out from under the question — enabling a row
      // that is no longer there would either fail or, worse, hit whatever now
      // carries that id.
      setStatus("Could not enable " + label + ": it is no longer in the list", true)
      return
    }
    startEnable(row, section)
  }

  function cancelPending() {
    pendingKind = ""
    pendingId = ""
    pendingLabel = ""
    pendingUrl = ""
    pendingPlacementNeeded = false
  }

  // Confirmation answered. A bar widget still owes us one more answer, and it
  // has to be collected now: cloning a plugin makes the shell rebuild every
  // plugin widget, this panel included, so there is no "after the install" in
  // which to ask anything.
  function confirmPending() {
    if (pendingKind === "disable") {
      var row = Model.findRow(rows, pendingId)
      cancelPending()
      if (row) startDisable(row)
      return
    }
    if (pendingKind === "add") {
      if (pendingId !== "" && pendingPlacementNeeded) {
        pendingKind = "place"
        return
      }
      startAdd("")
    } else if (pendingKind === "remove") {
      runAction("remove", pendingLabel, ["omarchy", "plugin", "remove", pendingId, "--yes"])
      cancelPending()
    }
  }

  // Run a command, then say what happened where the answer will still exist:
  // $1 summary, $2 detail, and everything after that is the command itself,
  // passed as separate arguments so none of it is ever parsed as shell.
  readonly property string noticeScript: ""
    + "set -u -o pipefail; "
    + "summary=\"$1\"; detail=\"$2\"; shift 2; "
    + "if ! err=$(\"$@\" 2>&1 >/dev/null | tail -1); then "
    + "  notify-send -a 'Plugin Manager' \"$summary failed\" \"$err\"; exit 1; "
    + "fi; "
    + "notify-send -a 'Plugin Manager' \"$summary\" \"$detail\""

  // Clone, then place — as one detached command.
  //
  // Detached is not an optimisation, it is the requirement. The moment the
  // clone lands in ~/.config/omarchy/plugins the shell tears every plugin
  // widget down and rebuilds it, this panel among them, and a Process owned by
  // a destroyed panel cannot be relied on to finish. The placement would be
  // the half that got dropped.
  //
  // What is given up is the status line, which nobody was going to read on a
  // panel that no longer exists. The script reports through a desktop
  // notification instead, which outlives all of this.
  function startAdd(section) {
    var url = pendingUrl
    var label = pendingLabel
    var id = pendingId
    cancelPending()

    // Positional arguments, never text spliced into the script, so no url can
    // become a command.
    Quickshell.execDetached(["bash", "-c", installScript, "install", url, id, section, label])
    setStatus(Model.actionGerund("add") + " " + label + "…", false)
  }

  // Update needs no confirmation: it is a fast-forward of a checkout the user
  // already chose to trust, and it destroys nothing.
  function startUpdate(row) {
    if (!row || !row.updatable || busy) return
    runAction("update", row.name, ["omarchy", "plugin", "update", row.id, "--yes"])
  }

  function runAction(kind, label, command) {
    if (busy || actionProc.running) return
    busyKind = kind
    busyId = label
    setStatus("", false)
    actionStderr = ""
    actionProc.command = command
    actionProc.running = true
  }

  // ---- Keyboard -----------------------------------------------------------

  // In a grid, "down" means the card below, not the next one along — so the
  // vertical step is a whole row. The list has one column, so its row step is
  // one either way.
  function moveSelection(dx, dy) {
    if (selectableCount === 0) return
    var step = browsing ? (dx !== 0 ? dx : dy * catalogGrid.columns) : dy
    if (step === 0) return

    var next = selectedIndex < 0 ? 0 : selectedIndex + step
    selectedIndex = Math.max(0, Math.min(selectableCount - 1, next))
    if (browsing) catalogGrid.positionViewAtIndex(selectedIndex, GridView.Contain)
  }

  // Called by whichever row just became selected. Asking the item where it
  // ended up beats computing its offset from row heights and header heights,
  // which silently goes wrong the moment either changes.
  function ensureVisible(item) {
    if (!item) return
    var top = item.mapToItem(listColumn, 0, 0).y
    var bottom = top + item.height
    if (top < listScroll.contentY) listScroll.contentY = top
    else if (bottom > listScroll.contentY + listScroll.height) listScroll.contentY = bottom - listScroll.height
  }

  function focusUrlField() {
    urlField.forceActiveFocus()
    urlField.selectAll()
  }

  function focusSearchField() {
    searchField.forceActiveFocus()
    searchField.selectAll()
  }

  function returnFocusToList() {
    Qt.callLater(function() { if (keyCatcher) keyCatcher.forceActiveFocus() })
  }

  onOpenedChanged: {
    if (!opened) return
    setStatus("", false)
    reload()
    checkUpdates()
  }

  // ---- Processes ----------------------------------------------------------

  // One round trip for the whole picture: enabled state from `plugin list`,
  // source directories and descriptions from `plugin catalog`, which checkouts
  // a pull can reach from the filesystem, and the author and version each
  // manifest declares. The section markers print unconditionally so a failed
  // command shows up as unparseable output rather than as a silently short
  // list.
  //
  // The catalog is fetched once and reused: it is also the only list of every
  // manifest path on the system, built-ins included, and running the command
  // twice would double the slowest step of the load.
  Process {
    id: loadProc
    command: ["bash", "-c",
      "catalog=$(omarchy plugin catalog); "
      + "printf '===list===\\n'; "
      + "omarchy plugin list --json; "
      + "printf '\\n===catalog===\\n'; "
      + "printf '%s' \"$catalog\"; "
      + "printf '\\n===git===\\n'; "
      + "for dir in \"$HOME\"/.config/omarchy/plugins/*/; do "
      + "  [ -d \"$dir/.git\" ] || continue; "
      + "  path=\"${dir%/}\"; "
      + "  printf '%s\\t%s\\n' \"$path\" \"$(git -C \"$path\" remote get-url origin 2>/dev/null)\"; "
      + "done; "
      + "printf '\\n===manifest===\\n'; "
      // One jq over every manifest at once rather than one process per plugin.
      // Fields the manifest omits print as empty columns, which is what the
      // parser expects; a manifest that will not parse simply contributes no
      // line and its row falls back to the id namespace.
      + "printf '%s' \"$catalog\" | jq -r '.[].manifestPath // empty' "
      + "  | tr '\\n' '\\0' "
      + "  | xargs -0 -r jq -r '[.id, (.author // \"\"), (.version // \"\")] | @tsv' 2>/dev/null"
    ]
    stdout: StdioCollector {
      waitForEnd: true
      onStreamFinished: root.applyLoad(text)
    }
  }

  // Clone, wait for the shell to notice, then place. Upstream's own
  // `--enable` path cannot be used for this: it reads the section from an
  // interactive `gum choose` that returns immediately under `--yes`, so it
  // would land the widget in whatever section the author nominated. The panel
  // asks first and passes the answer through here instead.
  //
  // Everything variable arrives as a positional argument, never spliced into
  // the text: $1 url, $2 plugin id, $3 section (any of which may be empty).
  readonly property string installScript: ""
    // pipefail matters here: the error text is taken through `| tail -1`, and
    // without it the pipeline would report tail's exit status — which always
    // succeeds — and every failed install would be announced as a success.
    + "set -u -o pipefail; "
    + "url=\"$1\"; id=\"$2\"; section=\"$3\"; label=\"$4\"; "
    + "note() { notify-send -a 'Plugin Manager' \"$1\" \"$2\"; }; "
    // stderr is captured and stdout dropped, then reduced to its last line:
    // the omarchy scripts put the reason there, and a notification body is no
    // place for a git transcript.
    + "if ! err=$(omarchy plugin add \"$url\" --yes 2>&1 >/dev/null | tail -1); then "
    + "  note \"Could not install $label\" \"$err\"; exit 1; "
    + "fi; "
    // No id means the url field, which cannot know what it is about to clone.
    // The plugin is added and left off; its row carries an Enable button.
    + "if [ -z \"$id\" ]; then "
    + "  note \"Added $label\" 'Enable it from the plugin manager.'; exit 0; "
    + "fi; "
    // The shell rescans asynchronously and `omarchy plugin enable` fails
    // outright on an id it has not discovered yet — the same wait upstream
    // does before its own enable.
    + "for _ in $(seq 40); do "
    + "  omarchy plugin list --json | jq -e --arg id \"$id\" 'any(.[]; .id == $id)' >/dev/null 2>&1 && break; "
    + "  sleep 0.05; "
    + "done; "
    + "if ! err=$(omarchy plugin enable \"$id\" ${section:+\"$section\"} 2>&1 >/dev/null | tail -1); then "
    + "  note \"Added $label, but could not enable it\" \"$err\"; exit 1; "
    + "fi; "
    + "if [ -n \"$section\" ]; then note \"Installed $label\" \"Placed in the $section section of the bar.\"; "
    + "else note \"Installed $label\" 'Enabled.'; fi"

  // Fetch, shrink, cache. The published catalog is 1.6MB of which we need
  // about a third, and jq — an Omarchy dependency — projects it down before
  // any of it reaches the shell's JSON parser. A fetch that fails falls back
  // to the cached copy rather than emptying the grid: a stale storefront is
  // far more useful than an apparently empty one.
  readonly property string catalogScript: ""
    + "set -u; "
    + "dir=\"$HOME/.cache/omarchy-plugin-manager\"; file=\"$dir/catalog.json\"; "
    + "mkdir -p \"$dir\"; "
    + "if [ \"$1\" != 1 ] && [ -s \"$file\" ]; then "
    + "  age=$(( $(date +%s) - $(stat -c %Y \"$file\") )); "
    + "  if [ \"$age\" -lt 21600 ]; then cat \"$file\"; exit 0; fi; "
    + "fi; "
    + "tmp=$(mktemp); "
    + "if curl -fsSL --max-time 25 " + Model.CATALOG_URL + " "
    + "   | jq -c '{generatedAt, plugins: [.plugins[] | {id,name,description,author,version,category,tags,kind,repo,installCommand,installAvailable,installNote,verificationStatus,sourceType,stars,accent,initials,license,previewThumbnail,listingValidatedBranch}]}' > \"$tmp\" 2>/dev/null "
    + "   && [ -s \"$tmp\" ]; then "
    + "  mv \"$tmp\" \"$file\"; cat \"$file\"; "
    + "else "
    + "  rm -f \"$tmp\"; "
    + "  if [ -s \"$file\" ]; then cat \"$file\"; else exit 1; fi; "
    + "fi"

  // No fetch and no clone: ls-remote asks the remote for one sha and downloads
  // nothing, so eleven checkouts resolve in about a second. The manifest is
  // read only for the ones actually behind, pinned to the exact remote commit.
  readonly property string updateScript: ""
    + "set -u; export GIT_TERMINAL_PROMPT=0 GIT_ASKPASS=/bin/true; "
    + "for dir in \"$HOME\"/.config/omarchy/plugins/*/; do "
    + "  [ -d \"$dir/.git\" ] || continue; "
    + "  ( path=\"${dir%/}\"; "
    + "    branch=$(git -C \"$path\" rev-parse --abbrev-ref HEAD 2>/dev/null); "
    + "    local_sha=$(git -C \"$path\" rev-parse HEAD 2>/dev/null); "
    + "    remote_sha=$(timeout 12 git -C \"$path\" ls-remote origin \"refs/heads/$branch\" 2>/dev/null | cut -f1); "
    + "    local_version=$(jq -r '.version // \"\"' \"$path/manifest.json\" 2>/dev/null); "
    + "    remote_version=\"\"; "
    + "    if [ -n \"$remote_sha\" ] && [ \"$remote_sha\" != \"$local_sha\" ]; then "
    + "      origin=$(git -C \"$path\" remote get-url origin 2>/dev/null); "
    + "      case \"$origin\" in https://github.com/*) "
    + "        slug=${origin#https://github.com/}; slug=${slug%.git}; "
    + "        remote_version=$(curl -fsSL --max-time 8 \"https://raw.githubusercontent.com/$slug/$remote_sha/manifest.json\" 2>/dev/null | jq -r '.version // \"\"' 2>/dev/null); "
    + "      ;; esac; "
    + "    fi; "
    + "    printf '%s\\t%s\\t%s\\t%s\\t%s\\n' \"$path\" \"$local_sha\" \"$remote_sha\" \"$local_version\" \"$remote_version\"; "
    + "  ) & "
    + "done; wait"

  Process {
    id: updateProc
    command: ["bash", "-c", root.updateScript]
    stdout: StdioCollector {
      waitForEnd: true
      onStreamFinished: root.applyUpdateReport(text)
    }
    onExited: function(exitCode) { root.checkingUpdates = false }
  }

  Process {
    id: catalogProc
    stdout: StdioCollector {
      waitForEnd: true
      onStreamFinished: root.applyCatalog(text)
    }
    onExited: function(exitCode) {
      if (exitCode === 0) return
      root.catalogLoading = false
      root.catalogError = "Could not reach omarchyplugins.com"
    }
  }

  Process {
    id: actionProc
    stdout: StdioCollector { waitForEnd: true }

    // Exit and stream-finished have no guaranteed order. When a failed exit
    // beats the collector it publishes the exit-code message; the specific
    // one replaces it once stderr lands.
    stderr: StdioCollector {
      waitForEnd: true
      onStreamFinished: {
        root.actionStderr = String(text || "").trim()
        if (root.statusIsError && root.actionStderr !== "")
          root.setStatus(Model.failureMessage(root.lastActionKind, root.actionStderr, root.lastExitCode), true)
      }
    }

    onExited: function(exitCode) {
      var kind = root.busyKind
      var label = root.busyId

      root.lastActionKind = kind
      root.lastExitCode = exitCode
      root.busyKind = ""
      root.busyId = ""

      if (exitCode === 0) {
        root.setStatus(Model.successMessage(kind, label), false)
        if (kind === "add") urlField.text = ""
      } else {
        root.setStatus(Model.failureMessage(kind, root.actionStderr, exitCode), true)
      }

      root.reload()
    }
  }

  // ---- Surface ------------------------------------------------------------

  KeyboardPanel {
    id: panel
    anchorItem: root.anchorItem
    owner: root.barIdentity
    bar: root.bar
    open: root.opened
    focusTarget: keyCatcher
    contentWidth: panel.fittedContentWidth(Style.space(620))

    // The height the panel would like: fixed chrome plus however tall the
    // full list would be. fittedContentHeight clamps that to what the screen
    // allows, and because the list is anchored between the header and the
    // hints rather than given a height of its own, the clamp comes out of the
    // list instead of pushing the bottom of the panel off screen.
    // The cap keeps this a popup rather than a full-height column: with
    // forty-odd plugins the list would otherwise grow to the screen edge
    // every time. Past the cap the list scrolls, which it was built to do.
    contentHeight: panel.fittedContentHeight(
      header.implicitHeight
        + (root.browsing ? Style.space(500) : listColumn.implicitHeight)
        + hints.implicitHeight + Style.space(20),
      Style.space(500))

    PanelKeyCatcher {
      id: keyCatcher
      anchors.fill: parent
      blocked: root.confirming || root.placing || urlField.activeFocus || searchField.activeFocus

      onMoveRequested: function(dx, dy) { root.moveSelection(dx, dy) }
      onActivateRequested: root.browsing ? root.askInstall(root.selectedEntry) : root.startUpdate(root.selectedRow)
      onDeleteRequested: if (!root.browsing) root.askRemove(root.selectedRow)
      onCloseRequested: root.close()
      onTabRequested: function(direction) { root.switchPanel(direction) }
      onTextKey: function(t) {
        if (t === "/") root.focusSearchField()
        else if (t === "r" || t === "R") root.reload()
        else if (t === "a" || t === "A") root.focusUrlField()
        else if (t === "f" || t === "F") root.cycleKindFilter()
        else if (t === "j") root.moveSelection(0, 1)
        else if (t === "k") root.moveSelection(0, -1)
        else if (t === "1") root.switchTab("installed")
        else if (t === "2") root.switchTab("browse")
      }

      // ---- Fixed chrome, pinned to the top.
      Column {
        id: header
        anchors.left: parent.left
        anchors.right: parent.right
        anchors.top: parent.top
        spacing: Style.space(10)

        // What this is, how much of it there is, and a way to re-read without
        // closing the panel.
        Item {
          width: parent.width
          height: Math.max(title.implicitHeight, refreshButton.height)

          Text {
            id: title
            // Never rich text: AutoText would fetch what a crafted string points at.
            textFormat: Text.PlainText
            anchors.verticalCenter: parent.verticalCenter
            text: "Plugins"
            color: root.contentForeground
            font.family: root.contentFontFamily
            font.pixelSize: Style.font.title
            font.bold: true
          }

          Text {
            // Never rich text: AutoText would fetch what a crafted string points at.
            textFormat: Text.PlainText
            anchors.left: title.right
            anchors.leftMargin: Style.space(10)
            anchors.baseline: title.baseline
            text: {
              if (root.browsing) {
                if (root.catalogLoading && root.catalog.length === 0) return "fetching catalog…"
                if (root.catalog.length === 0) return ""
                return "showing " + root.visibleCatalog.length + " of " + root.catalog.length
              }
              if (root.loading && root.rows.length === 0) return "reading…"
              if (root.filtered) return "showing " + root.visibleRows.length + " of " + root.rows.length
              var summary = root.installedTotal + " installed  ·  " + root.rows.length + " total"
              if (root.behindCount > 0) return summary + "  ·  " + root.behindCount + " to update"
              return summary
            }
            color: Color.muted
            font.family: root.contentFontFamily
            font.pixelSize: Style.font.caption
          }

          ButtonGroup {
            id: tabs
            anchors.right: refreshButton.left
            anchors.rightMargin: Style.space(10)
            anchors.verticalCenter: parent.verticalCenter
            options: root.tabOptions
            value: root.activeTab
            foreground: root.contentForeground
            fontFamily: root.contentFontFamily
            fontSize: Style.font.caption
            focusable: false
            onChanged: function(value) { root.switchTab(value) }
          }

          PanelActionButton {
            id: refreshButton
            anchors.right: parent.right
            anchors.verticalCenter: parent.verticalCenter
            iconText: "󰑐"
            tooltipText: root.browsing ? "Re-fetch the catalog" : "Re-read the plugin list"
            foreground: root.contentForeground
            fontFamily: root.contentFontFamily
            enabled: !root.loading && !root.catalogLoading && !root.busy
            opacity: enabled ? 1 : 0.4
            // Forced past the cache: the refresh button exists precisely for
            // when you believe what is on screen is out of date.
            onClicked: {
              if (root.browsing) { root.loadCatalog(true); return }
              root.reload()
              root.checkUpdates()
            }
          }
        }

        // ---- Add: a repository url and one button. Confirmed before it runs.
        //      Only on the Installed tab — on Browse you install by clicking a
        //      card, and this is the escape hatch for repos the catalog has
        //      never heard of.
        Item {
          width: parent.width
          visible: !root.browsing
          height: visible ? Math.max(urlField.implicitHeight, addButton.height) : 0

          TextField {
            id: urlField
            anchors.left: parent.left
            anchors.right: addButton.left
            anchors.rightMargin: Style.space(8)
            anchors.verticalCenter: parent.verticalCenter
            enabled: !root.busy
            placeholderText: "https://github.com/user/omarchy-plugin.git"
            foreground: root.contentForeground
            font.family: root.contentFontFamily
            font.pixelSize: Style.font.bodySmall

            onAccepted: root.askAdd()
            Keys.onPressed: function(event) {
              if (event.key !== Qt.Key_Escape) return
              root.returnFocusToList()
              event.accepted = true
            }
          }

          PanelActionButton {
            id: addButton
            anchors.right: parent.right
            anchors.verticalCenter: parent.verticalCenter
            iconText: root.busyKind === "add" ? "󰇘" : "󰐕"
            tooltipText: "Clone and enable this repository"
            foreground: root.contentForeground
            fontFamily: root.contentFontFamily
            bordered: true
            enabled: !root.busy && Model.isValidGitUrl(urlField.text)
            opacity: enabled ? 1 : 0.4
            onClicked: root.askAdd()
          }
        }

        PanelSeparator { foreground: root.contentForeground }

        // ---- Both narrowing controls on one line. They do the same job, and
        //      a panel this tall cannot afford a row each: the kind chips at
        //      their natural width, the search box taking whatever is left.
        Item {
          width: parent.width
          height: Math.max(root.browsing ? categoryDropdown.implicitHeight : kindFilterGroup.implicitHeight,
                           searchField.implicitHeight)

          // Installed filters on six kinds, which fit as chips. Browse filters
          // on fourteen categories, which do not — that is a dropdown's job.
          ButtonGroup {
            id: kindFilterGroup
            anchors.left: parent.left
            anchors.verticalCenter: parent.verticalCenter
            visible: !root.browsing
            width: visible ? implicitWidth : 0
            options: root.kindOptions
            value: root.kindFilter
            foreground: root.contentForeground
            fontFamily: root.contentFontFamily
            fontSize: Style.font.caption
            focusable: false
            onChanged: function(value) { root.setKindFilter(value) }
          }

          Dropdown {
            id: categoryDropdown
            anchors.left: parent.left
            anchors.verticalCenter: parent.verticalCenter
            visible: root.browsing
            width: visible ? Style.spacing.dropdownWidth : 0
            showLabel: false
            options: root.categoryOptions
            value: root.categoryFilter
            foreground: root.contentForeground
            fontFamily: root.contentFontFamily
            onChanged: function(value) { root.setCategoryFilter(value) }
          }

          TextField {
            id: searchField
            anchors.left: root.browsing ? categoryDropdown.right : kindFilterGroup.right
            anchors.leftMargin: Style.space(10)
            anchors.right: clearSearchButton.visible ? clearSearchButton.left : parent.right
            anchors.rightMargin: clearSearchButton.visible ? Style.space(4) : 0
            anchors.verticalCenter: parent.verticalCenter
            // The glyph rides in the placeholder rather than sitting in its
            // own column, because every pixel on this row belongs to the two
            // controls sharing it.
            placeholderText: root.browsing ? "󰍉  Search the catalog…" : "󰍉  Search by name…"
            foreground: root.contentForeground
            font.family: root.contentFontFamily
            font.pixelSize: Style.font.caption
            verticalPadding: Style.spacing.xs

            // Enter hands the list back the keyboard with the results in
            // place, so you can type a name and arrow straight into it.
            onAccepted: root.returnFocusToList()
            Keys.onPressed: function(event) {
              if (event.key !== Qt.Key_Escape) return
              // Escape clears before it leaves: a search box that keeps a
              // stale term after you back out of it silently hides plugins.
              if (searchField.text !== "") root.clearSearch()
              else root.returnFocusToList()
              event.accepted = true
            }
          }

          PanelActionButton {
            id: clearSearchButton
            anchors.right: parent.right
            anchors.verticalCenter: parent.verticalCenter
            visible: root.searchQuery !== ""
            iconText: "󰅙"
            tooltipText: "Clear the search"
            foreground: root.contentForeground
            fontFamily: root.contentFontFamily
            onClicked: {
              root.clearSearch()
              root.returnFocusToList()
            }
          }
        }

        // ---- Status: the last thing that happened, good or bad. Only takes
        //      up room when there is something to say.
        Text {
          // Never rich text: AutoText would fetch what a crafted string points at.
          textFormat: Text.PlainText
          width: parent.width
          visible: text !== ""
          text: {
            if (root.busy) return Model.actionGerund(root.busyKind) + " " + root.busyId + "…"
            if (root.browsing && root.catalogError !== "") return root.catalogError
            if (!root.browsing && root.loadError !== "") return root.loadError
            return root.status
          }
          color: root.statusIsError || root.loadError !== "" || root.catalogError !== "" ? Color.urgent : Color.muted
          font.family: root.contentFontFamily
          font.pixelSize: Style.font.caption
          wrapMode: Text.WordWrap
        }
      }

      // ---- Key hints, pinned to the bottom so the list above can never push
      //      them off the card.
      Text {
        id: hints
        // Never rich text: AutoText would fetch what a crafted string points at.
        textFormat: Text.PlainText
        anchors.left: parent.left
        anchors.right: parent.right
        anchors.bottom: parent.bottom
        text: root.browsing
          ? "←↑↓→ select   ⏎ install   / search   1 installed   r refresh"
          : "↑↓ select   ⏎ update   ⌦ remove   / search   a add   f filter   2 browse"
        color: Color.muted
        font.family: root.contentFontFamily
        font.pixelSize: Style.font.caption
        horizontalAlignment: Text.AlignHCenter
      }

      // ---- The two lists, in one scroll region so the sections read as
      //      parts of a single inventory rather than two separate panes.
      //      Anchored between the chrome above and below: whatever height is
      //      left over is exactly what it gets.
      Flickable {
        id: listScroll
        visible: !root.browsing
        anchors.left: parent.left
        anchors.right: parent.right
        anchors.top: header.bottom
        anchors.topMargin: Style.space(10)
        anchors.bottom: hints.top
        anchors.bottomMargin: Style.space(10)
        contentWidth: width
        contentHeight: listColumn.implicitHeight
        clip: true
        boundsBehavior: Flickable.StopAtBounds
        interactive: contentHeight > height

        Column {
          id: listColumn
          width: listScroll.width
          spacing: Style.space(2)

          Text {
            // Never rich text: AutoText would fetch what a crafted string points at.
            textFormat: Text.PlainText
            width: parent.width
            visible: root.visibleRows.length === 0 && root.rows.length > 0
            text: Model.emptyMessage(root.kindFilter, root.searchQuery)
            color: Color.muted
            font.family: root.contentFontFamily
            font.pixelSize: Style.font.caption
            topPadding: Style.space(12)
            bottomPadding: Style.space(12)
            horizontalAlignment: Text.AlignHCenter
          }

          PanelSectionHeader {
            visible: root.installedRows.length > 0
            text: Model.sectionHeading(root.visibleRows, "installed")
            foreground: root.contentForeground
            fontFamily: root.contentFontFamily
            bottomPadding: Style.space(4)
          }

          Repeater {
            model: root.installedRows

            PluginRow {
              required property int index
              required property var modelData

              width: listColumn.width
              row: modelData
              selected: root.selectedIndex === index
              actionsEnabled: !root.busy
              foreground: root.contentForeground
              fontFamily: root.contentFontFamily

              onSelectedChanged: if (selected) root.ensureVisible(this)
              onClicked: root.selectedIndex = index
              onUpdateRequested: {
                root.selectedIndex = index
                root.startUpdate(modelData)
              }
              onRemoveRequested: {
                root.selectedIndex = index
                root.askRemove(modelData)
              }
              onEnableRequested: {
                root.selectedIndex = index
                root.askEnable(modelData)
              }
              onDisableRequested: {
                root.selectedIndex = index
                root.askDisable(modelData)
              }
            }
          }

          PanelSectionHeader {
            visible: root.builtinRows.length > 0
            text: Model.sectionHeading(root.visibleRows, "built-in")
            foreground: root.contentForeground
            fontFamily: root.contentFontFamily
            topPadding: Style.space(12)
            bottomPadding: Style.space(4)
          }

          Repeater {
            model: root.builtinRows

            PluginRow {
              required property int index
              required property var modelData

              // Built-ins follow the installed list in the same flat order,
              // so their global index is offset by however many came first.
              readonly property int globalIndex: root.installedRows.length + index

              width: listColumn.width
              row: modelData
              selected: root.selectedIndex === globalIndex
              actionsEnabled: !root.busy
              foreground: root.contentForeground
              fontFamily: root.contentFontFamily

              onSelectedChanged: if (selected) root.ensureVisible(this)
              onClicked: root.selectedIndex = globalIndex
              // A built-in cannot be pulled or deleted, but it can certainly
              // be sitting there switched off — same problem, same answer.
              onEnableRequested: {
                root.selectedIndex = globalIndex
                root.askEnable(modelData)
              }
              onDisableRequested: {
                root.selectedIndex = globalIndex
                root.askDisable(modelData)
              }
            }
          }
        }
      }

      // ---- Browse: the marketplace as a grid of cards. A GridView rather
      //      than a Repeater because this list is 700-odd entries long and
      //      every card owns a network image — only the visible ones may be
      //      built, or opening the tab would fetch the whole storefront.
      GridView {
        id: catalogGrid
        visible: root.browsing
        anchors.left: parent.left
        anchors.right: parent.right
        anchors.top: header.bottom
        anchors.topMargin: Style.space(10)
        anchors.bottom: hints.top
        anchors.bottomMargin: Style.space(10)
        clip: true
        boundsBehavior: Flickable.StopAtBounds
        cacheBuffer: Math.round(cellHeight * 2)

        readonly property int columns: 3
        cellWidth: Math.floor(width / columns)

        // Derived rather than guessed: a 16:9 preview, one line of name, five
        // of description, one for the repository link, and the footer. A magic
        // constant here would clip the blurb the moment the user's font size
        // moved.
        cellHeight: Math.round((cellWidth - Style.space(8)) * 9 / 16)
          + Math.ceil(cardNameMetrics.lineSpacing)
          + Math.ceil(cardTextMetrics.lineSpacing * 6)
          + Style.space(74)

        FontMetrics {
          id: cardNameMetrics
          font.family: root.contentFontFamily
          font.pixelSize: Style.font.bodySmall
        }

        FontMetrics {
          id: cardTextMetrics
          font.family: root.contentFontFamily
          font.pixelSize: Style.font.caption
        }

        model: root.visibleCatalog

        delegate: Item {
          required property int index
          required property var modelData

          width: catalogGrid.cellWidth
          height: catalogGrid.cellHeight

          CatalogCard {
            anchors.fill: parent
            anchors.margins: Style.space(4)
            entry: modelData
            selected: root.selectedIndex === index
            actionsEnabled: !root.busy
            previewsEnabled: root.previewsSupported
            foreground: root.contentForeground
            fontFamily: root.contentFontFamily

            onPreviewUndecodable: root.previewsSupported = false
            onClicked: root.selectedIndex = index
            onInstallRequested: {
              root.selectedIndex = index
              root.askInstall(modelData)
            }
          }
        }

        // Empty and loading are different states and read differently: one
        // says the fetch is still running, the other that the filters matched
        // nothing.
        Text {
          // Never rich text: AutoText would fetch what a crafted string points at.
          textFormat: Text.PlainText
          anchors.centerIn: parent
          width: parent.width - Style.space(40)
          visible: root.visibleCatalog.length === 0
          text: {
            if (root.catalogLoading) return "Fetching the catalog from omarchyplugins.com…"
            if (root.catalogError !== "") return root.catalogError
            if (root.catalog.length === 0) return "No catalog yet."
            return Model.catalogEmptyMessage(root.categoryFilter, root.searchQuery)
          }
          color: Color.muted
          font.family: root.contentFontFamily
          font.pixelSize: Style.font.caption
          wrapMode: Text.WordWrap
          horizontalAlignment: Text.AlignHCenter
        }
      }

      ConfirmDialog {
        id: confirm
        anchors.fill: parent
        z: 10
        opened: root.confirming
        message: root.confirmMessage
        confirmText: Model.actionVerb(root.pendingKind) === "Action"
          ? "Add"
          : Model.actionVerb(root.pendingKind)
        background: Color.popups.background
        foreground: root.contentForeground
        fontFamily: root.contentFontFamily

        onOpenedChanged: {
          if (opened) forceActiveFocus()
          else Qt.callLater(function() { if (keyCatcher) keyCatcher.forceActiveFocus() })
        }

        Keys.onPressed: function(event) {
          if (confirm.handleKey(event)) event.accepted = true
        }

        onCanceled: root.cancelPending()
        onConfirmed: root.confirmPending()
      }

      ChoiceDialog {
        id: placement
        anchors.fill: parent
        z: 10
        opened: root.placing
        message: root.placementMessage
        choices: root.placementChoices
        background: Color.popups.background
        foreground: root.contentForeground
        fontFamily: root.contentFontFamily

        onOpenedChanged: {
          if (opened) forceActiveFocus()
          else Qt.callLater(function() { if (keyCatcher) keyCatcher.forceActiveFocus() })
        }

        Keys.onPressed: function(event) {
          if (placement.handleKey(event)) event.accepted = true
        }

        onCanceled: root.cancelPending()
        onChosen: function(value) { root.confirmPlacement(value) }
      }
    }
  }
}
