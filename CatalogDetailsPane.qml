import QtQuick
import qs.Commons
import qs.Ui
import "Model.js" as Model

// One Marketplace listing on the full width of the expanded panel: the cover
// on the left, the listing on the right, and a way back at the top. This is
// the third face of the content flip — the grid turns over into it and back —
// so it is a pane, not a dialog: no scrim, no focus trap, the panel's own keys
// keep working around it.
Item {
  id: root

  property var entry: null
  // The two pill facts, held here rather than read off the pills: a child of
  // a hidden item reports itself hidden, so a row that waited for its pills
  // to be visible before showing itself would never show at all.
  readonly property bool verified: entry ? entry.verified === true : false
  readonly property bool installed: entry ? entry.installed === true : false
  property bool previewsEnabled: true
  property bool actionsEnabled: true
  property color background: Color.menu.background
  property color foreground: Color.foreground
  required property color secondaryForeground
  property string fontFamily: Style.font.family

  signal backRequested()
  signal installRequested()
  signal previewUndecodable()
  signal githubNavigationRequested(var candidates, string fallbackUrl)
  signal repositoryNavigationRequested(string url)

  readonly property string repoUrl: Model.browsableUrl(entry ? entry.repo : "")

  // Same best-first walk the card and the popup's details use: the
  // repository's preview.png, then the registry's WebP thumbnail, then the
  // accent-and-initials tile. Restarts whenever the panel hands over another
  // listing.
  readonly property color accent: Model.accentColor(entry ? entry.accent : "")
  readonly property var previewSources: Model.previewCandidates(entry, previewsEnabled)
  property int previewIndex: 0
  readonly property string previewSource: previewIndex < previewSources.length
    ? previewSources[previewIndex]
    : ""

  readonly property string versionText: Model.catalogVersionLabel(entry)
  readonly property var versionReleaseCandidates: Model.catalogVersionReleaseCandidates(entry)
  readonly property string versionFallbackUrl: Model.catalogVersionFallbackUrl(entry)
  readonly property string stateText: !entry ? ""
    : entry.installed ? "Installed"
    : entry.installable ? "Available to install"
    : "Not installable here"
  readonly property string blockedReason: entry && !entry.installed && !entry.installable
    ? Model.installBlockedReason(entry) : ""
  readonly property bool needsPlacement: Model.catalogNeedsPlacement(entry)
  readonly property var fieldRows: Model.catalogDetailFields(entry, stateText, needsPlacement)

  onEntryChanged: {
    previewIndex = 0
    detailsScroll.contentY = 0
  }

  // The way back, where a reader expects it. Esc does the same.
  Button {
    id: backButton
    anchors.left: parent.left
    anchors.top: parent.top
    iconText: "󰁍"
    text: "Back"
    tooltipText: "Back to the catalog"
    bordered: true
    foreground: root.foreground
    fontFamily: root.fontFamily
    fontSize: Style.font.caption
    onClicked: root.backRequested()
  }

  Item {
    id: body
    anchors.left: parent.left
    anchors.right: parent.right
    anchors.top: backButton.bottom
    anchors.topMargin: Style.space(14)
    anchors.bottom: parent.bottom

    // ---- Cover. Two fifths of the width, the picture fitted inside it —
    //      never cropped, this page exists to show the whole thing — and
    //      capped to the height the column has, so a tall image sits in
    //      gutters rather than pushing the listing off the pane.
    Item {
      id: coverColumn
      anchors.left: parent.left
      anchors.top: parent.top
      anchors.bottom: parent.bottom
      width: Math.round(parent.width * 0.4)

      Rectangle {
        id: detailsPreview
        anchors.left: parent.left
        anchors.right: parent.right
        anchors.top: parent.top
        height: detailsThumbnail.status === Image.Ready && detailsThumbnail.implicitWidth > 0
          ? Math.min(coverColumn.height, Math.round(width * detailsThumbnail.implicitHeight / detailsThumbnail.implicitWidth))
          : Math.round(width * 9 / 16)
        radius: Style.cornerRadius
        clip: true
        // The accent tile is only the placeholder; once the picture is up,
        // its gutters must be the panel's colour to read as part of it.
        color: root.background
        gradient: detailsThumbnail.status === Image.Ready ? null : previewTileGradient

        Gradient {
          id: previewTileGradient
          GradientStop { position: 0.0; color: Qt.rgba(root.accent.r, root.accent.g, root.accent.b, 0.38) }
          GradientStop { position: 1.0; color: Qt.rgba(root.accent.r, root.accent.g, root.accent.b, 0.14) }
        }

        Text {
          // Never rich text: AutoText would fetch what a crafted string points at.
          textFormat: Text.PlainText
          anchors.centerIn: parent
          visible: detailsThumbnail.status !== Image.Ready
          text: root.entry ? root.entry.initials : ""
          color: root.accent
          font.family: root.fontFamily
          font.pixelSize: Style.font.displayLarge
          font.bold: true
        }

        Image {
          id: detailsThumbnail
          anchors.fill: parent
          source: root.previewSource
          onStatusChanged: {
            if (status !== Image.Error) return
            // A WebP failure is a fact about this Qt build, not about this
            // plugin: reported once so the whole panel stops asking.
            if (root.previewSource === (root.entry ? root.entry.thumbnail : "")) root.previewUndecodable()
            root.previewIndex++
          }
          asynchronous: true
          cache: true
          fillMode: Image.PreserveAspectFit
          sourceSize.width: 960
          visible: status === Image.Ready
        }
      }
    }

    // ---- The listing. Scrolls on its own, so a long description never
    //      pushes the actions out of reach.
    Flickable {
      id: detailsScroll
      anchors.left: coverColumn.right
      anchors.leftMargin: Style.space(24)
      anchors.right: parent.right
      anchors.top: parent.top
      anchors.bottom: parent.bottom
      contentWidth: width
      contentHeight: detailsContent.implicitHeight
      clip: true
      boundsBehavior: Flickable.StopAtBounds
      interactive: contentHeight > height

      Column {
        id: detailsContent
        width: detailsScroll.width
        spacing: Style.space(12)

        // The name keeps the left of the line; the popularity counts keep the
        // right, the same gold star and red heart the cards wear, so the
        // page opens with the two numbers the grid already taught the eye.
        Item {
          id: titleLine
          width: parent.width
          height: Math.max(nameLabel.implicitHeight, metricsRow.implicitHeight)

          Text {
            id: nameLabel
            // Never rich text: AutoText would fetch what a crafted string points at.
            textFormat: Text.PlainText
            anchors.left: parent.left
            anchors.right: metricsRow.left
            anchors.rightMargin: Style.space(12)
            anchors.verticalCenter: parent.verticalCenter
            text: root.entry ? root.entry.name : ""
            color: root.foreground
            font.family: root.fontFamily
            font.pixelSize: Style.font.display
            font.bold: true
            wrapMode: Text.WordWrap
          }

          Row {
            id: metricsRow
            anchors.right: parent.right
            anchors.verticalCenter: parent.verticalCenter
            spacing: Style.space(10)

            readonly property string starText: Model.starLabel(root.entry ? root.entry.stars : null)
            readonly property string heartText: Model.starLabel(root.entry ? root.entry.marketplaceHearts : null)

            Row {
              visible: metricsRow.starText !== ""
              spacing: Style.space(3)

              Text {
                id: starIcon
                // Never rich text: AutoText would fetch what a crafted string points at.
                textFormat: Text.PlainText
                text: "󰓎"
                color: "#f5c518"
                font.family: root.fontFamily
                font.pixelSize: Style.font.display
              }

              Text {
                id: starCount
                // Never rich text: AutoText would fetch what a crafted string points at.
                textFormat: Text.PlainText
                anchors.baseline: starIcon.baseline
                text: metricsRow.starText
                color: root.secondaryForeground
                font.family: root.fontFamily
                font.pixelSize: Style.font.title
              }
            }

            Row {
              visible: metricsRow.heartText !== ""
              spacing: Style.space(3)

              Text {
                id: heartIcon
                // Never rich text: AutoText would fetch what a crafted string points at.
                textFormat: Text.PlainText
                text: "󰋑"
                color: "#e5484d"
                font.family: root.fontFamily
                font.pixelSize: Style.font.display
              }

              Text {
                id: heartCount
                // Never rich text: AutoText would fetch what a crafted string points at.
                textFormat: Text.PlainText
                anchors.baseline: heartIcon.baseline
                text: metricsRow.heartText
                color: root.secondaryForeground
                font.family: root.fontFamily
                font.pixelSize: Style.font.title
              }
            }
          }
        }

        Text {
          // Never rich text: AutoText would fetch what a crafted string points at.
          textFormat: Text.PlainText
          width: parent.width
          visible: text !== ""
          text: Model.catalogMetaLine(root.entry)
          color: root.secondaryForeground
          font.family: root.fontFamily
          font.pixelSize: Style.font.bodySmall
          elide: Text.ElideRight
        }

        // The pills the cards wear, side by side: the registry's review as a
        // signal, not a guarantee, and whether this listing is already on
        // this machine — in the same green the grid uses for that.
        Row {
          id: pillRow
          spacing: Style.space(6)
          visible: root.verified || root.installed

          Rectangle {
            id: verifiedPill
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

          Rectangle {
            id: installedPill
            readonly property color tint: Model.installedTint(root.background)
            visible: root.installed
            width: installedLabel.implicitWidth + Style.space(10)
            height: installedLabel.implicitHeight + Style.space(4)
            radius: height / 2
            color: Qt.rgba(tint.r, tint.g, tint.b, 0.16)

            Text {
              id: installedLabel
              // Never rich text: AutoText would fetch what a crafted string points at.
              textFormat: Text.PlainText
              anchors.centerIn: parent
              text: "󰗠 installed"
              color: installedPill.tint
              font.family: root.fontFamily
              font.pixelSize: Style.font.caption
            }
          }
        }

        Text {
          // Never rich text: AutoText would fetch what a crafted string points at.
          textFormat: Text.PlainText
          width: parent.width
          visible: root.entry && root.entry.description !== ""
          text: visible ? root.entry.description : ""
          color: root.foreground
          font.family: root.fontFamily
          font.pixelSize: Style.font.bodySmall
          wrapMode: Text.WordWrap
        }

        PanelSeparator { foreground: root.foreground }

        Column {
          width: parent.width
          spacing: Style.space(5)

          Repeater {
            model: root.fieldRows

            Item {
              id: field
              required property var modelData
              width: detailsContent.width
              height: Math.max(fieldLabel.implicitHeight, fieldValue.implicitHeight)

              Text {
                id: fieldLabel
                // Never rich text: AutoText would fetch what a crafted string points at.
                textFormat: Text.PlainText
                anchors.left: parent.left
                anchors.top: parent.top
                width: Style.space(130)
                text: field.modelData.label
                color: root.secondaryForeground
                font.family: root.fontFamily
                font.pixelSize: Style.font.caption
                font.bold: true
              }

              Text {
                id: fieldValue
                // Never rich text: AutoText would fetch what a crafted string points at.
                textFormat: Text.PlainText
                anchors.left: fieldLabel.right
                anchors.right: parent.right
                anchors.top: parent.top
                text: field.modelData.value
                color: root.foreground
                font.family: root.fontFamily
                font.pixelSize: Style.font.caption
                wrapMode: Text.WordWrap
              }
            }
          }
        }

        // Why the install button is missing, when it is: the listing's own
        // note, in the colour that means "not from here".
        Text {
          // Never rich text: AutoText would fetch what a crafted string points at.
          textFormat: Text.PlainText
          width: parent.width
          visible: root.blockedReason !== ""
          text: root.blockedReason
          color: Color.urgent
          font.family: root.fontFamily
          font.pixelSize: Style.font.caption
          wrapMode: Text.WordWrap
        }

        Text {
          // Never rich text: AutoText would fetch what a crafted string points at.
          textFormat: Text.PlainText
          width: parent.width
          text: "Installation warning: plugins run unsandboxed inside omarchy-shell. Review the repository before installing."
          color: root.secondaryForeground
          font.family: root.fontFamily
          font.pixelSize: Style.font.caption
          wrapMode: Text.WordWrap
        }

        // The trusted actions, side by side: install, and the two links out.
        Flow {
          id: actionRow
          width: parent.width
          spacing: Style.space(6)

          Button {
            id: installButton
            visible: root.entry ? root.entry.installable === true : false
            text: "Install"
            iconText: "󰐕"
            tooltipText: root.entry ? "Install " + root.entry.name : ""
            bordered: true
            foreground: root.foreground
            fontFamily: root.fontFamily
            fontSize: Style.font.caption
            enabled: root.actionsEnabled
            opacity: enabled ? 1 : 0.4
            onClicked: root.installRequested()
          }

          Button {
            id: repositoryButton
            visible: root.repoUrl !== ""
            text: "Open repository"
            iconText: "󰊤"
            tooltipText: root.repoUrl
            bordered: true
            foreground: root.foreground
            fontFamily: root.fontFamily
            fontSize: Style.font.caption
            onClicked: root.repositoryNavigationRequested(root.repoUrl)
          }

          Button {
            id: releaseButton
            visible: root.versionFallbackUrl !== ""
            text: "Open " + root.versionText + " on GitHub"
            iconText: "󰓹"
            tooltipText: "Open the Release page for this version"
            bordered: true
            foreground: root.foreground
            fontFamily: root.fontFamily
            fontSize: Style.font.caption
            onClicked: root.githubNavigationRequested(root.versionReleaseCandidates, root.versionFallbackUrl)
          }
        }
      }
    }
  }
}
