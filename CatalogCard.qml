import QtQuick
import qs.Commons
import qs.Ui
import "Model.js" as Model

// One compact plugin summary in the Browse grid. Full metadata and navigation
// live in PluginDetails.qml so every card stays scannable.
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
  required property color secondaryForeground
  property string fontFamily: Style.font.family

  // Cleared by the panel the first time a WebP thumbnail fails to decode, so
  // the other seven hundred cards never attempt a format this Qt cannot read —
  // one warning in the log instead of one per visible card.
  property bool previewsEnabled: true

  signal detailsRequested()
  signal installRequested()
  signal previewUndecodable()

  readonly property string state_: Model.installState(entry)
  readonly property color accent: Model.accentColor(entry ? entry.accent : "")

  // Three lines of blurb, always reserved, so the cards stay on a grid instead
  // of ragging as you filter.
  readonly property int descriptionLines: 3
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

  readonly property string creatorText: entry ? entry.author : ""
  readonly property string versionText: Model.catalogVersionLabel(entry)
  // Distinct glyphs keep GitHub stars separate from anonymous Marketplace
  // hearts, and each carries its own colour so the two read apart at a glance:
  // a yellow star and a red heart. Fixed colours rather than theme tokens
  // because the shell has no yellow, and a heart drawn in the theme's urgent
  // tint would look like a warning. The glyphs are the Nerd Font's filled
  // Material icons rather than ★ and ♥: the mono font has no ★, so that one
  // fell through to a colour emoji, and its ♥ is drawn hollow.
  readonly property string starCountText: entry ? Model.starLabel(entry.stars) : ""
  readonly property string heartCountText: entry ? Model.starLabel(entry.marketplaceHearts) : ""
  readonly property color starColor: "#f5c518"
  readonly property color heartColor: "#e5484d"
  readonly property bool hasMetrics: starCountText !== "" || heartCountText !== ""
  readonly property bool hasCreator: creatorText !== ""
  readonly property bool hasVersionOrMetrics: versionText !== "" || hasMetrics
  readonly property string blockedText: state_ === "unavailable"
    ? Model.installBlockedReason(entry) : ""
  readonly property real contentPadding: Style.space(8)
  readonly property real contentFooterGap: Style.space(6)
  readonly property real footerMetadataHeight: Math.ceil(descriptionMetrics.lineSpacing * 2)
    + Style.space(3)
  readonly property real footerHeight: Math.max(footerMetadataHeight, actionRow.implicitHeight)
  readonly property real requiredHeight: topContent.implicitHeight + contentFooterGap
    + footerHeight + contentPadding * 2
  implicitHeight: requiredHeight

  radius: Style.cornerRadius
  color: selected ? Style.selectedFill : (mouse.containsMouse ? Style.hoverFill : Style.normalFill)
  border.width: selected ? Style.selectedBorderWidth : 0
  border.color: Style.selectedBorderColor

  MouseArea {
    id: mouse
    anchors.fill: parent
    hoverEnabled: true
    cursorShape: Qt.PointingHandCursor
    onClicked: root.detailsRequested()
  }

  Column {
    id: topContent
    anchors.left: parent.left
    anchors.right: parent.right
    anchors.top: parent.top
    anchors.leftMargin: root.contentPadding
    anchors.rightMargin: root.contentPadding
    anchors.topMargin: root.contentPadding
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

    // ---- Name.
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

    Text {
      textFormat: Text.PlainText
      width: parent.width
      visible: root.blockedText !== ""
      height: visible ? implicitHeight : 0
      text: visible ? "󰋼  " + root.blockedText : ""
      color: root.secondaryForeground
      font.family: root.fontFamily
      font.pixelSize: Style.font.caption
      elide: Text.ElideRight

      PanelToolTip {
        visible: parent.truncated && cardMouse.containsMouse
        text: root.blockedText
        fontFamily: root.fontFamily
      }

      MouseArea {
        id: cardMouse
        anchors.fill: parent
        hoverEnabled: true
        onClicked: root.detailsRequested()
      }
    }
  }

  // Every card gets the same visible height. This item absorbs only the space
  // left after top content and the footer's content-derived minimum sizes.
  Item {
    id: flexibleFooterGap
    anchors.left: parent.left
    anchors.right: parent.right
    anchors.top: topContent.bottom
    anchors.topMargin: root.contentFooterGap
    anchors.bottom: footer.top
  }

  // ---- Footer: creator, release version, both popularity metrics, and action.
  Item {
    id: footer
    anchors.left: parent.left
    anchors.right: parent.right
    anchors.bottom: parent.bottom
    anchors.leftMargin: root.contentPadding
    anchors.rightMargin: root.contentPadding
    anchors.bottomMargin: root.contentPadding
    height: root.footerHeight

    Column {
      id: metadata
      anchors.left: parent.left
      anchors.right: actionRow.left
      anchors.rightMargin: Style.space(6)
      anchors.verticalCenter: parent.verticalCenter
      visible: root.hasCreator || root.hasVersionOrMetrics
      height: visible
        ? creator.height + versionAndMetrics.height
          + (creator.visible && versionAndMetrics.visible ? spacing : 0)
        : 0
      spacing: Style.space(3)

      Text {
        id: creator
        // Never rich text: AutoText would fetch what a crafted string points at.
        textFormat: Text.PlainText
        width: parent.width
        visible: root.hasCreator
        height: visible ? implicitHeight : 0
        text: root.creatorText
        color: root.secondaryForeground
        font.family: root.fontFamily
        font.pixelSize: Style.font.caption
        elide: Text.ElideRight
      }

      Item {
        id: versionAndMetrics
        width: parent.width
        visible: root.hasVersionOrMetrics
        height: visible ? Math.max(versionLabel.implicitHeight, metricsLabel.implicitHeight) : 0

        // A long version yields space before either available metric is
        // elided or displaced. Every Text here is plain: AutoText would fetch
        // what a crafted string points at.
        Row {
          id: metricsLabel
          anchors.right: parent.right
          anchors.verticalCenter: parent.verticalCenter
          visible: root.hasMetrics
          spacing: Style.space(6)

          Row {
            visible: root.starCountText !== ""
            spacing: Style.space(2)

            Text {
              id: starIcon
              textFormat: Text.PlainText
              text: "󰓎"
              color: root.starColor
              font.family: root.fontFamily
              font.pixelSize: Style.font.title
            }

            Text {
              id: starCount
              anchors.baseline: starIcon.baseline
              textFormat: Text.PlainText
              text: root.starCountText
              color: root.secondaryForeground
              font.family: root.fontFamily
              font.pixelSize: Style.font.caption
            }
          }

          Row {
            visible: root.heartCountText !== ""
            spacing: Style.space(2)

            Text {
              id: heartIcon
              textFormat: Text.PlainText
              text: "󰋑"
              color: root.heartColor
              font.family: root.fontFamily
              font.pixelSize: Style.font.title
            }

            Text {
              id: heartCount
              anchors.baseline: heartIcon.baseline
              textFormat: Text.PlainText
              text: root.heartCountText
              color: root.secondaryForeground
              font.family: root.fontFamily
              font.pixelSize: Style.font.caption
            }
          }
        }

        Text {
          id: versionLabel
          // Never rich text: AutoText would fetch what a crafted string points at.
          textFormat: Text.PlainText
          anchors.left: parent.left
          anchors.verticalCenter: parent.verticalCenter
          readonly property real availableWidth: metricsLabel.visible
            ? Math.max(0, metricsLabel.x - Style.space(8))
            : parent.width
          width: Math.max(0, Math.min(implicitWidth, availableWidth))
          visible: root.versionText !== ""
          text: root.versionText
          color: root.secondaryForeground
          font.family: root.fontFamily
          font.pixelSize: Style.font.caption
          elide: Text.ElideRight
        }
      }
    }

    Row {
      id: actionRow
      anchors.right: parent.right
      // Centred on the version/metrics line rather than on the whole two-line
      // block, so the buttons sit beside the numbers instead of floating
      // between the author and the version. A card with no metadata at all
      // still centres them in the footer.
      y: metadata.visible
        ? metadata.y + versionAndMetrics.y + (versionAndMetrics.height - height) / 2
        : (parent.height - height) / 2
      spacing: Style.space(4)

      PanelActionButton {
        iconText: "󰋼"
        tooltipText: "View plugin details"
        foreground: root.foreground
        fontFamily: root.fontFamily
        bordered: true
        onClicked: root.detailsRequested()
      }

      PanelActionButton {
        id: installButton
        visible: root.state_ === "installable"
        iconText: "󰐕"
        tooltipText: "Install " + (root.entry ? root.entry.name : "")
        foreground: root.foreground
        fontFamily: root.fontFamily
        bordered: true
        enabled: root.actionsEnabled
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
