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
// thing to do on a mis-click. Adding happens only from a Browse card; there
// is no free-text url field, so every url comes from a catalog entry.
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
  // Secondary copy follows the panel's own text role instead of the palette's
  // much darker generic muted swatch. At 54% over the current popup surface it
  // remains subordinate to descriptions while staying well above that swatch.
  readonly property color secondaryForeground: Util.alpha(contentForeground, 0.54)

  // ---- Data ---------------------------------------------------------------

  property var rows: []
  property bool loading: false
  property string loadError: ""
  property int selectedIndex: -1

  property string groupFilter: "all"
  readonly property var groupOptions: Model.groupOptions()
  property string kindFilter: "all"
  readonly property var kindOptions: Model.kindOptions(rows)
  property string statusFilter: "all"
  readonly property var statusOptions: Model.statusOptions()
  readonly property string searchQuery: searchField.text

  // A reload can remove the last plugin of a kind. Falling back immediately
  // keeps the filter visible and truthful instead of retaining a hidden value.
  onKindOptionsChanged: {
    for (var i = 0; i < kindOptions.length; i++)
      if (kindOptions[i].value === kindFilter) return
    setKindFilter("all")
  }
  // Dropdown selection assigns its own value, so replay later model changes.
  onKindFilterChanged: if (kindDropdown && kindDropdown.value !== kindFilter)
    kindDropdown.value = kindFilter

  // One flat filtered list drives selection; the two section slices below are
  // views onto it, in the same order, so a single index addresses both.
  readonly property var visibleRows: Model.filterRows(rows, kindFilter, statusFilter, searchQuery, groupFilter)
  readonly property var installedRows: Model.rowsInGroup(visibleRows, "installed")
  readonly property var builtinRows: Model.rowsInGroup(visibleRows, "built-in")

  // Checked in the background after the rows are already on screen, so the
  // panel never waits on the network to show you what you have installed.
  property bool checkingUpdates: false
  readonly property int behindCount: Model.countBehind(rows)

  // A Process is reusable only after both its exit and collector callbacks
  // have settled. The callbacks may arrive in either order, so `running` alone
  // is not enough to decide that a fresh load/check pair can safely start.
  property bool loadProcessExited: true
  property bool loadOutputFinished: true
  property bool updateProcessExited: true
  property bool updateOutputFinished: true
  property bool freshUpdateCycleQueued: false
  readonly property bool updateActionsEnabled:
    !busy && loadProcessSettled() && updateProcessSettled()

  // One click-time release probe for the whole panel. Every explicit
  // navigation or action advances this generation state, so callbacks from an
  // older process can settle it but never recover superseded URLs.
  property var releaseNavigationState: Model.releaseNavigationInitialState()
  readonly property bool releaseProbeBusy: releaseNavigationState.activeGeneration !== 0

  readonly property int installedTotal: Model.countRemovable(rows)
  readonly property bool filtered: Model.isFiltering(kindFilter, statusFilter, searchQuery, groupFilter)
  readonly property var installedFilterHints: Model.installedFilterHints(
    { group: groupFilter, kind: kindFilter, status: statusFilter },
    { group: groupOptions, kind: kindOptions, status: statusOptions })

  // ---- Browse tab ---------------------------------------------------------
  //
  // The marketplace catalog omarchyplugins.com publishes. Read from the disk
  // cache when the panel opens — it is also what tells the Installed rows who
  // is verified — and fetched afresh on the Browse tab's refresh.

  property string activeTab: "installed"   // "installed" | "browse"
  readonly property bool browsing: activeTab === "browse"
  readonly property var tabOptions: [
    { value: "installed", label: "Installed" },
    { value: "browse", label: "Browse" }
  ]

  property var catalog: []
  readonly property var verifiedIds: Model.verifiedIdSet(catalog)
  property bool catalogLoading: false
  property bool catalogLoaded: false
  property string catalogError: ""
  property string categoryFilter: "all"
  property string catalogKindFilter: "all"
  property string availabilityFilter: "all"
  property string catalogSort: "recently-added"

  // The registry's previews are WebP, which Qt only decodes when
  // qt6-imageformats is installed. Rather than probing for it, the first card
  // that fails tells us, and every card falls back to the registry's own
  // accent-and-initials tile from then on.
  property bool previewsSupported: true

  readonly property var categoryOptions: Model.catalogCategories(catalog)
  readonly property var catalogKindOptions: Model.catalogKindOptions(catalog)
  readonly property var availabilityOptions: Model.catalogAvailabilityOptions()
  readonly property var catalogSortOptions: Model.catalogSortOptions()
  readonly property bool catalogFiltered: Model.catalogIsFiltering(
    categoryFilter, catalogKindFilter, availabilityFilter, searchQuery)
  readonly property var filteredCatalog: Model.filterCatalog(
    catalog, categoryFilter, catalogKindFilter, availabilityFilter, searchQuery)
  readonly property var visibleCatalog: Model.sortCatalog(filteredCatalog, catalogSort)
  readonly property var browseFilterHints: Model.browseFilterHints(
    { category: categoryFilter, kind: catalogKindFilter, availability: availabilityFilter, sort: catalogSort },
    { category: categoryOptions, kind: catalogKindOptions, availability: availabilityOptions, sort: catalogSortOptions })

  onCategoryOptionsChanged: {
    for (var i = 0; i < categoryOptions.length; i++)
      if (categoryOptions[i].value === categoryFilter) return
    setCategoryFilter("all")
  }
  onCatalogKindOptionsChanged: {
    for (var i = 0; i < catalogKindOptions.length; i++)
      if (catalogKindOptions[i].value === catalogKindFilter) return
    setCatalogKindFilter("all")
  }

  property var detailsEntry: null
  readonly property bool detailsOpen: detailsEntry !== null

  function switchTab(tab) {
    if (activeTab === tab) return
    revokeReleaseNavigation()
    closeDetails()
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
    var stampedState = Model.restampCatalogInstallState(
      catalog, Model.installedIdSet(rows), detailsEntry)
    catalog = stampedState.entries
    if (detailsEntry) detailsEntry = stampedState.detailsEntry
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
        + Model.catalogPlacementConfirmationNote(pendingPlacementNeeded)
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

  function loadProcessSettled() {
    return !loadProc.running && root.loadProcessExited && root.loadOutputFinished
  }

  function updateProcessSettled() {
    return !updateProc.running && root.updateProcessExited && root.updateOutputFinished
  }

  function reload() {
    root.revokeReleaseNavigation()
    if (!root.loadProcessSettled()) return false
    root.loadProcessExited = false
    root.loadOutputFinished = false
    root.loading = true
    loadProc.running = true
    return true
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
    if (!root.updateProcessSettled()) return false
    root.updateProcessExited = false
    root.updateOutputFinished = false
    root.checkingUpdates = true
    updateProc.running = true
    return true
  }

  // A successful pull invalidates both snapshots. One bounded bit remembers
  // that debt while either old process settles; repeated requests coalesce.
  // The replacement load/check pair starts together only when both reusable
  // Process objects have completed both lifecycle callbacks.
  function requestFreshUpdateCycle() {
    root.freshUpdateCycleQueued = true
    root.drainFreshUpdateCycle()
  }

  function drainFreshUpdateCycle() {
    if (!root.freshUpdateCycleQueued
        || !root.loadProcessSettled() || !root.updateProcessSettled()) return false
    root.freshUpdateCycleQueued = false
    root.reload()
    root.checkUpdates()
    return true
  }

  // Held so a report that lands while the rows are being rebuilt is not lost.
  // Model.applyUpdateReport binds every replay to the freshly loaded checkout
  // HEAD, so an old generation can remain pending without regaining authority.
  property string pendingUpdateReport: ""

  function applyUpdateReport(raw) {
    checkingUpdates = false
    pendingUpdateReport = raw
    if (rows.length === 0) return
    rows = Model.applyUpdateReport(rows, Model.parseUpdateReport(raw))
  }

  // The only browser-launching sink in the panel. Callers hand it URLs already
  // accepted by a Model transition; the argv remains one isolated URL.
  function openBrowserUrl(url) {
    var trusted = Model.browsableUrl(url)
    if (trusted !== "") Quickshell.execDetached(["omarchy-launch-browser", trusted])
  }

  function applyReleaseNavigationTransition(transition) {
    if (!transition) return
    releaseNavigationState = transition.state
    if (transition.stopProbe && releaseProbe.running) releaseProbe.running = false
    if (transition.startRequest) startReleaseProbe(transition.startRequest)
    if (transition.openUrl !== "") openBrowserUrl(transition.openUrl)
    if (transition.scheduleStart) Qt.callLater(function() {
      applyReleaseNavigationTransition(
        Model.releaseNavigationStartQueuedTransition(releaseNavigationState))
    })
  }

  function startReleaseProbe(entry) {
    if (!entry || entry.generation !== releaseNavigationState.activeGeneration) return
    var command = Model.releaseProbeCommand(entry.probeUrl)
    if (command.length === 0) {
      applyReleaseNavigationTransition(
        Model.releaseNavigationProbeStartFailedTransition(releaseNavigationState))
      return
    }
    releaseProbe.command = command
    releaseProbe.running = true
  }

  function requestGithubNavigation(candidates, fallbackUrl) {
    var request = Model.githubNavigationRequest(candidates, fallbackUrl)
    applyReleaseNavigationTransition(
      Model.releaseNavigationRequestTransition(releaseNavigationState, request))
  }

  function navigateExternalUrl(url) {
    applyReleaseNavigationTransition(
      Model.releaseNavigationDirectTransition(releaseNavigationState, url))
  }

  function revokeReleaseNavigation() {
    applyReleaseNavigationTransition(
      Model.releaseNavigationRevokeTransition(releaseNavigationState))
  }

  // ---- Filtering ----------------------------------------------------------

  function setGroupFilter(group) {
    if (groupFilter === group) return
    groupFilter = group
    resetSelection()
  }

  function setKindFilter(kind) {
    if (kindFilter === kind) return
    kindFilter = kind
    resetSelection()
  }

  function setStatusFilter(status) {
    if (statusFilter === status) return
    statusFilter = status
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

  function setCatalogKindFilter(kind) {
    if (catalogKindFilter === kind) return
    catalogKindFilter = kind
    resetSelection()
  }

  function setAvailabilityFilter(availability) {
    if (availabilityFilter === availability) return
    availabilityFilter = availability
    resetSelection()
  }

  function setCatalogSort(sort) {
    if (catalogSort === sort) return
    catalogSort = sort
    resetSelection()
  }

  // One key per Browse dropdown, each walking its own option list; the hint
  // row under the grid shows where each one currently stands.
  function cycleCategoryFilter() {
    setCategoryFilter(Model.nextOption(categoryOptions, categoryFilter))
  }

  function cycleCatalogKindFilter() {
    setCatalogKindFilter(Model.nextOption(catalogKindOptions, catalogKindFilter))
  }

  function cycleAvailabilityFilter() {
    setAvailabilityFilter(Model.nextOption(availabilityOptions, availabilityFilter))
  }

  function cycleCatalogSort() {
    setCatalogSort(Model.nextOption(catalogSortOptions, catalogSort))
  }

  function clearCatalogFilters() {
    var cleared = Model.clearedCatalogFilters()
    categoryFilter = cleared.category
    catalogKindFilter = cleared.kind
    availabilityFilter = cleared.availability
    searchField.text = cleared.query
    resetSelection()
  }

  function openDetails(entry) {
    if (!entry) return
    revokeReleaseNavigation()
    detailsEntry = entry
  }

  function closeDetails() {
    revokeReleaseNavigation()
    detailsEntry = null
  }

  // ---- Catalog ------------------------------------------------------------

  function loadCatalog(force) {
    if (catalogProc.running) return
    revokeReleaseNavigation()
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

    var loadedCatalog = Model.catalogEntries(doc, Model.installedIdSet(rows))
    catalog = loadedCatalog
    if (detailsEntry) detailsEntry = Model.findRow(loadedCatalog, detailsEntry.id)
    catalogLoaded = true
    catalogError = ""
  }

  // Installing from the catalog runs the same argv array as the url field —
  // the registry's own install command is read for its url and never executed.
  function askInstall(entry) {
    if (!entry || !entry.installable || busy) return
    revokeReleaseNavigation()
    pendingUrl = entry.installUrl
    pendingLabel = entry.name
    pendingId = entry.id
    pendingVerified = entry.verified === true
    pendingPlacementNeeded = Model.catalogNeedsPlacement(entry)
    pendingKind = "add"
    // Open the successor before closing details. Modal focus ownership gives
    // confirmation priority during this intentional one-turn overlap.
    detailsEntry = null
  }

  function cycleGroupFilter() {
    setGroupFilter(Model.nextOption(groupOptions, groupFilter))
  }

  function cycleKindFilter() {
    setKindFilter(Model.nextOption(kindOptions, kindFilter))
  }

  function cycleStatusFilter() {
    setStatusFilter(Model.nextOption(statusOptions, statusFilter))
  }

  function clampSelection() {
    if (selectedIndex >= visibleRows.length) selectedIndex = visibleRows.length - 1
  }

  // ---- Actions ------------------------------------------------------------

  function setStatus(text, isError) {
    status = text
    statusIsError = isError === true
  }

  function askRemove(row) {
    if (!row || !row.removable || busy) return
    revokeReleaseNavigation()
    pendingId = row.id
    pendingLabel = row.name
    pendingUrl = ""
    pendingKind = "remove"
  }

  // Enabling is not destructive and needs no "are you sure" — but a bar widget
  // has to be told where it goes, and only the user knows that.
  function askEnable(row) {
    if (!Model.canEnable(row) || busy) return
    revokeReleaseNavigation()

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
    revokeReleaseNavigation()

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
    if (!row || !row.updatable || busy
        || !root.loadProcessSettled() || !root.updateProcessSettled()) return
    revokeReleaseNavigation()
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

  function focusSearchField() {
    searchField.forceActiveFocus()
    searchField.selectAll()
  }

  function returnFocusToList() {
    Qt.callLater(function() {
      if (root.opened
          && Model.browseModalFocusOwner(root.detailsOpen, root.confirming, root.placing) === "list"
          && keyCatcher) keyCatcher.forceActiveFocus()
    })
  }

  onOpenedChanged: {
    if (!opened) { detailsEntry = null; revokeReleaseNavigation(); return }
    setStatus("", false)
    reload()
    checkUpdates()
    if (!catalogLoaded && !catalogLoading) loadCatalog(false)
  }

  // ---- Processes ----------------------------------------------------------

  // One round trip for the whole picture: enabled state from `plugin list`,
  // source directories and descriptions from `plugin catalog`, which checkouts
  // a pull can reach from the filesystem, any exact manifest-version tag proven
  // at each checkout's HEAD, and the author and version each manifest declares.
  // The section markers print unconditionally so a failed command shows up as
  // unparseable output rather than as a silently short list.
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
      + "  version=$(jq -r '.version // \"\"' \"$path/manifest.json\" 2>/dev/null); "
      + "  head=$(git -C \"$path\" rev-parse HEAD 2>/dev/null); exact_tag=; "
      // Prefer the v-prefixed convention when both exact refs point at HEAD.
      // show-ref proves the literal ref exists before rev-list peels annotated
      // tags to the commit they name; neither command contacts the network.
      + "  if [ -n \"$version\" ] && [ -n \"$head\" ]; then "
      + "    for tag in \"v$version\" \"$version\"; do "
      + "      ref=\"refs/tags/$tag\"; "
      + "      git -C \"$path\" show-ref --verify --quiet \"$ref\" || continue; "
      + "      tag_commit=$(git -C \"$path\" rev-list -n 1 \"$ref\" 2>/dev/null); "
      + "      if [ -n \"$tag_commit\" ] && [ \"$tag_commit\" = \"$head\" ]; then exact_tag=$tag; break; fi; "
      + "    done; "
      + "  fi; "
      // JSON escaping keeps hostile path/remote bytes inside this one record;
      // they cannot forge another checkout or exact-tag field.
      + "  remote=$(git -C \"$path\" remote get-url origin 2>/dev/null); "
      + "  jq -cn --arg path \"$path\" --arg remote \"$remote\" --arg exactTag \"$exact_tag\" --arg headSha \"$head\" "
      + "    '{path: $path, remote: $remote, exactTag: $exactTag, headSha: $headSha}'; "
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
      onStreamFinished: {
        root.applyLoad(text)
        root.loadOutputFinished = true
        root.drainFreshUpdateCycle()
      }
    }
    onExited: function(exitCode) {
      root.loadProcessExited = true
      root.drainFreshUpdateCycle()
    }
    onRunningChanged: if (!running) root.drainFreshUpdateCycle()
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

  // Fetch, join, shrink, cache. The catalog and its anonymous engagement stats
  // are separate Marketplace sources; jq joins hearts by plugin id while it
  // projects the large catalog down before any of it reaches the shell's JSON
  // parser. Missing stats stay null rather than becoming made-up zeroes. A
  // catalog fetch failure falls back to a compatible cached copy rather than
  // emptying the grid. The projection schema keeps a fresh legacy cache from
  // silently omitting fields the current UI requires.
  readonly property string catalogScript: ""
    + "set -u -o pipefail; "
    // The 8 MiB catalog ceiling is over 3x today's 2.4 MiB payload; the 1 MiB
    // stats ceiling is over 15x today's 67 KiB payload. The projection should
    // shrink the catalog, so the same 8 MiB ceiling leaves substantial growth
    // room while placing a hard bound on cache and shell-parser input.
    + "catalog_max=8388608; stats_max=1048576; projection_max=8388608; projection_schema=1; "
    + "dir=\"$HOME/.cache/omarchy-plugin-manager\"; file=\"$dir/catalog.json\"; "
    + "cache_usable() { local size; [ -s \"$file\" ] || return 1; "
    + "  size=$(stat -c %s -- \"$file\" 2>/dev/null) || return 1; [ \"$size\" -le \"$projection_max\" ] || return 1; "
    + "  jq -e --argjson schema \"$projection_schema\" '(.projectionSchemaVersion == $schema) and (.plugins | type == \"array\")' \"$file\" >/dev/null 2>&1; }; "
    + "mkdir -p \"$dir\"; "
    + "if [ \"$1\" != 1 ] && cache_usable; then "
    + "  age=$(( $(date +%s) - $(stat -c %Y \"$file\") )); "
    + "  if [ \"$age\" -lt 21600 ]; then cat \"$file\"; exit 0; fi; "
    + "fi; "
    + "catalog_tmp=$(mktemp); stats_tmp=$(mktemp); tmp=$(mktemp \"$dir/.catalog.json.tmp.XXXXXX\"); "
    + "cleanup_catalog() { rm -f \"$catalog_tmp\" \"$stats_tmp\" \"$tmp\"; }; trap cleanup_catalog EXIT; "
    + "curl -fsSL --max-time 25 --max-filesize \"$catalog_max\" " + Model.CATALOG_URL + " -o \"$catalog_tmp\" 2>/dev/null & catalog_pid=$!; "
    + "curl -fsSL --max-time 15 --max-filesize \"$stats_max\" " + Model.MARKETPLACE_STATS_URL + " -o \"$stats_tmp\" 2>/dev/null & stats_pid=$!; "
    + "wait \"$catalog_pid\"; catalog_status=$?; wait \"$stats_pid\"; stats_status=$?; "
    + "if [ \"$stats_status\" -ne 0 ] || ! jq -e '.plugins | type == \"object\"' \"$stats_tmp\" >/dev/null 2>&1; then "
    + "  printf '%s' '{\"plugins\":{}}' > \"$stats_tmp\"; "
    + "fi; "
    + "if [ \"$catalog_status\" -eq 0 ] "
    + "   && jq -c --argjson schema \"$projection_schema\" --slurpfile stats \"$stats_tmp\" '{projectionSchemaVersion: $schema, generatedAt, plugins: [.plugins[] as $plugin | $plugin | {id,name,description,author,version,category,tags,kind,repo,installCommand,installAvailable,installNote,verificationStatus,sourceType,stars,addedAt,listedAt,marketplaceHearts: ($stats[0].plugins[$plugin.id].hearts // null),accent,initials,license,previewThumbnail,listingValidatedBranch}]}' \"$catalog_tmp\" 2>/dev/null "
    // One sentinel byte distinguishes an exact-limit projection from an
    // oversized one; pipefail also rejects jq errors and its bounded SIGPIPE.
    + "      | head -c \"$((projection_max + 1))\" > \"$tmp\" "
    + "   && [ -s \"$tmp\" ] && [ \"$(stat -c %s -- \"$tmp\")\" -le \"$projection_max\" ]; then "
    + "  if mv \"$tmp\" \"$file\"; then cat \"$file\"; else exit 1; fi; "
    + "else "
    + "  if cache_usable; then cat \"$file\"; else exit 1; fi; "
    + "fi"

  // No fetch and no clone: ls-remote asks the remote for one sha and downloads
  // nothing, so eleven checkouts resolve in about a second. The manifest is
  // read only for the ones actually behind, pinned to the exact remote commit.
  readonly property string updateScript: ""
    + "set -u; export GIT_TERMINAL_PROMPT=0 GIT_ASKPASS=/bin/true; "
    + "tmpdir=; temp_root=; owner_prefix=; output_revoked=0; worker_sessions=(); "
    // Every worker is a session leader, so its trusted PID is also the exact
    // boundary containing git, timeout, curl, and any network descendants.
    // No caller or unrelated process can share that newly created session.
    + "terminate_workers() { output_revoked=1; "
    + "  for sid in \"${worker_sessions[@]}\"; do /usr/bin/pkill -TERM -s \"$sid\" 2>/dev/null || :; done; "
    + "  for sid in \"${worker_sessions[@]}\"; do /usr/bin/pkill -KILL -s \"$sid\" 2>/dev/null || :; done; "
    + "  for pid in \"${worker_sessions[@]}\"; do wait \"$pid\" 2>/dev/null || :; done; "
    + "  worker_sessions=(); }; "
    + "cleanup() { status=$?; trap - EXIT HUP INT TERM; "
    + "  if [ \"${#worker_sessions[@]}\" -gt 0 ]; then terminate_workers; fi; "
    + "  if [ -n \"$tmpdir\" ] && [ -n \"$temp_root\" ] && [ -n \"$owner_prefix\" ] "
    + "     && [ \"$temp_root\" != / ] && [ \"$tmpdir\" != \"$temp_root\" ]; then "
    + "    case \"$tmpdir\" in \"$temp_root\"/\"$owner_prefix\".*) rm -rf -- \"$tmpdir\" ;; esac; "
    + "  fi; exit \"$status\"; }; "
    + "signal_exit() { status=\"$1\"; trap - HUP INT TERM; terminate_workers; exit \"$status\"; }; "
    + "arm_signal_traps() { trap 'signal_exit 129' HUP; trap 'signal_exit 130' INT; trap 'signal_exit 143' TERM; }; "
    // Bash delivers traps between commands. During the two-command spawn/PID
    // append boundary, defer the exit until the new trusted session is stored.
    + "launch_worker() { pending_signal=0; "
    + "  trap 'pending_signal=129' HUP; trap 'pending_signal=130' INT; trap 'pending_signal=143' TERM; "
    + "  /usr/bin/setsid /usr/bin/bash -c 'set -u; update_worker \"$1\" \"$2\"' worker \"$1\" \"$2\" & "
    + "  worker_sessions+=(\"$!\"); arm_signal_traps; "
    + "  if [ \"$pending_signal\" -ne 0 ]; then signal_exit \"$pending_signal\"; fi; }; "
    + "trap 'cleanup' EXIT; arm_signal_traps; "
    + "umask 077; owner_token=; IFS= read -r owner_token < /proc/sys/kernel/random/uuid 2>/dev/null || owner_token=; "
    + "case \"$owner_token\" in ''|*[!0-9a-f-]*) owner_token=\"${RANDOM}${RANDOM}${RANDOM}${RANDOM}\" ;; esac; "
    + "owner_prefix=\"omarchy-plugin-manager-updates.$$.$owner_token\"; "
    + "make_tmpdir() { temp_root=\"$1\"; attempt=0; "
    + "  while [ \"$attempt\" -lt 8 ]; do tmpdir=\"$temp_root/$owner_prefix.$attempt\"; "
    + "    if mkdir -m 700 -- \"$tmpdir\" 2>/dev/null; then return 0; fi; "
    + "    tmpdir=; attempt=$((attempt + 1)); "
    + "  done; temp_root=; return 1; }; "
    + "xdg_root=\"${XDG_RUNTIME_DIR:-}\"; xdg_mode=; "
    + "if [ -n \"$xdg_root\" ]; then xdg_mode=$(stat -c %a -- \"$xdg_root\" 2>/dev/null); fi; "
    + "if [ -n \"$xdg_root\" ] && [ \"${xdg_root#/}\" != \"$xdg_root\" ] && [ \"$xdg_root\" != / ] "
    + "   && [ -d \"$xdg_root\" ] && [ -w \"$xdg_root\" ] && [ -x \"$xdg_root\" ] "
    + "   && [ -O \"$xdg_root\" ] && [ ! -L \"$xdg_root\" ] && [ \"$xdg_mode\" = 700 ] "
    + "   && make_tmpdir \"$xdg_root\"; then :; "
    + "elif [ -d /tmp ] && [ -w /tmp ] && [ -x /tmp ] && make_tmpdir /tmp; then :; "
    + "else exit 1; fi; "
    + "update_worker() { path=\"$1\"; outfile=\"$2\"; "
    + "  branch=$(git -C \"$path\" rev-parse --abbrev-ref HEAD 2>/dev/null); "
    + "  local_sha=$(git -C \"$path\" rev-parse HEAD 2>/dev/null); "
    + "  remote_sha=$(timeout 12 git -C \"$path\" ls-remote origin \"refs/heads/$branch\" 2>/dev/null | cut -f1); "
    + "  local_version=$(jq -r '.version // \"\"' \"$path/manifest.json\" 2>/dev/null); "
    + "  remote_version=\"\"; "
    + "  if [ -n \"$remote_sha\" ] && [ \"$remote_sha\" != \"$local_sha\" ]; then "
    + "    origin=$(git -C \"$path\" remote get-url origin 2>/dev/null); "
    + "    case \"$origin\" in https://github.com/*) "
    + "      slug=${origin#https://github.com/}; slug=${slug%.git}; "
    + "      remote_version=$(curl -fsSL --max-time 8 \"https://raw.githubusercontent.com/$slug/$remote_sha/manifest.json\" 2>/dev/null | jq -r '.version // \"\"' 2>/dev/null); "
    + "    ;; esac; "
    + "  fi; "
    + "  jq -cn --arg path \"$path\" --arg localSha \"$local_sha\" --arg remoteSha \"$remote_sha\" "
    + "    --arg localVersion \"$local_version\" --arg remoteVersion \"$remote_version\" "
    + "    '{path: $path, localSha: $localSha, remoteSha: $remoteSha, localVersion: $localVersion, remoteVersion: $remoteVersion}' "
    + "    > \"$outfile.tmp\" && mv -- \"$outfile.tmp\" \"$outfile.json\"; "
    + "}; export -f update_worker; "
    + "index=0; "
    + "for dir in \"$HOME\"/.config/omarchy/plugins/*/; do "
    + "  [ -d \"$dir/.git\" ] || continue; "
    // A numeric producer-owned filename keeps untrusted paths out of the
    // filesystem protocol. Workers publish by atomic rename only after jq has
    // completed one record; the parent emits those records after every remote
    // check has finished, so even versions far above pipe atomicity cannot
    // interleave.
    + "  outfile=\"$tmpdir/$index\"; index=$((index + 1)); "
    + "  launch_worker \"${dir%/}\" \"$outfile\"; "
    + "done; "
    + "while [ \"${#worker_sessions[@]}\" -gt 0 ]; do "
    + "  pid=\"${worker_sessions[0]}\"; wait \"$pid\" || :; worker_sessions=(\"${worker_sessions[@]:1}\"); "
    + "done; [ \"$output_revoked\" -eq 0 ] || exit 1; "
    + "payload=; i=0; while [ \"$i\" -lt \"$index\" ]; do "
    + "  file=\"$tmpdir/$i.json\"; if [ -s \"$file\" ]; then "
    + "    record=$(cat -- \"$file\"); payload+=\"$record\"$'\\n'; "
    + "  fi; i=$((i + 1)); "
    + "done; [ \"$output_revoked\" -eq 0 ] || exit 1; "
    // Once committed, publish through one shell builtin. Bash defers traps
    // until the builtin returns, so cancellation observes either no batch or
    // the complete batch, never an interruptible sequence of external cats.
    + "trap '' HUP INT TERM; printf '%s' \"$payload\""

  Process {
    id: releaseProbe
    stdout: StdioCollector {
      waitForEnd: true
      onStreamFinished: root.applyReleaseNavigationTransition(
        Model.releaseNavigationProbeOutputTransition(root.releaseNavigationState, text))
    }
    onExited: function(exitCode) { root.applyReleaseNavigationTransition(
      Model.releaseNavigationProbeExitedTransition(root.releaseNavigationState, exitCode)) }
  }

  Process {
    id: updateProc
    command: ["bash", "-c", root.updateScript]
    stdout: StdioCollector {
      waitForEnd: true
      onStreamFinished: {
        root.applyUpdateReport(text)
        root.updateOutputFinished = true
        root.drainFreshUpdateCycle()
      }
    }
    onExited: function(exitCode) {
      root.checkingUpdates = false
      root.updateProcessExited = true
      root.drainFreshUpdateCycle()
    }
    onRunningChanged: if (!running) root.drainFreshUpdateCycle()
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
        if (kind === "update") {
          // The successful pull invalidates the old report immediately. Load
          // and the fresh check may finish in either order; HEAD equality makes
          // both orders deterministic without serializing the processes.
          root.pendingUpdateReport = ""
          root.rows = Model.applyUpdateReport(root.rows, {})
        }
      } else {
        root.setStatus(Model.failureMessage(kind, root.actionStderr, exitCode), true)
      }

      if (exitCode === 0 && kind === "update") root.requestFreshUpdateCycle()
      else root.reload()
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
        + (root.browsing ? Style.space(600) : listColumn.implicitHeight)
        + hintBar.implicitHeight + Style.space(20),
      Style.space(600))

    PanelKeyCatcher {
      id: keyCatcher
      anchors.fill: parent
      blocked: root.confirming || root.placing || root.detailsOpen
        || searchField.activeFocus
        || groupDropdown.popupOpen || kindDropdown.popupOpen || statusDropdown.popupOpen || categoryDropdown.popupOpen
        || catalogKindDropdown.popupOpen || availabilityDropdown.popupOpen || sortDropdown.popupOpen

      onMoveRequested: function(dx, dy) { root.moveSelection(dx, dy) }
      onActivateRequested: root.browsing ? root.openDetails(root.selectedEntry) : root.startUpdate(root.selectedRow)
      onDeleteRequested: if (!root.browsing) root.askRemove(root.selectedRow)
      onCloseRequested: { root.revokeReleaseNavigation(); root.close() }
      onTabRequested: function(direction) { root.revokeReleaseNavigation(); root.switchPanel(direction) }
      onTextKey: function(t) {
        if (t === "/") root.focusSearchField()
        else if (t === "r" || t === "R") {
          if (root.browsing) root.loadCatalog(true)
          else { root.reload(); root.checkUpdates() }
        }
        else if (t === "f" || t === "F") root.browsing ? root.cycleCatalogKindFilter() : root.cycleKindFilter()
        else if (t === "s" || t === "S") root.browsing ? root.cycleCatalogSort() : root.cycleGroupFilter()
        else if ((t === "c" || t === "C") && root.browsing) root.cycleCategoryFilter()
        else if ((t === "a" || t === "A") && root.browsing) root.cycleAvailabilityFilter()
        else if ((t === "t" || t === "T") && !root.browsing) root.cycleStatusFilter()
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
            id: titleIcon
            // Same puzzle-piece glyph as the plugin manager's bar button.
            textFormat: Text.PlainText
            anchors.left: parent.left
            anchors.baseline: title.baseline
            text: "󰐱"
            color: root.contentForeground
            font.family: root.contentFontFamily
            font.pixelSize: title.font.pixelSize
          }

          Text {
            id: title
            // Never rich text: AutoText would fetch what a crafted string points at.
            textFormat: Text.PlainText
            anchors.left: titleIcon.right
            anchors.leftMargin: Style.space(8)
            anchors.verticalCenter: parent.verticalCenter
            text: "Plugins"
            color: root.contentForeground
            font.family: root.contentFontFamily
            font.pixelSize: Style.font.display
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
            color: root.secondaryForeground
            font.family: root.contentFontFamily
            font.pixelSize: Style.font.caption
          }

          // The tabs keep one fixed spot on both tabs, so switching never
          // moves the button you just clicked out from under the pointer.
          // Browse's extra button goes on the far side of them.
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

          // A link, not a button: it leaves the panel for a web page, and the
          // rows' repository links already taught the eye what that looks like.
          Text {
            id: marketplaceLink
            // Never rich text: AutoText would fetch what a crafted string points at.
            textFormat: Text.PlainText
            anchors.right: tabs.left
            anchors.rightMargin: Style.space(10)
            anchors.verticalCenter: parent.verticalCenter
            visible: root.browsing
            text: "󰖟  Marketplace"
            color: marketplaceMouse.containsMouse ? Color.accent : root.secondaryForeground
            font.family: root.contentFontFamily
            font.pixelSize: Style.font.caption
            font.underline: marketplaceMouse.containsMouse

            MouseArea {
              id: marketplaceMouse
              anchors.fill: parent
              hoverEnabled: true
              cursorShape: Qt.PointingHandCursor
              onClicked: root.navigateExternalUrl("https://omarchyplugins.com/")
            }

            PanelToolTip {
              visible: marketplaceMouse.containsMouse
              text: "Open the official Marketplace"
              fontFamily: root.contentFontFamily
            }
          }

          PanelActionButton {
            id: refreshButton
            anchors.right: parent.right
            anchors.verticalCenter: parent.verticalCenter
            iconText: "󰑐"
            // The one icon in the header, next to two text buttons: at the
            // default size it read as an afterthought beside them. Display
            // size puts it on the same scale as the title at the other end.
            fontSize: Style.font.display
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

        PanelSeparator { foreground: root.contentForeground }

        // ---- Both tabs use the same labelled filter row above Search: the
        //      caption names the control and the dropdown shows its value, so
        //      several independent controls stay readable at a glance.
        Item {
          id: filterControls

          readonly property real controlHeight: kindDropdown.implicitHeight
          readonly property real filterRowHeight: filterLabelMetrics.height
            + Style.space(4) + controlHeight

          FontMetrics {
            id: filterLabelMetrics
            font.family: root.contentFontFamily
            font.pixelSize: Style.font.caption
          }

          width: parent.width
          height: filterRowHeight + Style.space(8) + controlHeight

          Item {
            id: installedFilters
            anchors.left: parent.left
            anchors.right: parent.right
            anchors.top: parent.top
            visible: !root.browsing
            height: visible ? filterControls.filterRowHeight : 0

            readonly property real gap: Style.space(6)
            readonly property real optionWidth: Math.floor((width - gap * 2) / 3)

            Item {
              id: groupFilterControl
              anchors.left: parent.left
              width: installedFilters.optionWidth
              height: parent.height

              Text {
                anchors.left: parent.left
                anchors.top: parent.top
                text: "Source"
                color: root.secondaryForeground
                font.family: root.contentFontFamily
                font.pixelSize: Style.font.caption
                font.bold: true
              }

              Dropdown {
                id: groupDropdown
                anchors.left: parent.left
                anchors.right: parent.right
                anchors.bottom: parent.bottom
                height: filterControls.controlHeight
                showLabel: false
                options: root.groupOptions
                value: root.groupFilter
                foreground: root.contentForeground
                fontFamily: root.contentFontFamily
                onChanged: function(value) { root.setGroupFilter(value) }
              }
            }

            Item {
              id: kindFilterControl
              anchors.left: groupFilterControl.right
              anchors.leftMargin: installedFilters.gap
              width: installedFilters.optionWidth
              height: parent.height

              Text {
                anchors.left: parent.left
                anchors.top: parent.top
                text: "Kind"
                color: root.secondaryForeground
                font.family: root.contentFontFamily
                font.pixelSize: Style.font.caption
                font.bold: true
              }

              Dropdown {
                id: kindDropdown
                anchors.left: parent.left
                anchors.right: parent.right
                anchors.bottom: parent.bottom
                height: filterControls.controlHeight
                showLabel: false
                options: root.kindOptions
                value: root.kindFilter
                foreground: root.contentForeground
                fontFamily: root.contentFontFamily
                onChanged: function(value) { root.setKindFilter(value) }
              }
            }

            Item {
              id: statusFilterControl
              anchors.left: kindFilterControl.right
              anchors.leftMargin: installedFilters.gap
              anchors.right: parent.right
              height: parent.height

              Text {
                anchors.left: parent.left
                anchors.top: parent.top
                text: "Status"
                color: root.secondaryForeground
                font.family: root.contentFontFamily
                font.pixelSize: Style.font.caption
                font.bold: true
              }

              Dropdown {
                id: statusDropdown
                anchors.left: parent.left
                anchors.right: parent.right
                anchors.bottom: parent.bottom
                height: filterControls.controlHeight
                showLabel: false
                options: root.statusOptions
                value: root.statusFilter
                foreground: root.contentForeground
                fontFamily: root.contentFontFamily
                onChanged: function(value) { root.setStatusFilter(value) }
              }
            }
          }

          Item {
            id: browseFilters
            anchors.left: parent.left
            anchors.right: parent.right
            anchors.top: parent.top
            visible: root.browsing
            height: visible ? filterControls.filterRowHeight : 0

            readonly property real gap: Style.space(6)
            readonly property real optionWidth: Math.floor((width - gap * 3) / 4)

            Item {
              id: categoryFilterControl
              anchors.left: parent.left
              width: browseFilters.optionWidth
              height: parent.height

              Text {
                anchors.left: parent.left
                anchors.top: parent.top
                text: "Category"
                color: root.secondaryForeground
                font.family: root.contentFontFamily
                font.pixelSize: Style.font.caption
                font.bold: true
              }

              Dropdown {
                id: categoryDropdown
                anchors.left: parent.left
                anchors.right: parent.right
                anchors.bottom: parent.bottom
                height: filterControls.controlHeight
                showLabel: false
                options: root.categoryOptions
                value: root.categoryFilter
                foreground: root.contentForeground
                fontFamily: root.contentFontFamily
                onChanged: function(value) { root.setCategoryFilter(value) }
              }
            }

            Item {
              id: catalogKindFilterControl
              anchors.left: categoryFilterControl.right
              anchors.leftMargin: browseFilters.gap
              width: browseFilters.optionWidth
              height: parent.height

              Text {
                anchors.left: parent.left
                anchors.top: parent.top
                text: "Kind"
                color: root.secondaryForeground
                font.family: root.contentFontFamily
                font.pixelSize: Style.font.caption
                font.bold: true
              }

              Dropdown {
                id: catalogKindDropdown
                anchors.left: parent.left
                anchors.right: parent.right
                anchors.bottom: parent.bottom
                height: filterControls.controlHeight
                showLabel: false
                options: root.catalogKindOptions
                value: root.catalogKindFilter
                foreground: root.contentForeground
                fontFamily: root.contentFontFamily
                onChanged: function(value) { root.setCatalogKindFilter(value) }
              }
            }

            Item {
              id: availabilityFilterControl
              anchors.left: catalogKindFilterControl.right
              anchors.leftMargin: browseFilters.gap
              width: browseFilters.optionWidth
              height: parent.height

              Text {
                anchors.left: parent.left
                anchors.top: parent.top
                text: "Availability"
                color: root.secondaryForeground
                font.family: root.contentFontFamily
                font.pixelSize: Style.font.caption
                font.bold: true
              }

              Dropdown {
                id: availabilityDropdown
                anchors.left: parent.left
                anchors.right: parent.right
                anchors.bottom: parent.bottom
                height: filterControls.controlHeight
                showLabel: false
                options: root.availabilityOptions
                value: root.availabilityFilter
                foreground: root.contentForeground
                fontFamily: root.contentFontFamily
                onChanged: function(value) { root.setAvailabilityFilter(value) }
              }
            }

            Item {
              id: sortFilterControl
              anchors.left: availabilityFilterControl.right
              anchors.leftMargin: browseFilters.gap
              anchors.right: parent.right
              height: parent.height

              Text {
                anchors.left: parent.left
                anchors.top: parent.top
                text: "Sort"
                color: root.secondaryForeground
                font.family: root.contentFontFamily
                font.pixelSize: Style.font.caption
                font.bold: true
              }

              Dropdown {
                id: sortDropdown
                anchors.left: parent.left
                anchors.right: parent.right
                anchors.bottom: parent.bottom
                height: filterControls.controlHeight
                showLabel: false
                options: root.catalogSortOptions
                value: root.catalogSort
                foreground: root.contentForeground
                fontFamily: root.contentFontFamily
                onChanged: function(value) { root.setCatalogSort(value) }
              }
            }
          }

          TextField {
            id: searchField
            anchors.left: parent.left
            anchors.right: clearFiltersButton.visible ? clearFiltersButton.left : parent.right
            anchors.rightMargin: clearFiltersButton.visible ? Style.space(4) : 0
            y: filterControls.filterRowHeight + Style.space(8)
            height: filterControls.controlHeight
            // The glyph rides in the placeholder rather than sitting in its
            // own column: the row is the search box and nothing else.
            placeholderText: root.browsing ? "󰍉  Search the catalog…" : "󰍉  Search by name…"
            foreground: root.contentForeground
            placeholderTextColor: root.secondaryForeground
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
            id: clearFiltersButton
            anchors.right: parent.right
            y: filterControls.filterRowHeight + Style.space(8)
            visible: root.browsing ? root.catalogFiltered : root.searchQuery !== ""
            iconText: "󰅙"
            tooltipText: root.browsing ? "Clear Browse filters" : "Clear the search"
            foreground: root.contentForeground
            fontFamily: root.contentFontFamily
            onClicked: {
              if (root.browsing) root.clearCatalogFilters()
              else root.clearSearch()
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
          color: root.statusIsError || root.loadError !== "" || root.catalogError !== "" ? Color.urgent : root.secondaryForeground
          font.family: root.contentFontFamily
          font.pixelSize: Style.font.caption
          wrapMode: Text.WordWrap
        }
      }

      // ---- Key hints, pinned to the bottom so the list above can never push
      //      them off the card. One bar: the filters of the active tab on
      //      the left, each "[key] value", and the row actions on the right.
      Column {
        id: hintBar
        anchors.left: parent.left
        anchors.right: parent.right
        anchors.bottom: parent.bottom
        spacing: Style.space(8)

        PanelSeparator { foreground: root.contentForeground }

        Item {
          width: parent.width
          height: Math.max(filterHints.implicitHeight, actionHints.implicitHeight)

          Row {
            id: filterHints
            anchors.left: parent.left
            anchors.verticalCenter: parent.verticalCenter
            spacing: Style.space(10)

            Repeater {
              model: root.browsing ? root.browseFilterHints : root.installedFilterHints
              delegate: hintDelegate
            }
          }

          Row {
            id: actionHints
            anchors.right: parent.right
            anchors.verticalCenter: parent.verticalCenter
            spacing: Style.space(10)

            Repeater {
              model: Model.actionHints(root.browsing)
              delegate: hintDelegate
            }
          }
        }

        Component {
          id: hintDelegate

          Row {
            id: hint
            required property var modelData
            spacing: Style.space(4)

            Text {
              // Never rich text: AutoText would fetch what a crafted string points at.
              textFormat: Text.PlainText
              text: "[" + hint.modelData.key.toUpperCase() + "]"
              color: Color.accent
              font.family: root.contentFontFamily
              font.pixelSize: Style.font.caption
              font.bold: true
            }

            Text {
              // Never rich text: AutoText would fetch what a crafted string points at.
              textFormat: Text.PlainText
              text: hint.modelData.text
              color: hint.modelData.active ? root.contentForeground : root.secondaryForeground
              font.family: root.contentFontFamily
              font.pixelSize: Style.font.caption
            }
          }
        }
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
        anchors.bottom: hintBar.top
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
            text: Model.emptyMessage(root.kindFilter, root.statusFilter, root.searchQuery, root.groupFilter)
            color: root.secondaryForeground
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
            color: root.secondaryForeground
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
              verified: Model.isVerified(modelData, root.verifiedIds)
              selected: root.selectedIndex === index
              actionsEnabled: !root.busy
              updateEnabled: root.updateActionsEnabled
              showSeparator: index < root.installedRows.length - 1 // qmllint disable unqualified
              foreground: root.contentForeground
              secondaryForeground: root.secondaryForeground
              fontFamily: root.contentFontFamily

              onSelectedChanged: if (selected) root.ensureVisible(this)
              onClicked: root.selectedIndex = index
              onGithubNavigationRequested: function(candidates, fallbackUrl) {
                root.requestGithubNavigation(candidates, fallbackUrl)
              }
              onRepositoryNavigationRequested: function(url) { root.navigateExternalUrl(url) }
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
            color: root.secondaryForeground
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
              verified: Model.isVerified(modelData, root.verifiedIds)
              selected: root.selectedIndex === globalIndex
              actionsEnabled: !root.busy
              showSeparator: index < root.builtinRows.length - 1 // qmllint disable unqualified
              foreground: root.contentForeground
              secondaryForeground: root.secondaryForeground
              fontFamily: root.contentFontFamily

              onSelectedChanged: if (selected) root.ensureVisible(this)
              onClicked: root.selectedIndex = globalIndex
              onRepositoryNavigationRequested: function(url) { root.navigateExternalUrl(url) }
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
        anchors.bottom: hintBar.top
        anchors.bottomMargin: Style.space(10)
        clip: true
        boundsBehavior: Flickable.StopAtBounds
        cacheBuffer: Math.round(cellHeight * 2)

        readonly property int columns: 3
        cellWidth: Math.floor(width / columns)

        // Worst-case compact-card content, expressed from the same line and
        // spacing metrics as the delegate: three description lines, one
        // blocked-reason line, and a two-line-or-button footer.
        readonly property real compactDelegateMargin: Style.space(4)
        readonly property real compactCardPadding: Style.space(8)
        readonly property real compactContentSpacing: Style.space(6)
        readonly property real compactContentWidth: cellWidth
          - compactDelegateMargin * 2 - compactCardPadding * 2
        readonly property real compactActionHeight: Math.max(
          Style.space(22), Style.font.icon + Style.spacing.sm * 2)
        readonly property real compactFooterHeight: Math.max(
          Math.ceil(cardTextMetrics.lineSpacing * 2) + Style.space(3),
          compactActionHeight)
        cellHeight: Math.round(compactContentWidth * 9 / 16)
          + Math.ceil(cardNameMetrics.lineSpacing)
          + Math.ceil(cardTextMetrics.lineSpacing * 4)
          + compactFooterHeight
          + compactContentSpacing * 4
          + compactCardPadding * 2
          + compactDelegateMargin * 2

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
            id: catalogCard
            anchors.fill: parent
            anchors.margins: Style.space(4)
            entry: modelData
            selected: root.selectedIndex === index
            actionsEnabled: !root.busy
            previewsEnabled: root.previewsSupported
            foreground: root.contentForeground
            secondaryForeground: root.secondaryForeground
            fontFamily: root.contentFontFamily

            onPreviewUndecodable: root.previewsSupported = false
            onDetailsRequested: {
              root.selectedIndex = index
              root.openDetails(modelData)
            }
            onInstallRequested: {
              root.selectedIndex = index
              root.askInstall(modelData)
            }
          }
        }

        // Empty and loading are different states and read differently: one
        // says the fetch is still running, the other that the filters matched
        // nothing.
        Column {
          anchors.centerIn: parent
          width: parent.width - Style.space(40)
          visible: root.visibleCatalog.length === 0
          spacing: Style.space(10)

          Text {
            textFormat: Text.PlainText
            width: parent.width
            text: {
              if (root.catalogLoading) return "Fetching the catalog from omarchyplugins.com…"
              if (root.catalogError !== "") return root.catalogError
              if (root.catalog.length === 0) return "No catalog yet."
              return Model.catalogEmptyMessage(
                root.categoryFilter, root.catalogKindFilter,
                root.availabilityFilter, root.searchQuery)
            }
            color: root.secondaryForeground
            font.family: root.contentFontFamily
            font.pixelSize: Style.font.caption
            wrapMode: Text.WordWrap
            horizontalAlignment: Text.AlignHCenter
          }

          Button {
            anchors.horizontalCenter: parent.horizontalCenter
            visible: root.catalogFiltered && !root.catalogLoading
            height: visible ? implicitHeight : 0
            text: "Clear filters"
            tooltipText: "Show the full catalog"
            foreground: root.contentForeground
            fontFamily: root.contentFontFamily
            fontSize: Style.font.caption
            bordered: true
            onClicked: root.clearCatalogFilters()
          }
        }
      }

      PluginDetails {
        id: pluginDetails
        anchors.fill: parent
        z: 10
        opened: root.detailsOpen
        entry: root.detailsEntry
        previewsEnabled: root.previewsSupported
        background: Color.popups.background
        foreground: root.contentForeground
        secondaryForeground: root.secondaryForeground
        fontFamily: root.contentFontFamily

        onPreviewUndecodable: root.previewsSupported = false

        onOpenedChanged: {
          if (opened) forceActiveFocus()
          else root.returnFocusToList()
        }

        Keys.onPressed: function(event) {
          if (pluginDetails.handleKey(event)) event.accepted = true
        }

        onClosed: root.closeDetails()
        onRepositoryNavigationRequested: function(url) { root.navigateExternalUrl(url) }
        onGithubNavigationRequested: function(candidates, fallbackUrl) {
          root.requestGithubNavigation(candidates, fallbackUrl)
        }
        onInstallRequested: root.askInstall(root.detailsEntry)
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
          else root.returnFocusToList()
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
          else root.returnFocusToList()
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
