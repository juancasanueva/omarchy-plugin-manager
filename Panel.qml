import QtQuick
import Quickshell.Io
import qs.Commons
import qs.Ui
import "Model.js" as Model

// The plugin manager's popup: every plugin the shell discovered, in one
// list, with the three lifecycle actions the CLI already exposes — add a
// repo, update a checkout, remove an install.
//
// The list is read from `omarchy plugin list` and `omarchy plugin catalog`
// rather than from shell.json, so it shows what the shell actually found,
// not what the config claims. Actions shell out to the same `omarchy plugin`
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

  readonly property int pluginCount: rows.length
  readonly property int installedCount: Model.countRemovable(rows)
  readonly property var selectedRow: selectedIndex >= 0 && selectedIndex < rows.length ? rows[selectedIndex] : null

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
    if (selectedIndex >= rows.length) selectedIndex = rows.length - 1
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
    if (rows.length === 0) return
    var next = selectedIndex < 0 ? 0 : selectedIndex + delta
    selectedIndex = Math.max(0, Math.min(rows.length - 1, next))
    pluginList.positionViewAtIndex(selectedIndex, ListView.Contain)
  }

  function focusUrlField() {
    urlField.forceActiveFocus()
    urlField.selectAll()
  }

  function blurUrlField() {
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
    contentWidth: panel.fittedContentWidth(Style.space(560))
    contentHeight: panel.fittedContentHeight(content.implicitHeight)

    PanelKeyCatcher {
      id: keyCatcher
      anchors.fill: parent
      blocked: root.confirming || urlField.activeFocus

      onMoveRequested: function(dx, dy) { if (dy !== 0) root.moveSelection(dy) }
      onActivateRequested: root.startUpdate(root.selectedRow)
      onDeleteRequested: root.askRemove(root.selectedRow)
      onCloseRequested: root.close()
      onTabRequested: function(direction) { root.switchPanel(direction) }
      onTextKey: function(t) {
        if (t === "r" || t === "R") root.reload()
        else if (t === "a" || t === "A") root.focusUrlField()
        else if (t === "j") root.moveSelection(1)
        else if (t === "k") root.moveSelection(-1)
      }

      // Width comes from the panel, height from the children. Anchoring the
      // fill instead would make the column's height depend on the panel's,
      // which is itself derived from this column's implicitHeight.
      Column {
        id: content
        anchors.left: parent.left
        anchors.right: parent.right
        anchors.top: parent.top
        spacing: Style.space(10)

        // ---- Header: what this is, how much of it there is, and a way to
        //      re-read without closing the panel.
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
            text: root.loading && root.rows.length === 0
              ? "reading…"
              : root.installedCount + " installed  ·  " + root.pluginCount + " total"
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
              root.blurUrlField()
              event.accepted = true
            }
          }

          PanelActionButton {
            id: addButton
            anchors.right: parent.right
            anchors.verticalCenter: parent.verticalCenter
            iconText: root.busyKind === "add" ? "󰑐" : "󰐕"
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

        // ---- The list.
        ListView {
          id: pluginList
          width: parent.width
          // Derived from the row count rather than from contentHeight: a
          // ListView whose height reads its own content height is one
          // delegate resize away from a binding loop.
          height: Math.min(Style.space(360), Math.max(Style.space(48), root.rows.length * (Style.space(44) + Style.space(2))))
          model: root.rows
          clip: true
          boundsBehavior: Flickable.StopAtBounds
          spacing: Style.space(2)

          delegate: Rectangle {
            id: row

            required property int index
            required property var modelData

            readonly property bool selected: root.selectedIndex === index
            readonly property bool rowBusy: root.busy && root.busyId === modelData.name

            width: pluginList.width
            height: Style.space(44)
            radius: Style.cornerRadius
            color: selected ? Style.selectedFill : (rowMouse.containsMouse ? Style.hoverFill : "transparent")

            MouseArea {
              id: rowMouse
              anchors.fill: parent
              hoverEnabled: true
              onClicked: root.selectedIndex = row.index
            }

            // Enabled marker. A plugin the shell discovered but is not
            // running looks different from one that is; the dot is the whole
            // difference, so it sits first.
            Rectangle {
              id: stateDot
              anchors.left: parent.left
              anchors.leftMargin: Style.space(10)
              anchors.verticalCenter: parent.verticalCenter
              width: Style.space(6)
              height: width
              radius: width / 2
              color: row.modelData.enabled ? Color.accent : Color.muted
              opacity: row.modelData.enabled ? 1 : 0.5
            }

            Column {
              anchors.left: stateDot.right
              anchors.leftMargin: Style.space(10)
              anchors.right: actions.left
              anchors.rightMargin: Style.space(10)
              anchors.verticalCenter: parent.verticalCenter
              spacing: Style.space(2)

              Text {
                width: parent.width
                text: row.modelData.name
                color: root.contentForeground
                font.family: root.contentFontFamily
                font.pixelSize: Style.font.bodySmall
                elide: Text.ElideRight
              }

              Text {
                width: parent.width
                text: Model.subtitle(row.modelData)
                color: Color.muted
                font.family: root.contentFontFamily
                font.pixelSize: Style.font.caption
                elide: Text.ElideRight
              }
            }

            Row {
              id: actions
              anchors.right: parent.right
              anchors.rightMargin: Style.space(8)
              anchors.verticalCenter: parent.verticalCenter
              spacing: Style.space(4)

              // Built-in versus installed. Which one a plugin is decides
              // whether the two buttons beside it do anything, so it is
              // worth stating rather than leaving to be inferred from
              // greyed-out icons.
              Text {
                anchors.verticalCenter: parent.verticalCenter
                text: row.modelData.firstParty ? "built-in" : (row.modelData.gitManaged ? "git" : "local")
                color: Color.muted
                font.family: root.contentFontFamily
                font.pixelSize: Style.font.caption
                rightPadding: Style.space(6)
              }

              PanelActionButton {
                anchors.verticalCenter: parent.verticalCenter
                visible: row.modelData.updatable
                iconText: row.rowBusy && root.busyKind === "update" ? "󰇘" : "󰑐"
                tooltipText: row.modelData.remote !== "" ? "Update from " + row.modelData.remote : "Update this checkout"
                foreground: root.contentForeground
                fontFamily: root.contentFontFamily
                enabled: !root.busy
                opacity: enabled ? 1 : 0.4
                onClicked: {
                  root.selectedIndex = row.index
                  root.startUpdate(row.modelData)
                }
              }

              PanelActionButton {
                anchors.verticalCenter: parent.verticalCenter
                visible: row.modelData.removable
                iconText: "󰩹"
                tooltipText: "Remove this plugin"
                foreground: root.contentForeground
                hoverColor: Color.urgent
                fontFamily: root.contentFontFamily
                enabled: !root.busy
                opacity: enabled ? 1 : 0.4
                onClicked: {
                  root.selectedIndex = row.index
                  root.askRemove(row.modelData)
                }
              }
            }
          }
        }

        // ---- Key hints. The panel is keyboard-first like every other one;
        //      saying so costs one line.
        Text {
          width: parent.width
          text: "↑↓ select   ⏎ update   ⌦ remove   a add   r refresh"
          color: Color.muted
          font.family: root.contentFontFamily
          font.pixelSize: Style.font.caption
          horizontalAlignment: Text.AlignHCenter
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
