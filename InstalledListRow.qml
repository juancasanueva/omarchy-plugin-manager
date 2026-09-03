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
  // The GitHub star count from the marketplace listing, already formatted
  // ("120", "2k"); empty when the listing has none.
  property string stars: ""
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

    // The state mark, then the name and its pill; the star count keeps the
    // right edge. The name yields to all of them rather than pushing them off the
    // row.
    Item {
      id: nameLine
      width: parent.width
      height: Math.max(marks.implicitHeight, starsRow.implicitHeight)

      readonly property real pillsWidth: (stateMark.visible ? stateMark.width + marks.spacing : 0)
        + (verifiedPill.visible ? verifiedPill.width + marks.spacing : 0)
      readonly property real starsWidth: starsRow.visible ? starsRow.width + marks.spacing : 0

      Row {
        id: marks
        anchors.left: parent.left
        anchors.verticalCenter: parent.verticalCenter
        spacing: Style.space(8)

        // The state mark leads the name, as in a package list: a bold orange
        // arrow when an update is waiting, a green check when the checkout is
        // confirmed current. Fixed colours rather than the accent: the shell
        // has no warm or green token, and these are verdicts, not decoration.
        // Nothing when unchecked or not updatable — silence, not a guess.
        Text {
          id: stateMark
          // Never rich text: AutoText would fetch what a crafted string points at.
          textFormat: Text.PlainText
          anchors.verticalCenter: parent.verticalCenter
          readonly property bool behind: root.row ? root.row.behind === true : false
          readonly property bool current: Model.upToDate(root.row)
          visible: behind || current
          text: behind ? "󰜷" : "󰸞"
          color: behind ? "#f28c28" : "#5fb865"
          font.family: root.fontFamily
          font.pixelSize: Style.font.title
          font.bold: true
        }

        Text {
          id: name
          // Never rich text: AutoText would fetch what a crafted string points at.
          textFormat: Text.PlainText
          anchors.verticalCenter: parent.verticalCenter
          width: Math.min(implicitWidth, nameLine.width - nameLine.pillsWidth - nameLine.starsWidth)
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

      // The same gold star the Browse cards wear, with the listing's count.
      Row {
        id: starsRow
        anchors.right: parent.right
        anchors.verticalCenter: parent.verticalCenter
        visible: root.stars !== ""
        spacing: Style.space(2)

        Text {
          // Never rich text: AutoText would fetch what a crafted string points at.
          textFormat: Text.PlainText
          anchors.verticalCenter: parent.verticalCenter
          text: "󰓎"
          color: "#f5c518"
          font.family: root.fontFamily
          font.pixelSize: Style.font.body
        }

        Text {
          // Never rich text: AutoText would fetch what a crafted string points at.
          textFormat: Text.PlainText
          anchors.verticalCenter: parent.verticalCenter
          text: root.stars
          color: root.secondaryForeground
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
