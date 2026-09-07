import QtQuick
import qs.Commons
import qs.Ui

// ChoiceDialog's modal idiom, with yes/no answers and an optional action that
// leaves the question pending. Indices 0/1 retain the host confirmation API.
Item {
  id: root

  property bool opened: false
  property string message: ""
  property string cancelText: "Cancel"
  property string confirmText: "Confirm"
  property string actionText: ""
  property bool actionVisible: false
  property int selectedIndex: 1

  property color background: Color.background
  property color foreground: Color.foreground
  property color scrim: Util.alpha(Color.background, 0.7)
  property color selectedBackground: Util.alpha(Color.foreground, 0.08)
  property color selectedText: Color.accent
  property string fontFamily: Style.font.family
  property int cornerRadius: Style.cornerRadius

  signal canceled()
  signal confirmed()
  signal actionRequested()

  function pick(index) {
    if (!root.opened) return
    if (index === 0) root.canceled()
    else if (index === 1) root.confirmed()
    else if (index === 2 && root.actionVisible) root.actionRequested()
  }

  function resetSelection() {
    root.selectedIndex = 1
  }

  onOpenedChanged: if (opened) root.resetSelection()
  onActionVisibleChanged: if (!actionVisible && selectedIndex === 2) root.resetSelection()

  function handleKey(event) {
    if (!root.opened) return false
    var count = root.actionVisible ? 3 : 2
    if (event.key === Qt.Key_Escape) {
      root.canceled()
      return true
    } else if (event.key === Qt.Key_Left || event.key === Qt.Key_Backtab) {
      root.selectedIndex = (root.selectedIndex + count - 1) % count
      return true
    } else if (event.key === Qt.Key_Right || event.key === Qt.Key_Tab) {
      root.selectedIndex = (root.selectedIndex + 1) % count
      return true
    } else if (event.key === Qt.Key_Return || event.key === Qt.Key_Enter) {
      root.pick(root.selectedIndex)
      return true
    }
    return false
  }

  visible: opened

  Rectangle {
    anchors.fill: parent
    color: root.scrim
    MouseArea { anchors.fill: parent; onClicked: root.canceled() }

    BorderSurface {
      id: card
      anchors.centerIn: parent
      width: Math.min(parent.width - Style.space(32), Style.space(370))
      height: content.implicitHeight + contentTopInset + contentBottomInset
      color: root.background
      borderSpec: Border.flat(root.selectedText, Style.normalBorderWidth)
      padding: Style.space(18)
      radius: root.cornerRadius

      // Card clicks must not bubble through to the dismissing scrim.
      MouseArea { anchors.fill: parent; onClicked: {} }

      Column {
        id: content
        x: card.contentLeftInset
        y: card.contentTopInset
        width: card.width - card.contentLeftInset - card.contentRightInset
        spacing: Style.space(20)

        Flickable {
          id: messageScroll
          width: parent.width
          contentWidth: width
          contentHeight: messageText.implicitHeight
          // Reserve the answer/action rows before allocating message space.
          height: Math.min(contentHeight, Math.max(0, root.height - Style.space(32)
            - card.contentTopInset - card.contentBottomInset - buttons.height - content.spacing))
          clip: true
          flickableDirection: Flickable.VerticalFlick
          boundsBehavior: Flickable.StopAtBounds
          onVisibleChanged: if (visible) contentY = 0

          Text {
            id: messageText
            width: messageScroll.width
            text: root.message
            textFormat: Text.PlainText
            wrapMode: Text.WrapAtWordBoundaryOrAnywhere
            color: root.foreground
            font.family: root.fontFamily
            font.pixelSize: Style.font.title
          }
        }

        Item {
          id: buttons
          width: parent.width
          height: Style.space(root.actionVisible ? 78 : 34)
          readonly property real answerWidth: Math.min(Style.space(88), (width - Style.space(10)) / 2)

          Repeater {
            model: [root.cancelText, root.confirmText, root.actionText]

            BorderSurface {
              required property int index
              required property string modelData
              readonly property bool selected: root.selectedIndex === index
              readonly property bool urgent: index === 1
              readonly property color highlight: urgent ? Color.urgent : root.selectedText

              // The action occupies its own bounded row above the two answers.
              visible: index !== 2 || root.actionVisible
              width: index === 2 ? Math.min(buttons.width, Style.space(140)) : buttons.answerWidth
              height: Style.space(34)
              x: buttons.width - width - (index === 0 ? width + Style.space(10) : 0)
              y: index === 2 ? 0 : buttons.height - height
              color: !selected ? "transparent"
                : urgent ? Util.alpha(Color.urgent, 0.22) : root.selectedBackground
              borderSpec: Border.flat(selected ? highlight
                : urgent ? Util.alpha(Color.urgent, 0.56) : Util.alpha(root.foreground, 0.38), Style.normalBorderWidth)
              radius: 0

              Text {
                anchors.fill: parent
                anchors.margins: Style.space(6)
                horizontalAlignment: Text.AlignHCenter
                verticalAlignment: Text.AlignVCenter
                text: modelData
                textFormat: Text.PlainText
                elide: Text.ElideRight
                color: selected ? highlight : root.foreground
                font.family: root.fontFamily
                font.pixelSize: Style.font.caption
              }

              MouseArea {
                anchors.fill: parent
                hoverEnabled: true
                cursorShape: Qt.PointingHandCursor
                onEntered: root.selectedIndex = index
                onClicked: root.pick(index)
              }
            }
          }
        }
      }
    }
  }
}
