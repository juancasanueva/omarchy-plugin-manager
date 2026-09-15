import QtQuick
import Quickshell
import Quickshell.Io
import qs.Commons
import qs.Ui
import "PopupBridge.js" as PopupBridge

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
    if ("popupMoveOwner" in target) target.popupMoveOwner = root.popupMoveOwner
  }

  property var popupMoveOwner: null

  function setMoveOwner(owner) {
    popupMoveOwner = owner
    injectPanel()
  }

  function requestPopupMove(snapshot, fromSection, fromIndex, section, gap, origin) {
    return PopupBridge.requestMove(root, snapshot, fromSection, fromIndex, section, gap, origin)
  }

  function openPlacementView(origin, finalAttempt) {
    var target = panelLoader.item
    return !!target && typeof target.openPlacementView === "function"
      && target.openPlacementView(origin, finalAttempt) === true
  }

  function cancelPopupArrange() {
    PopupBridge.cancelArrange()
  }

  // Restore only when the local overlay is ready. Never recurse through the
  // host widget or open Expanded as a substitute.
  function openArrange() {
    var target = panelLoader.item
    return !!target && typeof target.openArrange === "function" && target.openArrange() === true
  }

  // ---- Shape contract for shell.summon/hide/toggle routing:
  //      Bar.findPanelWidget requires open/close/opened on the bar-widget
  //      root, so these delegate down to the loaded panel.
  readonly property bool opened: panelLoader.item ? panelLoader.item.opened === true : false
  // The loaded panel owns update evidence and the process that produces it.
  // Project its confirmed count instead of starting another check for the bar.
  readonly property int updateCount: panelLoader.item ? panelLoader.item.behindCount : 0

  // The output this bar instance draws on, so the expanded window can hand
  // back to the popup on the same monitor (see PopupBridge.js).
  readonly property string screenName: root.QsWindow.window && root.QsWindow.window.screen
    ? String(root.QsWindow.window.screen.name || "") : ""

  Component.onCompleted: PopupBridge.register(root)
  Component.onDestruction: PopupBridge.unregister(root)

  function open() {
    cancelPopupArrange()
    if (panelLoader.item) panelLoader.item.open()
  }

  function close() {
    cancelPopupArrange()
    if (panelLoader.item) panelLoader.item.close()
  }

  function togglePanel() {
    cancelPopupArrange()
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
    cancelPopupArrange()
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
    anchors.right: button.right
    anchors.rightMargin: Style.space(3)
    anchors.top: button.top
    anchors.topMargin: Style.space(5)
    width: Style.space(6)
    height: width
    radius: width / 2
    color: Color.accent
  }
}
