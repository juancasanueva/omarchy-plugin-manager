import QtQuick
import qs.Commons
import qs.Ui

// A modal that asks which one, rather than whether.
//
// ConfirmDialog covers yes/no, and most of this panel's questions are that
// shape. Placing a bar widget is not: there is no default section that is
// right more often than the others, and picking one silently would drop the
// widget somewhere the user then has to go find. So the question is asked with
// its answers on the table.
//
// The card, scrim, and keyboard idiom are ConfirmDialog's on purpose — this is
// the same kind of interruption and should not look like a different one.
Item {
  id: root

  property bool opened: false
  property string message: ""
  property string cancelText: "Cancel"

  // [{ value, label }] — Cancel is appended by the dialog, never by callers.
  property var choices: []

  property color background: Color.background
  property color foreground: Color.foreground
  property color scrim: Util.alpha(Color.background, 0.7)
  property color selectedBackground: Util.alpha(Color.foreground, 0.08)
  property color selectedText: Color.accent
  property string fontFamily: Style.font.family
  property int cornerRadius: Style.cornerRadius

  property int selectedIndex: 0

  signal canceled()
  signal chosen(string value)

  // Cancel lives at the end so the arrow keys walk the real answers first —
  // and so index 0 is a safe place for the selection to start.
  readonly property int cancelIndex: choices.length

  function pick(index) {
    if (index === cancelIndex) root.canceled()
    else if (index >= 0 && index < choices.length) root.chosen(String(choices[index].value))
  }

  // Reopened on a different plugin, so the previous answer must not carry
  // over — the second widget would otherwise land wherever the first went.
  onOpenedChanged: if (opened) selectedIndex = 0

  function handleKey(event) {
    if (!root.opened) return false

    var count = cancelIndex + 1

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
      width: Math.min(parent.width - Style.space(32), Style.space(370))
      // Grows with the wrapped message, so a long plugin name pushes the card
      // taller rather than crowding the buttons.
      height: card.contentTopInset + card.contentBottomInset
        + messageText.implicitHeight + Style.space(20) + Style.space(34)
      anchors.centerIn: parent
      color: root.background
      borderSpec: Border.flat(root.selectedText, Style.normalBorderWidth)
      padding: Style.space(18)
      radius: root.cornerRadius

      // Swallows clicks that land on the card so they do not reach the scrim
      // behind it and dismiss the question.
      MouseArea { anchors.fill: parent; onClicked: {} }

      Item {
        anchors.fill: parent
        anchors.topMargin: card.contentTopInset
        anchors.rightMargin: card.contentRightInset
        anchors.bottomMargin: card.contentBottomInset
        anchors.leftMargin: card.contentLeftInset

        Text {
          id: messageText
          // Never rich text: AutoText would fetch what a crafted string points at.
          textFormat: Text.PlainText
          anchors.left: parent.left
          anchors.right: parent.right
          anchors.top: parent.top
          text: root.message
          color: root.foreground
          font.family: root.fontFamily
          font.pixelSize: Style.font.title
          wrapMode: Text.WordWrap
        }

        Row {
          anchors.right: parent.right
          anchors.bottom: parent.bottom
          spacing: Style.space(10)

          Repeater {
            // The answers, then Cancel. One Repeater rather than two rows
            // keeps a single selection index addressing every button.
            model: {
              var labels = []
              for (var i = 0; i < root.choices.length; i++) labels.push(root.choices[i].label)
              labels.push(root.cancelText)
              return labels
            }

            BorderSurface {
              required property int index
              required property string modelData

              readonly property bool selected: root.selectedIndex === index

              // Four buttons where ConfirmDialog fits two, so they are sized
              // to their text with a floor rather than to a fixed width.
              width: Math.max(Style.space(64), label.implicitWidth + Style.space(20))
              height: Style.space(34)
              color: selected ? root.selectedBackground : "transparent"
              borderSpec: Border.flat(
                selected ? root.selectedText : Util.alpha(root.foreground, 0.38),
                Style.normalBorderWidth)
              radius: 0

              Text {
                id: label
                // Never rich text: AutoText would fetch what a crafted string points at.
                textFormat: Text.PlainText
                anchors.centerIn: parent
                text: modelData
                color: selected ? root.selectedText : root.foreground
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
