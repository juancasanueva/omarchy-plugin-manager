import QtQuick
import Quickshell.Io
import qs.Commons
import qs.Ui

// Bar entry for the plugin manager: one puzzle-piece icon that opens the
// panel listing every plugin the shell discovered.
//
// All the work happens in Panel.qml. This file owns the bar slot and the
// open/close contract the bar routes summon/hide/toggle through.
BarWidget {
  id: root
  moduleName: "io.github.juancasanueva.plugin-manager"

  function injectPanel() {
    var target = panelLoader.item
    if (!target) return
    if ("bar" in target) target.bar = root.bar
    if ("settings" in target) target.settings = root.settings
    if ("anchorItem" in target) target.anchorItem = button
    if ("hostWidget" in target) target.hostWidget = root
  }

  // ---- Shape contract for shell.summon/hide/toggle routing:
  //      Bar.findPanelWidget requires open/close/opened on the bar-widget
  //      root, so these delegate down to the loaded panel.
  readonly property bool opened: panelLoader.item ? panelLoader.item.opened === true : false
  // The loaded panel owns update evidence and the process that produces it.
  // Project its confirmed count instead of starting another check for the bar.
  readonly property int updateCount: panelLoader.item ? panelLoader.item.behindCount : 0

  function open() {
    if (panelLoader.item) panelLoader.item.open()
  }

  function close() {
    if (panelLoader.item) panelLoader.item.close()
  }

  function togglePanel() {
    if (panelLoader.item) panelLoader.item.toggle()
  }

  function refresh() {
    if (panelLoader.item && panelLoader.item.reload) panelLoader.item.reload()
  }

  // Forwarded so this widget can stand in for the panel as the bar's popout
  // identity: Bar.requestPopout prefers closeForPopoutSwitch over close, and
  // KeyboardPanel reads popoutSwitchClosing back off its owner.
  readonly property bool popoutSwitchClosing: panelLoader.item ? panelLoader.item.popoutSwitchClosing === true : false

  function closeForPopoutSwitch() {
    if (panelLoader.item) panelLoader.item.closeForPopoutSwitch()
  }

  implicitWidth: button.implicitWidth
  implicitHeight: button.implicitHeight

  onBarChanged: injectPanel()
  onSettingsChanged: injectPanel()

  Loader {
    id: panelLoader
    active: true
    source: Qt.resolvedUrl("Panel.qml")
    visible: false
    onLoaded: {
      root.injectPanel()
      Qt.callLater(root.injectPanel)
    }
  }

  IpcHandler {
    target: "io.github.juancasanueva.plugin-manager"

    function open(): void { root.open() }
    function close(): void { root.close() }
    function show(): void { root.open() }
    function hide(): void { root.close() }
    function toggle(): void { root.togglePanel() }
    function refresh(): void { root.broadcast("refresh") }
  }

  BarIconButton {
    id: button
    anchors.fill: parent
    bar: root.bar
    text: "󰐱"
    tooltipText: root.updateCount > 0 ? "Plugins - " + root.updateCount + " to update" : "Plugins"

    // Middle click re-reads the list without opening anything — the same
    // "refresh in place" gesture the weather and clock widgets use.
    onPressed: function(b) {
      if (b === Qt.MiddleButton) root.refresh()
      else root.togglePanel()
    }
  }

  Rectangle {
    id: updateBadge
    enabled: false
    visible: root.updateCount > 0
    z: button.z + 1
    anchors.top: button.top
    anchors.right: button.right
    anchors.topMargin: Style.space(1)
    anchors.rightMargin: Style.space(1)
    width: Math.max(Style.space(13), badgeLabel.implicitWidth + Style.space(6))
    height: Style.space(13)
    radius: height / 2
    // Omarchy has no warning palette role; amber distinguishes available
    // updates from the accent-colored puzzle icon on every theme.
    color: "#d6a43a"

    Text {
      id: badgeLabel
      anchors.centerIn: parent
      text: root.updateCount > 9 ? "9+" : String(root.updateCount)
      textFormat: Text.PlainText
      color: Color.background
      font.family: root.bar ? root.bar.fontFamily : Style.font.family
      font.pixelSize: Math.max(8, Style.font.caption - Style.space(2))
      font.bold: true
    }
  }
}
