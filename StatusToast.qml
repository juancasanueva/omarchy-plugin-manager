import QtQuick
import qs.Commons
import qs.Commons as OmarchyTheme
import "Model.js" as Model

// A notice that rises from the bottom of the panel, stays a few seconds and
// slides away: what just happened, without a line of text that lingers under
// the search box until something replaces it. Hovering holds it on screen and
// a click dismisses it. A new notice replaces the one showing and restarts
// its clock, so the same message posted twice is still seen twice.
Item {
  id: root

  property color foreground: OmarchyTheme.Color.foreground
  property color background: OmarchyTheme.Color.background
  property color accent: OmarchyTheme.Color.accent
  property color urgent: OmarchyTheme.Color.urgent
  property string fontFamily: Style.font.family
  property real maximumWidth: Style.space(420)

  // The surface's open state: a notice never waits behind a closed panel
  // to greet the next open.
  property bool active: true
  onActiveChanged: {
    if (active) return
    // A closed panel drops it at once rather than animating it away unseen.
    animated = false
    hide()
    animated = true
  }
  property bool animated: true

  property string text: ""
  property bool isError: false
  property bool shown: false
  readonly property bool hovered: hover.hovered

  // 0 is tucked below its slot and transparent, 1 is in place. The way in
  // overshoots a touch and settles; the way out just drops.
  property real reveal: shown ? 1 : 0
  Behavior on reveal {
    enabled: root.animated
    NumberAnimation {
      duration: root.shown ? 340 : 200
      easing.type: root.shown ? Easing.OutBack : Easing.InCubic
    }
  }

  function show(message, error) {
    if (!active) return
    text = message
    isError = error === true
    // A notice that lands on one already showing gives it a small nudge, so
    // the eye catches that the words changed.
    if (shown && reveal > 0.99) bump.restart()
    shown = true
    hideTimer.interval = Model.noticeDuration(isError)
    if (!hover.hovered) hideTimer.restart()
  }

  function hide() {
    hideTimer.stop()
    shown = false
  }

  visible: reveal > 0.001
  width: Math.min(maximumWidth, row.implicitWidth + Style.space(14) * 2)
  height: row.implicitHeight + Style.space(10) * 2
  opacity: Math.min(1, reveal)
  scale: 0.94 + 0.06 * Math.min(1, reveal)
  transform: Translate { y: (1 - root.reveal) * (root.height + Style.space(16)) }

  Timer {
    id: hideTimer
    repeat: false
    onTriggered: root.hide()
  }

  SequentialAnimation {
    id: bump
    NumberAnimation { target: card; property: "scale"; to: 1.04; duration: 90; easing.type: Easing.OutQuad }
    NumberAnimation { target: card; property: "scale"; to: 1; duration: 160; easing.type: Easing.OutBack }
  }

  Rectangle {
    id: card
    anchors.fill: parent
    radius: Style.cornerRadius
    color: root.background
    border.width: Math.max(1, Style.space(1))
    border.color: root.isError ? root.urgent : Util.alpha(root.foreground, 0.2)

    Row {
      id: row
      anchors.centerIn: parent
      spacing: Style.space(8)

      Text {
        id: icon
        textFormat: Text.PlainText
        anchors.verticalCenter: parent.verticalCenter
        text: root.isError ? "󰅚" : "󰄬"
        color: root.isError ? root.urgent : root.accent
        font.family: root.fontFamily
        font.pixelSize: Style.font.body
      }

      Text {
        id: label
        // Never rich text: AutoText would fetch what a crafted string points at.
        textFormat: Text.PlainText
        anchors.verticalCenter: parent.verticalCenter
        width: Math.min(implicitWidth, root.maximumWidth - Style.space(14) * 2 - icon.implicitWidth - row.spacing)
        text: root.text
        color: root.foreground
        font.family: root.fontFamily
        font.pixelSize: Style.font.caption
        wrapMode: Text.WordWrap
      }
    }
  }

  HoverHandler {
    id: hover
    onHoveredChanged: {
      if (hovered) hideTimer.stop()
      else if (root.shown) hideTimer.restart()
    }
  }

  TapHandler {
    onTapped: root.hide()
  }
}
