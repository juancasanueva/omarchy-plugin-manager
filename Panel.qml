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
  //
  // Everything the panel knows about plugins — rows, catalog, the commands
  // that change them — lives in the store, so the expanded window can own an
  // identical one. The aliases let this surface keep reading `root.rows` and
  // friends as it always has; only what it binds to or writes is aliased.

  PluginStore {
    id: store
    selfId: root.moduleName
  }

  Connections {
    target: store
    // Any load — including one the store starts on its own after an update —
    // retires a release probe, exactly as an explicit refresh does.
    function onReloadStarted() { root.revokeReleaseNavigation() }
    function onRowsLoaded() { root.clampSelection() }
  }

  property alias rows: store.rows
  property alias loading: store.loading
  property alias loadError: store.loadError
  property int selectedIndex: -1

  property string groupFilter: "all"
  readonly property var groupOptions: Model.groupOptions()
  property string kindFilter: "all"
  readonly property var kindOptions: Model.kindOptions(rows)
  property string statusFilter: "all"
  readonly property var statusOptions: Model.statusOptions()
  // What the lists filter on. It follows the search box after a short pause
  // rather than on every keystroke: each change rebuilds every visible row or
  // card, and a word typed at speed would rebuild them once per letter.
  // Clearing applies at once, so Escape and the clear button feel immediate.
  property string searchQuery: ""

  Timer {
    id: searchDebounce
    interval: 150
    repeat: false
    onTriggered: root.searchQuery = searchField.text
  }

  function flushSearch() {
    searchDebounce.stop()
    searchQuery = searchField.text
  }

  // A reload can remove the last plugin of a kind. Falling back immediately
  // keeps the filter visible and truthful instead of retaining a hidden value.
  onKindOptionsChanged: {
    for (var i = 0; i < kindOptions.length; i++)
      if (kindOptions[i].value === kindFilter) return
    setKindFilter("all")
  }
  // Dropdown selection assigns its own value, which breaks the binding, so
  // every filter a key can cycle replays later changes into its dropdown.
  onKindFilterChanged: if (kindDropdown && kindDropdown.value !== kindFilter)
    kindDropdown.value = kindFilter
  onGroupFilterChanged: if (groupDropdown && groupDropdown.value !== groupFilter)
    groupDropdown.value = groupFilter
  onStatusFilterChanged: if (statusDropdown && statusDropdown.value !== statusFilter)
    statusDropdown.value = statusFilter
  onCategoryFilterChanged: if (categoryDropdown && categoryDropdown.value !== categoryFilter)
    categoryDropdown.value = categoryFilter
  onCatalogKindFilterChanged: if (catalogKindDropdown && catalogKindDropdown.value !== catalogKindFilter)
    catalogKindDropdown.value = catalogKindFilter
  onAvailabilityFilterChanged: if (availabilityDropdown && availabilityDropdown.value !== availabilityFilter)
    availabilityDropdown.value = availabilityFilter
  onCatalogSortChanged: if (sortDropdown && sortDropdown.value !== catalogSort)
    sortDropdown.value = catalogSort

  // One flat filtered list drives selection; the two section slices below are
  // views onto it, in the same order, so a single index addresses both.
  readonly property var visibleRows: Model.filterRows(rows, kindFilter, statusFilter, searchQuery, groupFilter)
  readonly property var installedRows: Model.rowsInGroup(visibleRows, "installed")
  readonly property var builtinRows: Model.rowsInGroup(visibleRows, "built-in")

  property alias checkingUpdates: store.checkingUpdates
  // What the header's refresh button is waiting on for the tab you can see:
  // the Installed re-read includes its update check, Browse the catalog fetch.
  readonly property bool refreshing: browsing ? catalogLoading : (loading || checkingUpdates)
  readonly property alias behindCount: store.behindCount
  readonly property alias updateActionsEnabled: store.updateActionsEnabled

  // One click-time release probe for the whole panel. Every explicit
  // navigation or action advances this generation state, so callbacks from an
  // older process can settle it but never recover superseded URLs.
  ReleaseNavigator { id: releaseNavigator }
  readonly property alias releaseProbeBusy: releaseNavigator.busy

  readonly property alias installedTotal: store.installedTotal
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
  // Whether the Browse tab has been on screen yet; see the grid's model.
  property bool browseVisited: false
  onActiveTabChanged: if (activeTab === "browse") browseVisited = true
  readonly property bool browsing: activeTab === "browse"
  readonly property var tabOptions: [
    { value: "installed", label: "Installed" },
    { value: "browse", label: "Browse" }
  ]

  property alias catalog: store.catalog
  readonly property alias verifiedIds: store.verifiedIds
  property alias catalogLoading: store.catalogLoading
  property alias catalogLoaded: store.catalogLoaded
  property alias catalogError: store.catalogError
  property string categoryFilter: "all"
  property string catalogKindFilter: "all"
  property string availabilityFilter: "all"
  property string catalogSort: "recently-added"

  property alias previewsSupported: store.previewsSupported

  readonly property var categoryOptions: Model.catalogCategories(catalog)
  readonly property var catalogKindOptions: Model.catalogKindOptions(catalog)
  readonly property var availabilityOptions: Model.catalogAvailabilityOptions()
  readonly property var catalogSortOptions: Model.catalogSortOptions()
  readonly property bool catalogFiltered: Model.catalogIsFiltering(
    categoryFilter, catalogKindFilter, availabilityFilter, searchQuery)
  // Sorted once per catalog and sort mode, then filtered in that order.
  // Filtering keeps the order it is given, so a keystroke in the search box
  // walks the entries once instead of re-sorting two thousand of them.
  readonly property var sortedCatalog: Model.sortCatalog(catalog, catalogSort)
  readonly property var visibleCatalog: Model.filterCatalog(
    sortedCatalog, categoryFilter, catalogKindFilter, availabilityFilter, searchQuery)
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

  // ---- Tab flip -----------------------------------------------------------

  // The content below the header turns over like a card when the tab changes:
  // the current face rotates edge-on around its vertical axis, the other tab
  // takes its place at the midpoint, and it turns the rest of the way in from
  // the far side. Same rotational direction throughout, mirrored on the way
  // back, so the flip also says which way you went. The header, tab bar and
  // hint bar stay put — a frame that moves is a transition nobody can read.
  property string pendingTab: ""
  property real contentFlipAngle: 0
  readonly property bool contentFlipping: contentFlip.running
  // A slight shrink at the edge-on point sells the depth of the turn.
  readonly property real contentFlipScale: 1 - 0.06 * Math.sin(Math.abs(contentFlipAngle) * Math.PI / 180)

  SequentialAnimation {
    id: contentFlip
    property int direction: 1   // 1 turning toward Browse, -1 back to Installed

    NumberAnimation {
      target: root
      property: "contentFlipAngle"
      from: 0
      to: -90 * contentFlip.direction
      duration: 200
      easing.type: Easing.InCubic
    }
    ScriptAction { script: root.applyPendingTab() }
    NumberAnimation {
      target: root
      property: "contentFlipAngle"
      from: 90 * contentFlip.direction
      to: 0
      duration: 200
      easing.type: Easing.OutCubic
    }
  }

  // The id the shell knows this plugin by — the same literal the bar widget
  // answers IPC on — so the popup can ask for its own expanded window.
  readonly property string pluginId: "io.github.juancasanueva.plugin-manager"

  // Hand over to the expanded window on the tab you were looking at. Close
  // first: the popup and the panel are never up together. A bar without a
  // shell reference (tests, odd hosts) makes this a no-op rather than a throw.
  function expand() {
    if (!bar || !bar.shell || typeof bar.shell.summon !== "function") return
    var tab = activeTab
    // Name the output this popup sits on so the expanded window opens on the
    // same monitor instead of wherever the shell's default screen happens to be.
    var screenName = panel.screen ? String(panel.screen.name || "") : ""
    revokeReleaseNavigation()
    close()
    bar.shell.summon(pluginId, JSON.stringify({ tab: tab, screen: screenName }))
  }

  function switchTab(tab) {
    // A click mid-turn lands the turn in progress first rather than being
    // swallowed, so no tap is ever lost to the animation.
    if (contentFlip.running) {
      contentFlip.stop()
      if (pendingTab !== "") applyPendingTab()
      contentFlipAngle = 0
    }
    if (activeTab === tab) return
    revokeReleaseNavigation()
    closeDetails()
    pendingTab = tab
    contentFlip.direction = tab === "browse" ? 1 : -1
    contentFlip.restart()
  }

  // The actual switch, run at the edge-on midpoint where nothing is visible.
  function applyPendingTab() {
    var tab = pendingTab
    if (tab === "") return
    pendingTab = ""
    // The search does not travel: the tabs search different things, so a
    // term carried across would be a different query hiding a different list.
    clearSearch()
    activeTab = tab
    resetSelection()
    if (tab === "browse" && !catalogLoaded && !catalogLoading) loadCatalog(false)
  }

  // Any narrowing rebuilds the list under the selection, so the index is
  // dropped rather than left pointing at whatever now sits in that slot —
  // that is how a Delete keypress lands on the wrong plugin.
  onSearchQueryChanged: resetSelection()

  // Every catalog the store publishes — a fresh fetch or a re-stamp after an
  // install — refreshes the open details entry from the same list the cards
  // are drawn from, so the details never describe a state the grid has left.
  onCatalogChanged: if (detailsEntry) detailsEntry = Model.findRow(catalog, detailsEntry.id)
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

  property alias busyKind: store.busyKind
  property alias busyRowId: store.busyRowId
  property alias busyId: store.busyId
  readonly property alias busy: store.busy
  property alias status: store.status
  property alias statusIsError: store.statusIsError

  // ---- Pending confirmation -----------------------------------------------
  //
  // The questions live in the store, shared with the expanded window; this
  // popup only owns the dialogs that put them on screen.

  property alias pendingKind: store.pendingKind
  property alias pendingId: store.pendingId
  property alias pendingLabel: store.pendingLabel
  property alias pendingUrl: store.pendingUrl
  property alias pendingVerified: store.pendingVerified
  property alias pendingPlacementNeeded: store.pendingPlacementNeeded
  property alias pendingPlacement: store.pendingPlacement
  readonly property alias confirming: store.confirming
  readonly property alias placing: store.placing
  readonly property alias placementChoices: store.placementChoices
  readonly property alias placementMessage: store.placementMessage
  readonly property alias confirmMessage: store.confirmMessage

  // ---- Loading ------------------------------------------------------------
  //
  // Thin wrappers over the store: the keyboard handler and the buttons keep
  // calling the panel, and release navigation — a panel concern the store
  // knows nothing about — is revoked where it always was.

  function reload() {
    revokeReleaseNavigation()
    return store.reload()
  }

  function checkUpdates() {
    return store.checkUpdates()
  }

  // Release navigation is shared with the expanded panel; these keep the
  // names the rest of this file and its tests know.
  function requestGithubNavigation(candidates, fallbackUrl) {
    releaseNavigator.request(candidates, fallbackUrl)
  }

  function navigateExternalUrl(url) {
    releaseNavigator.navigate(url)
  }

  function revokeReleaseNavigation() {
    releaseNavigator.revoke()
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
    revokeReleaseNavigation()
    store.loadCatalog(force)
  }

  // Installing from the catalog runs the same argv array as the url field —
  // the registry's own install command is read for its url and never executed.
  function askInstall(entry) {
    if (!store.askInstall(entry)) return
    revokeReleaseNavigation()
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
    store.setStatus(text, isError)
  }

  // The asks belong to the store; the popup only retires its link probe when
  // a request was actually taken.
  function askRemove(row) {
    if (!store.askRemove(row)) return
    revokeReleaseNavigation()
  }

  function askEnable(row) {
    if (!store.askEnable(row)) return
    revokeReleaseNavigation()
  }

  function askDisable(row) {
    if (!store.askDisable(row)) return
    revokeReleaseNavigation()
  }

  function confirmPlacement(section) {
    store.confirmPlacement(section)
  }

  function cancelPending() {
    store.cancelPending()
  }

  function confirmPending() {
    store.confirmPending()
  }

  function startAdd(section) {
    store.startAdd(section)
  }

  // The store owns the gate; asking it first keeps a click on a disabled
  // button from retiring a release probe it never had a right to.
  function startUpdate(row) {
    if (!store.canStartUpdate(row)) return
    revokeReleaseNavigation()
    store.startUpdate(row)
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

  property bool titleIconIntroArmed: false

  onOpenedChanged: {
    if (!opened) { detailsEntry = null; revokeReleaseNavigation(); return }
    titleIconIntro.stop()
    titleIcon.opacity = 0
    titleIconIntroArmed = true
    setStatus("", false)
    revokeReleaseNavigation()
    store.loadOnOpen()
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
            transformOrigin: Item.Center

            // A puzzle piece should arrive like one: oversized and tilted, it
            // travels into its slot and lands with a small "click" — a dip, a
            // bounce and a wiggle. Anchors are untouched by scale and rotation,
            // so the title beside it never moves.
            //
            // The travel is a smooth in-out rather than a back easing: a back
            // easing does nearly all its motion in the first quarter and spends
            // the rest on an invisible overshoot, which is how a one-second
            // animation came to look like a 200ms flash.
            SequentialAnimation {
              id: titleIconIntro

              PauseAnimation { duration: 120 }

              ParallelAnimation {
                NumberAnimation {
                  target: titleIcon
                  property: "scale"
                  from: 3
                  to: 1
                  duration: 700
                  easing.type: Easing.InOutCubic
                }
                NumberAnimation {
                  target: titleIcon
                  property: "rotation"
                  from: -150
                  to: 0
                  duration: 700
                  easing.type: Easing.InOutCubic
                }
                NumberAnimation {
                  target: titleIcon
                  property: "opacity"
                  from: 0
                  to: 1
                  duration: 250
                }
              }

              // The click: the piece compresses into the slot, springs back a
              // touch past size, and settles; a wiggle rides along with it.
              ParallelAnimation {
                id: titleIconSettle
                SequentialAnimation {
                  NumberAnimation { target: titleIcon; property: "scale"; to: 0.88; duration: 90; easing.type: Easing.OutQuad }
                  NumberAnimation { target: titleIcon; property: "scale"; to: 1.08; duration: 110; easing.type: Easing.InOutQuad }
                  NumberAnimation { target: titleIcon; property: "scale"; to: 1; duration: 120; easing.type: Easing.OutQuad }
                }
                SequentialAnimation {
                  NumberAnimation { target: titleIcon; property: "rotation"; to: 8; duration: 110; easing.type: Easing.InOutQuad }
                  NumberAnimation { target: titleIcon; property: "rotation"; to: -5; duration: 110; easing.type: Easing.InOutQuad }
                  NumberAnimation { target: titleIcon; property: "rotation"; to: 0; duration: 100; easing.type: Easing.OutQuad }
                }
              }
            }

            // The intro is clocked from the window's first rendered frame, not
            // from `opened`: Browse's first frame is drawn noticeably later
            // than Installed's, and an animation started at `opened` had
            // finished before that frame ever reached the screen. The piece is
            // hidden at open so that first frame shows an empty slot.
            Connections {
              id: titleIconIntroTrigger
              target: titleIcon.Window.window
              enabled: root.titleIconIntroArmed
              function onFrameSwapped() {
                root.titleIconIntroArmed = false
                titleIconIntro.restart()
              }
            }
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
            id: subtitle
            // Never rich text: AutoText would fetch what a crafted string points at.
            textFormat: Text.PlainText
            anchors.left: title.right
            anchors.leftMargin: Style.space(10)
            // Bounded on the right by whatever sits there, and elided rather
            // than allowed to run under the tabs: with two icons in the
            // header now, "3 to update" was the part that lost.
            anchors.right: marketplaceLink.visible ? marketplaceLink.left : tabs.left
            anchors.rightMargin: Style.space(10)
            anchors.baseline: title.baseline
            elide: Text.ElideRight
            text: {
              if (root.browsing) {
                if (root.catalogLoading && root.catalog.length === 0) return "fetching catalog…"
                if (root.catalog.length === 0) return ""
                return "showing " + root.visibleCatalog.length + " of " + root.catalog.length
              }
              if (root.loading && root.rows.length === 0) return "reading…"
              if (root.filtered) return "showing " + root.visibleRows.length + " of " + root.rows.length
              // Tight separators: the expand icon took the slack this line
              // used to have, and "to update" is the part that must survive.
              var summary = root.installedTotal + " installed · " + root.rows.length + " total"
              if (root.behindCount > 0) return summary + " · " + root.behindCount + " to update"
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
            anchors.right: expandButton.left
            anchors.rightMargin: Style.space(10)
            anchors.verticalCenter: parent.verticalCenter
            options: root.tabOptions
            // Highlights the destination the moment it is clicked, while the
            // content is still turning toward it.
            value: root.pendingTab !== "" ? root.pendingTab : root.activeTab
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

          // Icon only, like the refresh beside it: the popup's header has no
          // room for a labelled button, and the tooltip says the rest.
          PanelActionButton {
            id: expandButton
            anchors.right: refreshButton.left
            anchors.rightMargin: Style.space(6)
            anchors.verticalCenter: parent.verticalCenter
            iconText: "󰊓"
            fontSize: Style.font.display
            tooltipText: "Expand into a full panel"
            foreground: root.contentForeground
            fontFamily: root.contentFontFamily
            enabled: !root.busy
            opacity: enabled ? 1 : 0.4
            onClicked: root.expand()
          }

          PanelActionButton {
            id: refreshButton
            anchors.right: parent.right
            anchors.verticalCenter: parent.verticalCenter
            // The button's own glyph steps aside while a refresh runs and the
            // spinner below takes its place: a turning arrow says "working"
            // where a greyed one only said "not now".
            iconText: root.refreshing ? "" : "󰑐"
            // The one icon in the header, next to two text buttons: at the
            // default size it read as an afterthought beside them. Display
            // size puts it on the same scale as the title at the other end.
            fontSize: Style.font.display
            tooltipText: root.browsing ? "Re-fetch the catalog" : "Re-read the plugin list"
            foreground: root.contentForeground
            fontFamily: root.contentFontFamily
            enabled: !root.loading && !root.catalogLoading && !root.busy
            // Dimmed only while an action owns the panel; a refresh in flight
            // is shown by the spin, not by fading.
            opacity: root.busy ? 0.4 : 1
            // Forced past the cache: the refresh button exists precisely for
            // when you believe what is on screen is out of date.
            onClicked: {
              if (root.browsing) { root.loadCatalog(true); return }
              root.reload()
              root.checkUpdates()
            }

            Text {
              id: refreshSpinner
              // Never rich text: AutoText would fetch what a crafted string points at.
              textFormat: Text.PlainText
              anchors.centerIn: parent
              visible: root.refreshing
              text: "󰑐"
              color: refreshButton.foreground
              font.family: refreshButton.fontFamily
              font.pixelSize: refreshButton.fontSize

              RotationAnimation on rotation {
                running: root.refreshing
                from: 0
                to: 360
                direction: RotationAnimation.Clockwise
                duration: 900
                loops: Animation.Infinite
              }
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
            onTextChanged: {
              if (text === "") root.flushSearch()
              else searchDebounce.restart()
            }
            onAccepted: {
              root.flushSearch()
              root.returnFocusToList()
            }
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
            visible: root.browsing ? (root.catalogFiltered || searchField.text !== "") : searchField.text !== ""
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
        // One face of the tab-flip card; see contentFlip.
        transform: Rotation {
          origin.x: listScroll.width / 2
          origin.y: listScroll.height / 2
          axis { x: 0; y: 1; z: 0 }
          angle: root.contentFlipAngle
        }
        scale: root.contentFlipScale
        layer.enabled: root.contentFlipping
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
              updating: root.busyKind === "update" && root.busyRowId === modelData.id
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
        // The other face of the tab-flip card; see contentFlip.
        transform: Rotation {
          origin.x: catalogGrid.width / 2
          origin.y: catalogGrid.height / 2
          axis { x: 0; y: 1; z: 0 }
          angle: root.contentFlipAngle
        }
        scale: root.contentFlipScale
        layer.enabled: root.contentFlipping
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

        // No model until Browse has been shown once. A GridView builds the
        // delegates for its viewport whether or not it is visible, so the
        // hidden grid used to build a screenful of cards — and fetch their
        // previews — the moment the catalog landed, on every open that never
        // left Installed. Once shown it stays warm: the cards survive a trip
        // back to Installed, as they always did.
        model: root.browseVisited ? root.visibleCatalog : []

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
