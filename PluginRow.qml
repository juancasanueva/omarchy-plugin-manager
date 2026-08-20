import QtQuick
import qs.Commons
import qs.Ui
import "Model.js" as Model

// One plugin in the list: what it is called, what it does, and the two things
// you can do to it.
//
// The description is the point of the second line — a list of ids tells you
// what is installed but not what any of it is for. When a manifest carries no
// description the row says so rather than leaving a blank, because "the author
// omitted it" and "the panel failed to read it" are different problems.
//
// The row owns no state and runs no commands: it renders `row` and emits what
// the user asked for. Panel.qml decides what that means.
Rectangle {
  id: root

  property var row: null
  property bool selected: false
  property bool actionsEnabled: true
  property color foreground: Color.foreground
  property string fontFamily: Style.font.family

  signal clicked()
  signal updateRequested()
  signal removeRequested()

  readonly property string badge: Model.sourceBadge(row)

  // Two lines of description, always — reserved even when the text is short.
  // Descriptions run long enough that one elided line usually cuts off before
  // it has said anything, and a block that changes height per row makes the
  // list jump as you filter.
  readonly property real descriptionHeight: Math.ceil(descriptionMetrics.lineSpacing * 2)

  FontMetrics {
    id: descriptionMetrics
    font.family: root.fontFamily
    font.pixelSize: Style.font.caption
  }

  height: Math.round(details.implicitHeight + Style.space(16))
  radius: Style.cornerRadius
  color: selected ? Style.selectedFill : (mouse.containsMouse ? Style.hoverFill : "transparent")

  MouseArea {
    id: mouse
    anchors.fill: parent
    hoverEnabled: true
    onClicked: root.clicked()
  }

  // Enabled marker. A plugin the shell discovered but is not running looks
  // different from one that is, and the dot is the whole difference.
  Rectangle {
    id: stateDot
    anchors.left: parent.left
    anchors.leftMargin: Style.space(10)
    anchors.verticalCenter: parent.verticalCenter
    width: Style.space(6)
    height: width
    radius: width / 2
    color: root.row && root.row.enabled ? Color.accent : Color.muted
    opacity: root.row && root.row.enabled ? 1 : 0.5
  }

  Column {
    id: details
    anchors.left: stateDot.right
    anchors.leftMargin: Style.space(10)
    anchors.right: actions.left
    anchors.rightMargin: Style.space(10)
    anchors.verticalCenter: parent.verticalCenter
    spacing: Style.space(2)

    // Name carries the weight; the id and kinds trail it in the same line so
    // the description below gets the full width to itself.
    Row {
      width: parent.width
      spacing: Style.space(8)

      Text {
        id: name
        text: root.row ? root.row.name : ""
        color: root.foreground
        font.family: root.fontFamily
        font.pixelSize: Style.font.bodySmall
        elide: Text.ElideRight
        width: Math.min(implicitWidth, parent.width)
      }

      Text {
        text: Model.metaLine(root.row)
        color: Color.muted
        font.family: root.fontFamily
        font.pixelSize: Style.font.caption
        anchors.baseline: name.baseline
        elide: Text.ElideRight
        width: Math.max(0, parent.width - name.width - parent.spacing)
      }
    }

    Text {
      width: parent.width
      // The natural height wins when the text actually wraps, because a
      // computed two-line box that lands a fraction short fits only one line
      // and elides — the reserve is a floor, not a ceiling.
      height: Math.max(implicitHeight, root.descriptionHeight)
      text: Model.descriptionLine(root.row)
      color: Color.muted
      opacity: Model.hasDescription(root.row) ? 1 : 0.55
      font.family: root.fontFamily
      font.pixelSize: Style.font.caption
      font.italic: !Model.hasDescription(root.row)
      wrapMode: Text.WordWrap
      maximumLineCount: 2
      elide: Text.ElideRight
      verticalAlignment: Text.AlignTop
    }
  }

  Row {
    id: actions
    anchors.right: parent.right
    anchors.rightMargin: Style.space(8)
    anchors.verticalCenter: parent.verticalCenter
    spacing: Style.space(4)

    Text {
      anchors.verticalCenter: parent.verticalCenter
      visible: root.badge !== ""
      text: root.badge
      color: Color.muted
      font.family: root.fontFamily
      font.pixelSize: Style.font.caption
      rightPadding: Style.space(6)
    }

    PanelActionButton {
      anchors.verticalCenter: parent.verticalCenter
      visible: root.row ? root.row.updatable === true : false
      iconText: "󰑐"
      tooltipText: root.row && root.row.remote !== "" ? "Update from " + root.row.remote : "Update this checkout"
      foreground: root.foreground
      fontFamily: root.fontFamily
      enabled: root.actionsEnabled
      opacity: enabled ? 1 : 0.4
      onClicked: root.updateRequested()
    }

    PanelActionButton {
      anchors.verticalCenter: parent.verticalCenter
      visible: root.row ? root.row.removable === true : false
      iconText: "󰩹"
      tooltipText: "Remove this plugin"
      foreground: root.foreground
      hoverColor: Color.urgent
      fontFamily: root.fontFamily
      enabled: root.actionsEnabled
      opacity: enabled ? 1 : 0.4
      onClicked: root.removeRequested()
    }
  }
}
