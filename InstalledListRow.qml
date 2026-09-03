import QtQuick
import qs.Commons
import qs.Ui
import "Model.js" as Model

// One installed plugin in the expanded panel's list. This row sits beside a
// details pane that carries every action and every fact, so it keeps only
// what identifies the plugin at a glance: the name, the marketplace pill and
// the description; the state bar on the left already says on or off. The popup's PluginRow does the same job
// with the actions inline; this one deliberately does not.
Rectangle {
  id: root

  property var row: null
  property bool selected: false
  property bool verified: false
  property bool showSeparator: false
  property color foreground: Color.foreground
  required property color secondaryForeground
  property string fontFamily: Style.font.family

  signal clicked()

  height: Math.round(details.implicitHeight + Style.space(16))
  radius: Style.cornerRadius
  color: selected ? Style.selectedFill : (mouse.containsMouse ? Style.hoverFill : "transparent")

  MouseArea {
    id: mouse
    anchors.fill: parent
    hoverEnabled: true
    onClicked: root.clicked()
  }

  // The same full-height state rule as the popup row: the pill says the state
  // in words, the rule lets the eye scan a column of rows without reading.
  Rectangle {
    id: stateBar
    anchors.left: parent.left
    anchors.leftMargin: Style.space(10)
    anchors.top: parent.top
    anchors.bottom: parent.bottom
    anchors.topMargin: Style.space(6)
    anchors.bottomMargin: Style.space(6)
    width: Style.space(5)
    radius: width / 2
    color: root.row && root.row.enabled ? Color.accent : Color.muted
    opacity: root.row && root.row.enabled ? 1 : 0.5
  }

  Column {
    id: details
    anchors.left: stateBar.right
    anchors.leftMargin: Style.space(12)
    anchors.right: parent.right
    anchors.rightMargin: Style.space(10)
    anchors.verticalCenter: parent.verticalCenter
    spacing: Style.space(3)

    // Name first, then the pill; the name yields to the pill rather than
    // pushing it off the row.
    Row {
      id: nameLine
      width: parent.width
      spacing: Style.space(8)

      readonly property real pillsWidth: verifiedPill.visible ? verifiedPill.width + spacing : 0

      Text {
        id: name
        // Never rich text: AutoText would fetch what a crafted string points at.
        textFormat: Text.PlainText
        anchors.verticalCenter: parent.verticalCenter
        width: Math.min(implicitWidth, nameLine.width - nameLine.pillsWidth)
        text: root.row ? root.row.name : ""
        color: root.foreground
        font.family: root.fontFamily
        font.pixelSize: Style.font.subtitle
        font.bold: true
        elide: Text.ElideRight
      }

      Rectangle {
        id: verifiedPill
        anchors.verticalCenter: parent.verticalCenter
        visible: root.verified
        width: verifiedLabel.implicitWidth + Style.space(10)
        height: verifiedLabel.implicitHeight + Style.space(4)
        radius: height / 2
        color: Qt.rgba(Color.accent.r, Color.accent.g, Color.accent.b, 0.16)

        Text {
          id: verifiedLabel
          // Never rich text: AutoText would fetch what a crafted string points at.
          textFormat: Text.PlainText
          anchors.centerIn: parent
          text: "󰄬 verified"
          color: Color.accent
          font.family: root.fontFamily
          font.pixelSize: Style.font.caption
        }
      }

    }

    // Two lines at most: the pane on the right shows the whole description,
    // so the row only needs enough to tell one plugin from the next.
    Text {
      // Never rich text: AutoText would fetch what a crafted string points at.
      textFormat: Text.PlainText
      width: parent.width
      text: Model.descriptionLine(root.row)
      color: Model.hasDescription(root.row) ? root.foreground : root.secondaryForeground
      opacity: Model.hasDescription(root.row) ? 0.85 : 1
      font.family: root.fontFamily
      font.pixelSize: Style.font.caption
      wrapMode: Text.WordWrap
      maximumLineCount: 2
      elide: Text.ElideRight
    }
  }

  Rectangle {
    anchors.left: details.left
    anchors.right: parent.right
    anchors.rightMargin: Style.space(8)
    anchors.bottom: parent.bottom
    height: 1
    visible: root.showSeparator
    color: Color.muted
    opacity: 0.35
  }
}
