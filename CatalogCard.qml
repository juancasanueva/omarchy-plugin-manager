import QtQuick
import qs.Commons
import qs.Ui
import "Model.js" as Model

// One plugin in the browse grid: a preview, what it is, and one button.
//
// The preview is the registry's WebP thumbnail, which Qt can only decode when
// qt6-imageformats is installed. Rather than making the whole tab depend on an
// optional system package, the card falls back to the accent-and-initials tile
// the registry already ships for listings with no screenshot — so the grid
// looks deliberate either way, and installing the package simply turns the
// photographs on.
Rectangle {
  id: root

  property var entry: null
  property bool selected: false
  property bool actionsEnabled: true
  property color foreground: Color.foreground
  property string fontFamily: Style.font.family

  // Cleared by the panel the first time a thumbnail fails to decode, so the
  // other seven hundred cards never attempt a format this Qt cannot read —
  // one warning in the log instead of one per visible card.
  property bool previewsEnabled: true

  signal clicked()
  signal installRequested()
  signal previewUndecodable()

  readonly property string state_: Model.installState(entry)
  readonly property color accent: Model.accentColor(entry ? entry.accent : "")

  radius: Style.cornerRadius
  color: selected ? Style.selectedFill : (mouse.containsMouse ? Style.hoverFill : Style.normalFill)
  border.width: selected ? Style.selectedBorderWidth : 0
  border.color: Style.selectedBorderColor

  MouseArea {
    id: mouse
    anchors.fill: parent
    hoverEnabled: true
    onClicked: root.clicked()
  }

  Column {
    anchors.fill: parent
    anchors.margins: Style.space(8)
    spacing: Style.space(6)

    // ---- Preview.
    Item {
      id: preview
      width: parent.width
      height: Math.round(width * 9 / 16)

      Rectangle {
        anchors.fill: parent
        radius: Style.cornerRadius
        clip: true
        // The tile is the fallback and the backdrop both: it sits under the
        // image so a half-loaded photo never flashes the panel background.
        gradient: Gradient {
          GradientStop { position: 0.0; color: Qt.rgba(root.accent.r, root.accent.g, root.accent.b, 0.38) }
          GradientStop { position: 1.0; color: Qt.rgba(root.accent.r, root.accent.g, root.accent.b, 0.14) }
        }

        Text {
          anchors.centerIn: parent
          visible: thumbnail.status !== Image.Ready
          text: root.entry ? root.entry.initials : ""
          color: root.accent
          font.family: root.fontFamily
          font.pixelSize: Style.font.displayLarge
          font.bold: true
        }

        Image {
          id: thumbnail
          anchors.fill: parent
          source: root.previewsEnabled && root.entry && root.entry.thumbnail !== "" ? root.entry.thumbnail : ""
          onStatusChanged: if (status === Image.Error) root.previewUndecodable()
          // Loading 700 thumbnails eagerly would hammer the network from
          // inside the shell process; the grid only ever asks for the cards
          // it is actually showing.
          asynchronous: true
          cache: true
          fillMode: Image.PreserveAspectCrop
          sourceSize.width: 720
          visible: status === Image.Ready
        }
      }

      // Verified is the registry's own security-baseline review. It is worth
      // one glyph and nothing more: it is a signal, not a guarantee, and the
      // install dialog says so in words.
      Rectangle {
        anchors.top: parent.top
        anchors.right: parent.right
        anchors.margins: Style.space(6)
        visible: root.entry ? root.entry.verified === true : false
        width: verifiedLabel.implicitWidth + Style.space(10)
        height: verifiedLabel.implicitHeight + Style.space(4)
        radius: height / 2
        color: Qt.rgba(Color.background.r, Color.background.g, Color.background.b, 0.75)

        Text {
          id: verifiedLabel
          anchors.centerIn: parent
          text: "󰄬 verified"
          color: Color.accent
          font.family: root.fontFamily
          font.pixelSize: Style.font.caption
        }
      }
    }

    // ---- Name and author.
    Text {
      width: parent.width
      text: root.entry ? root.entry.name : ""
      color: root.foreground
      font.family: root.fontFamily
      font.pixelSize: Style.font.bodySmall
      elide: Text.ElideRight
    }

    Text {
      width: parent.width
      // A floor, not a fixed height: a computed two-line box that lands a
      // fraction short fits one line and elides.
      height: Math.max(implicitHeight, Math.ceil(descriptionMetrics.lineSpacing * 2))
      text: root.entry ? root.entry.description : ""
      color: root.foreground
      opacity: 0.8
      font.family: root.fontFamily
      font.pixelSize: Style.font.caption
      wrapMode: Text.WordWrap
      maximumLineCount: 2
      elide: Text.ElideRight
      verticalAlignment: Text.AlignTop
    }

    // ---- Footer: who wrote it, how popular it is, and the one action.
    Item {
      width: parent.width
      height: Math.max(meta.implicitHeight, installButton.height)

      Text {
        id: meta
        anchors.left: parent.left
        anchors.right: installButton.left
        anchors.rightMargin: Style.space(6)
        anchors.verticalCenter: parent.verticalCenter
        text: {
          if (!root.entry) return ""
          var parts = []
          if (root.entry.author !== "") parts.push(root.entry.author)
          if (root.entry.stars > 0) parts.push("★ " + Model.starLabel(root.entry.stars))
          return parts.join("   ")
        }
        color: Color.muted
        font.family: root.fontFamily
        font.pixelSize: Style.font.caption
        elide: Text.ElideRight
      }

      Text {
        anchors.right: parent.right
        anchors.verticalCenter: parent.verticalCenter
        visible: root.state_ === "installed"
        text: "installed"
        color: Color.muted
        font.family: root.fontFamily
        font.pixelSize: Style.font.caption
      }

      PanelActionButton {
        id: installButton
        anchors.right: parent.right
        anchors.verticalCenter: parent.verticalCenter
        visible: root.state_ !== "installed"
        iconText: root.state_ === "installable" ? "󰐕" : "󰋼"
        tooltipText: root.state_ === "installable"
          ? "Install " + (root.entry ? root.entry.name : "")
          : Model.installBlockedReason(root.entry)
        foreground: root.foreground
        fontFamily: root.fontFamily
        bordered: root.state_ === "installable"
        enabled: root.actionsEnabled && root.state_ === "installable"
        opacity: enabled ? 1 : 0.45
        onClicked: root.installRequested()
      }
    }
  }

  FontMetrics {
    id: descriptionMetrics
    font.family: root.fontFamily
    font.pixelSize: Style.font.caption
  }
}
