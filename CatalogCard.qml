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

  // Cleared by the panel the first time a WebP thumbnail fails to decode, so
  // the other seven hundred cards never attempt a format this Qt cannot read —
  // one warning in the log instead of one per visible card.
  property bool previewsEnabled: true

  signal clicked()
  signal installRequested()
  signal repositoryNavigationRequested(string url)
  signal previewUndecodable()

  readonly property string state_: Model.installState(entry)
  readonly property color accent: Model.accentColor(entry ? entry.accent : "")

  // Five lines of blurb, always reserved, so the cards stay on a grid instead
  // of ragging as you filter.
  readonly property int descriptionLines: 5
  readonly property real descriptionHeight: Math.ceil(descriptionMetrics.lineSpacing * descriptionLines)

  // Sources are tried best-first: the repository's own preview.png, then the
  // registry's curated WebP thumbnail, then the accent tile. GridView recycles
  // delegates, so the walk restarts whenever a card is handed a new plugin.
  readonly property var previewSources: Model.previewCandidates(entry, previewsEnabled)
  property int previewIndex: 0
  readonly property string previewSource: previewIndex < previewSources.length
    ? previewSources[previewIndex]
    : ""

  onEntryChanged: previewIndex = 0

  readonly property string repoUrl: Model.browsableUrl(entry ? entry.repo : "")
  readonly property string repoLabel: Model.repoShortLabel(entry ? entry.repo : "")

  function openRepo() {
    if (repoUrl === "") return
    repositoryNavigationRequested(repoUrl)
  }

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
          // Never rich text: AutoText would fetch what a crafted string points at.
          textFormat: Text.PlainText
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
          source: root.previewSource
          onStatusChanged: {
            if (status !== Image.Error) return
            // A WebP failure is a fact about this Qt build, not about this
            // plugin, so it is reported up once and every card stops trying.
            if (root.previewSource === (root.entry ? root.entry.thumbnail : "")) root.previewUndecodable()
            root.previewIndex++
          }
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

      // Already yours. Top-left, opposite verified, so a card can carry both
      // without the two ever fighting for the same corner — and on the preview
      // rather than in the footer, because whether you already have it is the
      // first thing you want to know about a card, not the last.
      Rectangle {
        anchors.top: parent.top
        anchors.left: parent.left
        anchors.margins: Style.space(6)
        visible: root.state_ === "installed"
        width: installedLabel.implicitWidth + Style.space(10)
        height: installedLabel.implicitHeight + Style.space(4)
        radius: height / 2
        color: Qt.rgba(Color.background.r, Color.background.g, Color.background.b, 0.75)

        Text {
          id: installedLabel
          // Never rich text: AutoText would fetch what a crafted string points at.
          textFormat: Text.PlainText
          anchors.centerIn: parent
          // A ringed check, not the bare one verified wears: two identical
          // glyphs on the same preview would read as one badge repeated.
          text: "󰗠 installed"
          color: Model.installedTint(Color.background)
          font.family: root.fontFamily
          font.pixelSize: Style.font.caption
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

    // ---- Name and author.
    Text {
      // Never rich text: AutoText would fetch what a crafted string points at.
      textFormat: Text.PlainText
      width: parent.width
      text: root.entry ? root.entry.name : ""
      color: root.foreground
      font.family: root.fontFamily
      font.pixelSize: Style.font.bodySmall
      elide: Text.ElideRight
    }

    Text {
      // Never rich text: AutoText would fetch what a crafted string points at.
      textFormat: Text.PlainText
      width: parent.width
      // A floor, not a fixed height: a computed box that lands a fraction
      // short of its line count fits one line fewer and elides.
      height: Math.max(implicitHeight, root.descriptionHeight)
      text: root.entry ? root.entry.description : ""
      color: root.foreground
      opacity: 0.8
      font.family: root.fontFamily
      font.pixelSize: Style.font.caption
      wrapMode: Text.WordWrap
      maximumLineCount: root.descriptionLines
      elide: Text.ElideRight
      verticalAlignment: Text.AlignTop
    }

    // ---- The repository, one click away. Reading the source before you run
    //      it is the whole defence here, so the way to it is on the card
    //      rather than buried behind a detail view.
    Item {
      width: parent.width
      height: repoLink.implicitHeight
      visible: root.repoUrl !== ""

      Text {
        id: repoLink
        // Never rich text: AutoText would fetch what a crafted string points at.
        textFormat: Text.PlainText
        width: parent.width
        text: "󰊤  " + root.repoLabel
        color: repoMouse.containsMouse ? Color.accent : Color.muted
        font.family: root.fontFamily
        font.pixelSize: Style.font.caption
        font.underline: repoMouse.containsMouse
        elide: Text.ElideRight
      }

      MouseArea {
        id: repoMouse
        anchors.fill: parent
        hoverEnabled: true
        cursorShape: Qt.PointingHandCursor
        // Swallowed rather than propagated: clicking the link opens the repo,
        // it does not also select the card underneath.
        onClicked: root.openRepo()
      }
    }

    // ---- Footer: who wrote it, how popular it is, and the one action.
    Item {
      width: parent.width
      height: Math.max(meta.implicitHeight, installButton.height)

      Text {
        id: meta
        // Never rich text: AutoText would fetch what a crafted string points at.
        textFormat: Text.PlainText
        anchors.left: parent.left
        // The button is the only thing on the right, so when it is gone the
        // author and star count get the width back rather than eliding
        // against a hidden item.
        anchors.right: installButton.visible ? installButton.left : parent.right
        anchors.rightMargin: installButton.visible ? Style.space(6) : 0
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
