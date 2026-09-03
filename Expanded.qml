import QtQuick
import Quickshell
import Quickshell.Wayland
import qs.Commons
import qs.Ui
import "Model.js" as Model

// The plugin manager with room: the same inventory and the same marketplace
// as the popup, as a full-size overlay the shell summons on request.
//
// This is the plugin's `panel` entry point. The shell loads it when asked to
// summon this plugin id, hands it `shell` and `manifest`, then calls
// `open(payload)`; hiding calls `close()` and unloads it again. Nothing here
// keeps state between summons on purpose — every open re-reads the shell,
// exactly as opening the popup does.
//
// The data and every action live in PluginStore, shared with the popup. What
// is different here is only layout: Installed is a list beside a details
// pane rather than rows alone, and Browse gets a wider grid of the same cards.
Item {
  id: root

  property var shell: null
  property var manifest: null
  property bool opened: false
  // The output named by the summon payload. Resolved against the live screen
  // list on every read, so a monitor unplugged between summons yields null and
  // the window falls back to the shell's default rather than a dead screen.
  property string targetScreenName: ""
  readonly property var targetScreen: {
    if (targetScreenName === "") return null
    var screens = Quickshell.screens
    for (var i = 0; i < screens.length; i++)
      if (screens[i].name === targetScreenName) return screens[i]
    return null
  }

  readonly property string pluginId: manifest && manifest.id
    ? String(manifest.id) : "io.github.juancasanueva.plugin-manager"

  readonly property color foreground: Color.menu.text
  readonly property color secondaryForeground: Util.alpha(foreground, 0.54)
  readonly property string fontFamily: Style.font.family

  PluginStore {
    id: store
    selfId: root.pluginId
  }

  Connections {
    target: store
    function onRowsLoaded() { root.clampSelection() }
  }

  // ---- Lifecycle (called by the shell) --------------------------------------

  function open(payloadJson) {
    activeTab = Model.expandedTabFromPayload(payloadJson)
    targetScreenName = Model.expandedScreenFromPayload(payloadJson)
    selectedIndex = -1
    detailsEntry = null
    opened = true
    // The piece is hidden until the window's first frame, then snaps in.
    titleIconIntro.stop()
    titleIcon.opacity = 0
    titleIconIntroArmed = true
    // Not yet: the list read makes the shell serve an IPC call on its main
    // thread, and that stalls the intro playing right now. Once the piece
    // has landed, the read runs with nothing to interrupt.
    initialLoad.restart()
    Qt.callLater(function() { keyCatcher.forceActiveFocus() })
  }

  function loadEverything() {
    store.loadOnOpen()
  }

  Timer {
    id: initialLoad
    interval: 1300
    repeat: false
    onTriggered: root.loadEverything()
  }

  function close() {
    initialLoad.stop()
    opened = false
    detailsEntry = null
    selectedIndex = -1
    store.cancelPending()
  }

  // Closing from inside goes through the shell so its own open-set agrees
  // with what is on screen; without a shell (a bare test host) just close.
  function dismiss() {
    if (shell && typeof shell.hide === "function") shell.hide(pluginId)
    else close()
  }

  // Back to the popup: hide this window, then ask the bar for its widget.
  // The bar finds it by module name, so the routing change that sends
  // summon() here does not get in the way.
  function collapse() {
    dismiss()
    if (shell && shell.bar && typeof shell.bar.summonBarWidget === "function") shell.bar.summonBarWidget(pluginId)
  }

  // ---- Shared state, mirrored from the store ---------------------------------

  property alias rows: store.rows
  property alias loading: store.loading
  property alias loadError: store.loadError
  property alias checkingUpdates: store.checkingUpdates
  readonly property alias behindCount: store.behindCount
  readonly property alias updateActionsEnabled: store.updateActionsEnabled
  readonly property alias installedTotal: store.installedTotal
  property alias catalog: store.catalog
  readonly property alias verifiedIds: store.verifiedIds
  readonly property alias starsById: store.starsById
  property alias catalogLoading: store.catalogLoading
  property alias catalogLoaded: store.catalogLoaded
  property alias catalogError: store.catalogError
  property alias previewsSupported: store.previewsSupported
  property alias busyKind: store.busyKind
  property alias busyRowId: store.busyRowId
  property alias busyId: store.busyId
  readonly property alias busy: store.busy
  property alias status: store.status
  property alias statusIsError: store.statusIsError
  readonly property alias pendingKind: store.pendingKind
  readonly property alias confirming: store.confirming
  readonly property alias placing: store.placing
  readonly property alias placementChoices: store.placementChoices
  readonly property alias placementMessage: store.placementMessage
  readonly property alias confirmMessage: store.confirmMessage

  // ---- Tabs -------------------------------------------------------------------

  property string activeTab: "installed"   // "installed" | "browse"
  readonly property bool browsing: activeTab === "browse"

  property bool titleIconIntroArmed: false

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

  function switchTab(tab) {
    // A click mid-turn lands the turn in progress first rather than being
    // swallowed, so no tap is ever lost to the animation.
    if (contentFlip.running) {
      contentFlip.stop()
      if (pendingTab !== "") applyPendingTab()
      contentFlipAngle = 0
    }
    if (activeTab === tab) return
    pendingTab = tab
    contentFlip.direction = tab === "browse" ? 1 : -1
    contentFlip.restart()
  }

  // The actual switch, run at the edge-on midpoint where nothing is visible.
  function applyPendingTab() {
    var tab = pendingTab
    if (tab === "") return
    pendingTab = ""
    activeTab = tab
  }

  readonly property var tabOptions: [
    { value: "installed", label: "Installed" },
    { value: "browse", label: "Browse" }
  ]
  readonly property bool refreshing: browsing ? catalogLoading : (loading || checkingUpdates)

  onActiveTabChanged: {
    detailsEntry = null
    // Browse starts with nothing under the cursor; Installed starts on the
    // first row so the details pane is never empty for no reason.
    selectedIndex = !browsing && visibleRows.length > 0 ? 0 : -1
  }

  // ---- Installed --------------------------------------------------------------

  property int selectedIndex: -1
  readonly property string searchQuery: searchField.text

  // The same three filters as the popup, with the same replay handlers:
  // Ui/Dropdown assigns its own value on a pick, which breaks the `value:`
  // binding, so every change that comes from a key is pushed back into it.
  property string groupFilter: "all"
  readonly property var groupOptions: Model.groupOptions()
  property string kindFilter: "all"
  readonly property var kindOptions: Model.kindOptions(rows)
  property string statusFilter: "all"
  readonly property var statusOptions: Model.statusOptions()
  onGroupFilterChanged: if (groupDropdown && groupDropdown.value !== groupFilter)
    groupDropdown.value = groupFilter
  onKindFilterChanged: if (kindDropdown && kindDropdown.value !== kindFilter)
    kindDropdown.value = kindFilter
  onStatusFilterChanged: if (statusDropdown && statusDropdown.value !== statusFilter)
    statusDropdown.value = statusFilter
  readonly property var installedFilterHints: Model.installedFilterHints(
    { group: groupFilter, kind: kindFilter, status: statusFilter },
    { group: groupOptions, kind: kindOptions, status: statusOptions })

  readonly property var visibleRows: Model.filterRows(rows, kindFilter, statusFilter, searchQuery, groupFilter)
  readonly property var installedRows: Model.rowsInGroup(visibleRows, "installed")
  readonly property var builtinRows: Model.rowsInGroup(visibleRows, "built-in")
  readonly property bool filtered: Model.isFiltering(kindFilter, statusFilter, searchQuery, groupFilter)

  // Any narrowing rebuilds the list under the selection; the first row is the
  // honest place to land rather than whatever now sits in the old slot.
  function setGroupFilter(group) {
    if (groupFilter === group) return
    groupFilter = group
    selectedIndex = visibleRows.length > 0 ? 0 : -1
  }
  function setKindFilter(kind) {
    if (kindFilter === kind) return
    kindFilter = kind
    selectedIndex = visibleRows.length > 0 ? 0 : -1
  }
  function setStatusFilter(status) {
    if (statusFilter === status) return
    statusFilter = status
    selectedIndex = visibleRows.length > 0 ? 0 : -1
  }
  function cycleGroupFilter() { setGroupFilter(Model.nextOption(groupOptions, groupFilter)) }
  function cycleKindFilter() { setKindFilter(Model.nextOption(kindOptions, kindFilter)) }
  function cycleStatusFilter() { setStatusFilter(Model.nextOption(statusOptions, statusFilter)) }
  readonly property var selectedRow: !browsing && selectedIndex >= 0 && selectedIndex < visibleRows.length
    ? visibleRows[selectedIndex]
    : null

  // A pane with nothing in it is a pane that says "select something" to a
  // reader who has not touched anything yet; the first row is the obvious
  // answer, and it is what the arrow keys would land on anyway.
  onVisibleRowsChanged: if (!browsing && selectedIndex < 0 && visibleRows.length > 0) selectedIndex = 0
  onSearchQueryChanged: selectedIndex = visibleRows.length > 0 ? 0 : -1

  function clampSelection() {
    if (selectedIndex >= selectableCount) selectedIndex = selectableCount - 1
  }

  // ---- Browse -----------------------------------------------------------------

  property string categoryFilter: "all"
  property string catalogKindFilter: "all"
  property string availabilityFilter: "all"
  property string catalogSort: "recently-added"

  readonly property var categoryOptions: Model.catalogCategories(catalog)
  readonly property var catalogKindOptions: Model.catalogKindOptions(catalog)
  readonly property var availabilityOptions: Model.catalogAvailabilityOptions()
  readonly property var catalogSortOptions: Model.catalogSortOptions()
  readonly property bool catalogFiltered: Model.catalogIsFiltering(
    categoryFilter, catalogKindFilter, availabilityFilter, searchQuery)
  readonly property var filteredCatalog: Model.filterCatalog(
    catalog, categoryFilter, catalogKindFilter, availabilityFilter, searchQuery)
  readonly property var visibleCatalog: Model.sortCatalog(filteredCatalog, catalogSort)
  readonly property var selectedEntry: browsing && selectedIndex >= 0 && selectedIndex < visibleCatalog.length
    ? visibleCatalog[selectedIndex]
    : null
  readonly property int selectableCount: browsing ? visibleCatalog.length : visibleRows.length

  // The kit's Dropdown writes its own value on a pick, which severs the
  // binding; every filter the panel changes from outside is pushed back in.
  onCategoryFilterChanged: if (categoryDropdown && categoryDropdown.value !== categoryFilter)
    categoryDropdown.value = categoryFilter
  onCatalogKindFilterChanged: if (catalogKindDropdown && catalogKindDropdown.value !== catalogKindFilter)
    catalogKindDropdown.value = catalogKindFilter
  onAvailabilityFilterChanged: if (availabilityDropdown && availabilityDropdown.value !== availabilityFilter)
    availabilityDropdown.value = availabilityFilter
  onCatalogSortChanged: if (sortDropdown && sortDropdown.value !== catalogSort)
    sortDropdown.value = catalogSort
  onCategoryOptionsChanged: {
    for (var i = 0; i < categoryOptions.length; i++)
      if (categoryOptions[i].value === categoryFilter) return
    categoryFilter = "all"
  }
  onCatalogKindOptionsChanged: {
    for (var i = 0; i < catalogKindOptions.length; i++)
      if (catalogKindOptions[i].value === catalogKindFilter) return
    catalogKindFilter = "all"
  }

  readonly property var browseFilterHints: Model.browseFilterHints(
    { category: categoryFilter, kind: catalogKindFilter, availability: availabilityFilter, sort: catalogSort },
    { category: categoryOptions, kind: catalogKindOptions, availability: availabilityOptions, sort: catalogSortOptions })

  function cycleCategoryFilter() { categoryFilter = Model.nextOption(categoryOptions, categoryFilter); selectedIndex = -1 }
  function cycleCatalogKindFilter() { catalogKindFilter = Model.nextOption(catalogKindOptions, catalogKindFilter); selectedIndex = -1 }
  function cycleAvailabilityFilter() { availabilityFilter = Model.nextOption(availabilityOptions, availabilityFilter); selectedIndex = -1 }
  function cycleCatalogSort() { catalogSort = Model.nextOption(catalogSortOptions, catalogSort); selectedIndex = -1 }

  function clearCatalogFilters() {
    var cleared = Model.clearedCatalogFilters()
    categoryFilter = cleared.category
    catalogKindFilter = cleared.kind
    availabilityFilter = cleared.availability
    searchField.text = ""
    selectedIndex = -1
  }

  property var detailsEntry: null
  readonly property bool detailsOpen: detailsEntry !== null
  onCatalogChanged: if (detailsEntry) detailsEntry = Model.findRow(catalog, detailsEntry.id)

  function openDetails(entry) {
    if (!entry) return
    detailsEntry = entry
  }

  function closeDetails() {
    detailsEntry = null
  }

  // ---- Actions -----------------------------------------------------------------
  //
  // Every ask is the store's; this surface only closes what it had open.

  function askInstall(entry) {
    if (!store.askInstall(entry)) return
    detailsEntry = null
  }

  function startUpdate(row) {
    store.startUpdate(row)
  }

  // Links open through the same trusted-url gate as the popup's rows. The
  // popup's Release-probe dance is left out here: this surface offers the
  // repository link only, which needs no probing.
  function navigateExternalUrl(url) {
    var trusted = Model.browsableUrl(url)
    if (trusted !== "") Quickshell.execDetached(["omarchy-launch-browser", trusted])
  }

  // ---- Keyboard -----------------------------------------------------------------

  function moveSelection(dx, dy) {
    if (selectableCount === 0) return
    var step = browsing ? (dx !== 0 ? dx : dy * catalogGrid.columns) : dy
    if (step === 0) return
    var next = selectedIndex < 0 ? 0 : selectedIndex + step
    selectedIndex = Math.max(0, Math.min(selectableCount - 1, next))
    if (browsing) catalogGrid.positionViewAtIndex(selectedIndex, GridView.Contain)
    else ensureRowVisible()
  }

  // Keep the selected row on screen when the keyboard moves it: the list is
  // a plain column, so the row's position is asked of the column itself.
  function ensureRowVisible() {
    var item = selectedRowItem()
    if (!item) return
    var top = item.mapToItem(listColumn, 0, 0).y
    var bottom = top + item.height
    if (top < listScroll.contentY) listScroll.contentY = top
    else if (bottom > listScroll.contentY + listScroll.height)
      listScroll.contentY = bottom - listScroll.height
  }

  function selectedRowItem() {
    if (selectedIndex < 0) return null
    if (selectedIndex < installedRows.length) return installedRepeater.itemAt(selectedIndex)
    return builtinRepeater.itemAt(selectedIndex - installedRows.length)
  }

  function returnFocusToList() {
    keyCatcher.forceActiveFocus()
  }

  // ---- Window ------------------------------------------------------------------

  PanelWindow {
    id: window
    visible: root.opened
    screen: root.targetScreen
    anchors { top: true; bottom: true; left: true; right: true }
    color: "transparent"
    exclusionMode: ExclusionMode.Ignore
    WlrLayershell.namespace: "plugin-manager"
    WlrLayershell.layer: WlrLayer.Overlay
    WlrLayershell.keyboardFocus: WlrKeyboardFocus.Exclusive

    Rectangle {
      anchors.fill: parent
      color: Color.menu.scrim

      MouseArea {
        anchors.fill: parent
        onClicked: root.dismiss()
      }
    }

    BorderSurface {
      id: card
      anchors.centerIn: parent
      width: Math.min(Style.space(1180), window.width - Style.gapsOut * 4)
      height: Math.min(Style.space(820), window.height - Style.gapsOut * 4)
      radius: Style.cornerRadius
      color: Color.menu.background
      borderSpec: Border.surfaceSpec("menu", "border", Color.menu.border, Math.max(1, Style.space(2)))
      padding: Style.spacing.panelPadding

      MouseArea { anchors.fill: parent; onClicked: {} }

      Item {
        id: keyCatcher
        anchors.fill: parent
        anchors.leftMargin: card.contentLeftInset
        anchors.rightMargin: card.contentRightInset
        anchors.topMargin: card.contentTopInset
        anchors.bottomMargin: card.contentBottomInset
        focus: true

        Keys.onPressed: function(event) {
          if (root.confirming || root.placing) return
          var text = event.text
          if (event.key === Qt.Key_Escape) {
            if (root.detailsOpen) root.closeDetails()
            else root.dismiss()
            event.accepted = true
          }
          else if (root.detailsOpen) return
          else if (event.key === Qt.Key_Down || text === "j") { root.moveSelection(0, 1); event.accepted = true }
          else if (event.key === Qt.Key_Up || text === "k") { root.moveSelection(0, -1); event.accepted = true }
          else if (event.key === Qt.Key_Right || text === "l") { root.moveSelection(1, 0); event.accepted = true }
          else if (event.key === Qt.Key_Left || text === "h") { root.moveSelection(-1, 0); event.accepted = true }
          else if (event.key === Qt.Key_Return || event.key === Qt.Key_Enter) {
            if (root.browsing) root.openDetails(root.selectedEntry)
            else if (root.selectedRow) root.startUpdate(root.selectedRow)
            event.accepted = true
          }
          else if (event.key === Qt.Key_Delete && !root.browsing) {
            if (root.selectedRow && root.selectedRow.removable === true && !root.busy) store.askRemove(root.selectedRow)
            event.accepted = true
          }
          // The popup's filter keys, unchanged: f kind, s source (Installed) or
          // sort (Browse), t status, c category, a availability.
          else if ((text === "f" || text === "F")) root.browsing ? root.cycleCatalogKindFilter() : root.cycleKindFilter()
          else if ((text === "s" || text === "S")) root.browsing ? root.cycleCatalogSort() : root.cycleGroupFilter()
          else if ((text === "t" || text === "T") && !root.browsing) root.cycleStatusFilter()
          else if ((text === "c" || text === "C") && root.browsing) root.cycleCategoryFilter()
          else if ((text === "a" || text === "A") && root.browsing) root.cycleAvailabilityFilter()
          else if (text === "/") { searchField.forceActiveFocus(); event.accepted = true }
          else if (text === "r" || text === "R") {
            if (root.browsing) store.loadCatalog(true)
            else { store.reload(); store.checkUpdates() }
            event.accepted = true
          }
          else if (text === "1") { root.switchTab("installed"); event.accepted = true }
          else if (text === "2") { root.switchTab("browse"); event.accepted = true }
        }

        // ---- Header: what this is, the tabs, and the two icons.
        Item {
          id: header
          anchors.left: parent.left
          anchors.right: parent.right
          anchors.top: parent.top
          height: Math.max(title.implicitHeight, refreshButton.height)

          Text {
            id: titleIcon
            // Never rich text: AutoText would fetch what a crafted string points at.
            textFormat: Text.PlainText
            anchors.left: parent.left
            anchors.baseline: title.baseline
            text: "󰐱"
            color: root.foreground
            font.family: root.fontFamily
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
            color: root.foreground
            font.family: root.fontFamily
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
            font.family: root.fontFamily
            font.pixelSize: Style.font.caption
          }

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
            font.family: root.fontFamily
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
              fontFamily: root.fontFamily
            }
          }

          ButtonGroup {
            id: tabs
            anchors.right: collapseButton.left
            anchors.rightMargin: Style.space(10)
            anchors.verticalCenter: parent.verticalCenter
            options: root.tabOptions
            value: root.pendingTab !== "" ? root.pendingTab : root.activeTab
            foreground: root.foreground
            fontFamily: root.fontFamily
            fontSize: Style.font.caption
            focusable: false
            onChanged: function(value) { root.switchTab(value) }
          }

          // The way back. Same slot the popup's expand icon sits in, so the
          // eye finds the pair of them in the same corner on both surfaces.
          PanelActionButton {
            id: collapseButton
            anchors.right: refreshButton.left
            anchors.rightMargin: Style.space(6)
            anchors.verticalCenter: parent.verticalCenter
            iconText: "󰊔"
            fontSize: Style.font.display
            tooltipText: "Back to the popup"
            foreground: root.foreground
            fontFamily: root.fontFamily
            onClicked: root.collapse()
          }

          PanelActionButton {
            id: refreshButton
            anchors.right: parent.right
            anchors.verticalCenter: parent.verticalCenter
            iconText: root.refreshing ? "" : "󰑐"
            fontSize: Style.font.display
            tooltipText: root.browsing ? "Re-fetch the catalog" : "Re-read the plugin list"
            foreground: root.foreground
            fontFamily: root.fontFamily
            enabled: !root.loading && !root.catalogLoading && !root.busy
            opacity: root.busy ? 0.4 : 1
            onClicked: {
              if (root.browsing) { store.loadCatalog(true); return }
              store.reload()
              store.checkUpdates()
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

        PanelSeparator {
          id: headerRule
          anchors.top: header.bottom
          anchors.topMargin: Style.space(10)
          foreground: root.foreground
        }

        // ---- Search plus the tab's filters: three on Installed, four on
        //      Browse. One row, shared by both tabs so the search box never moves.
        Item {
          id: controls
          anchors.left: parent.left
          anchors.right: parent.right
          anchors.top: headerRule.bottom
          anchors.topMargin: Style.space(10)
          // Every control carries its caption above it; the row is as tall
          // as a captioned dropdown and everything sits on its bottom edge.
          height: root.browsing ? browseFilters.implicitHeight : installedFilters.implicitHeight

          readonly property real gap: Style.space(6)
          readonly property real filterWidth: Style.space(150)

          // The search is the first control in the row, so it wears the same
          // caption above and the same control height as the dropdowns beside
          // it — one row of labelled controls, not a box with some menus.
          Item {
            id: searchControl
            anchors.left: parent.left
            anchors.top: parent.top
            anchors.bottom: parent.bottom
            anchors.right: root.browsing ? browseFilters.left : installedFilters.left
            anchors.rightMargin: controls.gap

            Text {
              id: searchLabel
              // Never rich text: AutoText would fetch what a crafted string points at.
              textFormat: Text.PlainText
              anchors.left: parent.left
              anchors.top: parent.top
              text: "Search"
              color: root.secondaryForeground
              font.family: root.fontFamily
              font.pixelSize: Style.font.caption
              font.bold: true
            }

            TextField {
              id: searchField
              anchors.left: parent.left
              anchors.right: parent.right
              anchors.bottom: parent.bottom
              height: Style.spacing.controlHeight
              placeholderText: root.browsing ? "󰍉  Search the catalog…" : "󰍉  Search by name…"
              foreground: root.foreground
              placeholderTextColor: root.secondaryForeground
              font.family: root.fontFamily
              font.pixelSize: Style.font.body

              onAccepted: root.returnFocusToList()
              Keys.onPressed: function(event) {
                if (event.key !== Qt.Key_Escape) return
                if (searchField.text !== "") searchField.text = ""
                else root.returnFocusToList()
                event.accepted = true
              }
            }
          }

          Row {
            id: installedFilters
            anchors.right: parent.right
            anchors.bottom: parent.bottom
            visible: !root.browsing
            spacing: controls.gap

            Dropdown {
              id: groupDropdown
              width: controls.filterWidth
              label: "Source"
              options: root.groupOptions
              value: root.groupFilter
              foreground: root.foreground
              fontFamily: root.fontFamily
              onChanged: function(value) { root.setGroupFilter(value) }
            }

            Dropdown {
              id: kindDropdown
              width: controls.filterWidth
              label: "Kind"
              options: root.kindOptions
              value: root.kindFilter
              foreground: root.foreground
              fontFamily: root.fontFamily
              onChanged: function(value) { root.setKindFilter(value) }
            }

            Dropdown {
              id: statusDropdown
              width: controls.filterWidth
              label: "Status"
              options: root.statusOptions
              value: root.statusFilter
              foreground: root.foreground
              fontFamily: root.fontFamily
              onChanged: function(value) { root.setStatusFilter(value) }
            }
          }

          Row {
            id: browseFilters
            anchors.right: parent.right
            anchors.bottom: parent.bottom
            visible: root.browsing
            spacing: controls.gap

            Dropdown {
              id: categoryDropdown
              width: controls.filterWidth
              label: "Category"
              options: root.categoryOptions
              value: root.categoryFilter
              foreground: root.foreground
              fontFamily: root.fontFamily
              onChanged: function(value) { root.categoryFilter = value }
            }

            Dropdown {
              id: catalogKindDropdown
              width: controls.filterWidth
              label: "Kind"
              options: root.catalogKindOptions
              value: root.catalogKindFilter
              foreground: root.foreground
              fontFamily: root.fontFamily
              onChanged: function(value) { root.catalogKindFilter = value }
            }

            Dropdown {
              id: availabilityDropdown
              width: controls.filterWidth
              label: "Availability"
              options: root.availabilityOptions
              value: root.availabilityFilter
              foreground: root.foreground
              fontFamily: root.fontFamily
              onChanged: function(value) { root.availabilityFilter = value }
            }

            Dropdown {
              id: sortDropdown
              width: controls.filterWidth
              label: "Sort"
              options: root.catalogSortOptions
              value: root.catalogSort
              foreground: root.foreground
              fontFamily: root.fontFamily
              onChanged: function(value) { root.catalogSort = value }
            }
          }
        }

        // ---- Status: the last thing that happened, good or bad.
        Text {
          id: statusLine
          // Never rich text: AutoText would fetch what a crafted string points at.
          textFormat: Text.PlainText
          anchors.left: parent.left
          anchors.right: parent.right
          anchors.top: controls.bottom
          anchors.topMargin: text !== "" ? Style.space(8) : 0
          height: text !== "" ? implicitHeight : 0
          text: {
            if (root.busy) return Model.actionGerund(root.busyKind) + " " + root.busyId + "…"
            if (root.browsing && root.catalogError !== "") return root.catalogError
            if (!root.browsing && root.loadError !== "") return root.loadError
            return root.status
          }
          color: root.statusIsError || root.loadError !== "" || root.catalogError !== "" ? Color.urgent : root.secondaryForeground
          font.family: root.fontFamily
          font.pixelSize: Style.font.caption
          wrapMode: Text.WordWrap
        }

        // ---- Key hints, pinned to the bottom: the filter keys on the left
        //      name the filter and light up when one is narrowing; the row
        //      actions and the way out sit on the right, as in the popup.
        Column {
          id: hintBar
          anchors.left: parent.left
          anchors.right: parent.right
          anchors.bottom: parent.bottom
          spacing: Style.space(8)

          PanelSeparator { foreground: root.foreground }

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
                model: Model.actionHints(root.browsing).concat([{ key: "esc", text: "CLOSE", active: false }])
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
                font.family: root.fontFamily
                font.pixelSize: Style.font.caption
                font.bold: true
              }

              Text {
                // Never rich text: AutoText would fetch what a crafted string points at.
                textFormat: Text.PlainText
                text: hint.modelData.text
                color: hint.modelData.active ? root.foreground : root.secondaryForeground
                font.family: root.fontFamily
                font.pixelSize: Style.font.caption
              }
            }
          }
        }

        // ---- Installed: the list on the left, one plugin in full on the right.
        Item {
          id: installedPane
          visible: !root.browsing
          anchors.left: parent.left
          anchors.right: parent.right
          anchors.top: statusLine.bottom
          anchors.topMargin: Style.space(10)
          anchors.bottom: hintBar.top
          anchors.bottomMargin: Style.space(10)
          // One face of the tab-flip card; see contentFlip.
          transform: Rotation {
            origin.x: installedPane.width / 2
            origin.y: installedPane.height / 2
            axis { x: 0; y: 1; z: 0 }
            angle: root.contentFlipAngle
          }
          scale: root.contentFlipScale
          layer.enabled: root.contentFlipping

          Flickable {
            id: listScroll
            anchors.left: parent.left
            anchors.top: parent.top
            anchors.bottom: parent.bottom
            width: Style.space(440)
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
                text: Model.emptyMessage("all", "all", root.searchQuery, "all")
                color: root.secondaryForeground
                font.family: root.fontFamily
                font.pixelSize: Style.font.caption
                topPadding: Style.space(12)
                bottomPadding: Style.space(12)
                horizontalAlignment: Text.AlignHCenter
              }

              PanelSectionHeader {
                visible: root.installedRows.length > 0
                text: Model.sectionHeading(root.visibleRows, "installed")
                foreground: root.foreground
                color: root.secondaryForeground
                fontFamily: root.fontFamily
                bottomPadding: Style.space(4)
              }

              Repeater {
                id: installedRepeater
                model: root.installedRows

                InstalledListRow {
                  required property int index
                  required property var modelData

                  width: listColumn.width
                  row: modelData
                  verified: Model.isVerified(modelData, root.verifiedIds)
                  stars: Model.rowStarLabel(modelData, root.starsById)
                  selected: root.selectedIndex === index
                  showSeparator: index < root.installedRows.length - 1 // qmllint disable unqualified
                  foreground: root.foreground
                  secondaryForeground: root.secondaryForeground
                  fontFamily: root.fontFamily

                  onClicked: root.selectedIndex = index
                }
              }

              PanelSectionHeader {
                visible: root.builtinRows.length > 0
                text: Model.sectionHeading(root.visibleRows, "built-in")
                foreground: root.foreground
                color: root.secondaryForeground
                fontFamily: root.fontFamily
                topPadding: Style.space(12)
                bottomPadding: Style.space(4)
              }

              Repeater {
                id: builtinRepeater
                model: root.builtinRows

                InstalledListRow {
                  required property int index
                  required property var modelData

                  readonly property int globalIndex: root.installedRows.length + index

                  width: listColumn.width
                  row: modelData
                  verified: Model.isVerified(modelData, root.verifiedIds)
                  stars: Model.rowStarLabel(modelData, root.starsById)
                  selected: root.selectedIndex === globalIndex
                  showSeparator: index < root.builtinRows.length - 1 // qmllint disable unqualified
                  foreground: root.foreground
                  secondaryForeground: root.secondaryForeground
                  fontFamily: root.fontFamily

                  onClicked: root.selectedIndex = globalIndex
                }
              }
            }
          }

          Rectangle {
            id: paneRule
            anchors.left: listScroll.right
            anchors.leftMargin: Style.space(12)
            anchors.top: parent.top
            anchors.bottom: parent.bottom
            width: 1
            color: root.foreground
            opacity: 0.12
          }

          InstalledDetails {
            id: installedDetails
            anchors.left: paneRule.right
            anchors.leftMargin: Style.space(16)
            anchors.right: parent.right
            anchors.top: parent.top
            anchors.bottom: parent.bottom
            row: root.selectedRow
            verified: Model.isVerified(root.selectedRow, root.verifiedIds)
            actionsEnabled: !root.busy
            updateEnabled: root.updateActionsEnabled
            updating: root.busyKind === "update" && root.selectedRow !== null && root.busyRowId === root.selectedRow.id
            foreground: root.foreground
            secondaryForeground: root.secondaryForeground
            fontFamily: root.fontFamily

            onUpdateRequested: root.startUpdate(root.selectedRow)
            onRemoveRequested: store.askRemove(root.selectedRow)
            onEnableRequested: store.askEnable(root.selectedRow)
            onDisableRequested: store.askDisable(root.selectedRow)
            onRepositoryNavigationRequested: function(url) { root.navigateExternalUrl(url) }
          }
        }

        // ---- Browse: the popup's card grid, one column wider.
        GridView {
          id: catalogGrid
          visible: root.browsing
          anchors.left: parent.left
          anchors.right: parent.right
          anchors.top: statusLine.bottom
          anchors.topMargin: Style.space(10)
          anchors.bottom: hintBar.top
          anchors.bottomMargin: Style.space(10)
          // One face of the tab-flip card; see contentFlip.
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

          readonly property int columns: 4
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
            font.family: root.fontFamily
            font.pixelSize: Style.font.bodySmall
          }

          FontMetrics {
            id: cardTextMetrics
            font.family: root.fontFamily
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
              foreground: root.foreground
              secondaryForeground: root.secondaryForeground
              fontFamily: root.fontFamily

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

          Column {
            anchors.centerIn: parent
            width: parent.width - Style.space(40)
            visible: root.visibleCatalog.length === 0
            spacing: Style.space(10)

            Text {
              // Never rich text: AutoText would fetch what a crafted string points at.
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
              font.family: root.fontFamily
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
              foreground: root.foreground
              fontFamily: root.fontFamily
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
          background: Color.menu.background
          foreground: root.foreground
          secondaryForeground: root.secondaryForeground
          fontFamily: root.fontFamily

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
          // No Release probing on this surface: the fallback page is the
          // Releases list, which is always a fine place to land.
          onGithubNavigationRequested: function(candidates, fallbackUrl) { root.navigateExternalUrl(fallbackUrl) }
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
          background: Color.menu.background
          foreground: root.foreground
          fontFamily: root.fontFamily

          onOpenedChanged: {
            if (opened) forceActiveFocus()
            else root.returnFocusToList()
          }

          Keys.onPressed: function(event) {
            if (confirm.handleKey(event)) event.accepted = true
          }

          onCanceled: store.cancelPending()
          onConfirmed: store.confirmPending()
        }

        ChoiceDialog {
          id: placement
          anchors.fill: parent
          z: 10
          opened: root.placing
          message: root.placementMessage
          choices: root.placementChoices
          background: Color.menu.background
          foreground: root.foreground
          fontFamily: root.fontFamily

          onOpenedChanged: {
            if (opened) forceActiveFocus()
            else root.returnFocusToList()
          }

          Keys.onPressed: function(event) {
            if (placement.handleKey(event)) event.accepted = true
          }

          onCanceled: store.cancelPending()
          onChosen: function(value) { store.confirmPlacement(value) }
        }
      }
    }
  }
}
