import QtQuick
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

  readonly property int installedTotal: Model.countRemovable(rows)
  readonly property bool filtered: Model.isFiltering(kindFilter, searchQuery)

  // Any narrowing rebuilds the list under the selection, so the index is
  // dropped rather than left pointing at whatever now sits in that slot —
  // that is how a Delete keypress lands on the wrong plugin.
  onSearchQueryChanged: resetSelection()
  readonly property var selectedRow: selectedIndex >= 0 && selectedIndex < visibleRows.length
    ? visibleRows[selectedIndex]
    : null

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
  readonly property bool confirming: pendingKind !== ""

  readonly property string confirmMessage: {
    if (pendingKind === "add")
      return "Clone and enable " + pendingLabel + "?\n\n"
        + pendingUrl + "\n\n"
        + "Plugins run unsandboxed inside omarchy-shell. Only add repositories whose code you are willing to run."
    if (pendingKind === "remove")
      return "Remove " + pendingLabel + "?\n\nIts folder under ~/.config/omarchy/plugins is deleted."
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
    rows = Model.mergePlugins(listEntries, Model.parseArray(sections.catalog) || [], Model.parseGitMap(sections.git))
    clampSelection()
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
  }

  function clearSearch() {
    searchField.text = ""
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
    pendingId = ""
    pendingKind = "add"
  }

  function askRemove(row) {
    if (!row || !row.removable || busy) return
    pendingId = row.id
    pendingLabel = row.name
    pendingUrl = ""
    pendingKind = "remove"
  }

  function cancelPending() {
    pendingKind = ""
    pendingId = ""
    pendingLabel = ""
    pendingUrl = ""
  }

  function confirmPending() {
    if (pendingKind === "add") runAction("add", pendingLabel, ["omarchy", "plugin", "add", pendingUrl, "--enable", "--yes"])
    else if (pendingKind === "remove") runAction("remove", pendingLabel, ["omarchy", "plugin", "remove", pendingId, "--yes"])
    cancelPending()
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

  function moveSelection(delta) {
    if (visibleRows.length === 0) return
    var next = selectedIndex < 0 ? 0 : selectedIndex + delta
    selectedIndex = Math.max(0, Math.min(visibleRows.length - 1, next))
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
  }

  // ---- Processes ----------------------------------------------------------

  // One round trip for the whole picture: enabled state from `plugin list`,
  // source directories and descriptions from `plugin catalog`, and which
  // checkouts a pull can reach from the filesystem. The section markers print
  // unconditionally so a failed command shows up as unparseable output rather
  // than as a silently short list.
  Process {
    id: loadProc
    command: ["bash", "-c",
      "printf '===list===\\n'; "
      + "omarchy plugin list --json; "
      + "printf '\\n===catalog===\\n'; "
      + "omarchy plugin catalog; "
      + "printf '\\n===git===\\n'; "
      + "for dir in \"$HOME\"/.config/omarchy/plugins/*/; do "
      + "  [ -d \"$dir/.git\" ] || continue; "
      + "  path=\"${dir%/}\"; "
      + "  printf '%s\\t%s\\n' \"$path\" \"$(git -C \"$path\" remote get-url origin 2>/dev/null)\"; "
      + "done"
    ]
    stdout: StdioCollector {
      waitForEnd: true
      onStreamFinished: root.applyLoad(text)
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
      header.implicitHeight + listColumn.implicitHeight + hints.implicitHeight + Style.space(20),
      Style.space(500))

    PanelKeyCatcher {
      id: keyCatcher
      anchors.fill: parent
      blocked: root.confirming || urlField.activeFocus || searchField.activeFocus

      onMoveRequested: function(dx, dy) { if (dy !== 0) root.moveSelection(dy) }
      onActivateRequested: root.startUpdate(root.selectedRow)
      onDeleteRequested: root.askRemove(root.selectedRow)
      onCloseRequested: root.close()
      onTabRequested: function(direction) { root.switchPanel(direction) }
      onTextKey: function(t) {
        if (t === "/") root.focusSearchField()
        else if (t === "r" || t === "R") root.reload()
        else if (t === "a" || t === "A") root.focusUrlField()
        else if (t === "f" || t === "F") root.cycleKindFilter()
        else if (t === "j") root.moveSelection(1)
        else if (t === "k") root.moveSelection(-1)
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
            anchors.verticalCenter: parent.verticalCenter
            text: "Plugins"
            color: root.contentForeground
            font.family: root.contentFontFamily
            font.pixelSize: Style.font.title
            font.bold: true
          }

          Text {
            anchors.left: title.right
            anchors.leftMargin: Style.space(10)
            anchors.baseline: title.baseline
            text: {
              if (root.loading && root.rows.length === 0) return "reading…"
              if (root.filtered) return "showing " + root.visibleRows.length + " of " + root.rows.length
              return root.installedTotal + " installed  ·  " + root.rows.length + " total"
            }
            color: Color.muted
            font.family: root.contentFontFamily
            font.pixelSize: Style.font.caption
          }

          PanelActionButton {
            id: refreshButton
            anchors.right: parent.right
            anchors.verticalCenter: parent.verticalCenter
            iconText: "󰑐"
            tooltipText: "Re-read the plugin list"
            foreground: root.contentForeground
            fontFamily: root.contentFontFamily
            enabled: !root.loading && !root.busy
            opacity: enabled ? 1 : 0.4
            onClicked: root.reload()
          }
        }

        // ---- Add: a repository url and one button. Confirmed before it runs.
        Item {
          width: parent.width
          height: Math.max(urlField.implicitHeight, addButton.height)

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
          height: Math.max(kindFilterGroup.implicitHeight, searchField.implicitHeight)

          ButtonGroup {
            id: kindFilterGroup
            anchors.left: parent.left
            anchors.verticalCenter: parent.verticalCenter
            options: root.kindOptions
            value: root.kindFilter
            foreground: root.contentForeground
            fontFamily: root.contentFontFamily
            fontSize: Style.font.caption
            focusable: false
            onChanged: function(value) { root.setKindFilter(value) }
          }

          TextField {
            id: searchField
            anchors.left: kindFilterGroup.right
            anchors.leftMargin: Style.space(10)
            anchors.right: clearSearchButton.visible ? clearSearchButton.left : parent.right
            anchors.rightMargin: clearSearchButton.visible ? Style.space(4) : 0
            anchors.verticalCenter: parent.verticalCenter
            // The glyph rides in the placeholder rather than sitting in its
            // own column, because every pixel on this row belongs to the two
            // controls sharing it.
            placeholderText: "󰍉  Search by name…"
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
          width: parent.width
          visible: text !== ""
          text: {
            if (root.busy) return Model.actionGerund(root.busyKind) + " " + root.busyId + "…"
            if (root.loadError !== "") return root.loadError
            return root.status
          }
          color: root.statusIsError || root.loadError !== "" ? Color.urgent : Color.muted
          font.family: root.contentFontFamily
          font.pixelSize: Style.font.caption
          wrapMode: Text.WordWrap
        }
      }

      // ---- Key hints, pinned to the bottom so the list above can never push
      //      them off the card.
      Text {
        id: hints
        anchors.left: parent.left
        anchors.right: parent.right
        anchors.bottom: parent.bottom
        text: "↑↓ select   ⏎ update   ⌦ remove   / search   a add   f filter   r refresh"
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
            }
          }
        }
      }

      ConfirmDialog {
        id: confirm
        anchors.fill: parent
        z: 10
        opened: root.confirming
        message: root.confirmMessage
        confirmText: root.pendingKind === "remove" ? "Remove" : "Add"
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
    }
  }
}
