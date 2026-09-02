import QtQuick
import qs.Commons
import qs.Ui
import "Model.js" as Model

// A focused, keyboard-complete view of one Marketplace listing. Cards stay
// scannable; this surface owns the full description, provenance, limitations,
// and the trusted actions that can leave the panel or install code.
Item {
  id: root

  property bool opened: false
  property var entry: null
  property color background: Color.background
  property color foreground: Color.foreground
  required property color secondaryForeground
  property color scrim: Util.alpha(Color.background, 0.7)
  property string fontFamily: Style.font.family
  property int selectedAction: 0

  // Cleared by the panel the first time a WebP thumbnail fails to decode, so
  // details and the grid share one verdict about this Qt build.
  property bool previewsEnabled: true

  signal closed()
  signal installRequested()
  signal previewUndecodable()
  signal githubNavigationRequested(var candidates, string fallbackUrl)
  signal repositoryNavigationRequested(string url)

  readonly property string repoUrl: Model.browsableUrl(entry ? entry.repo : "")

  // Same best-first walk the Browse card uses: the repository's preview.png,
  // then the registry's WebP thumbnail, then the accent-and-initials tile. The
  // walk restarts whenever the panel hands this surface another plugin.
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

  readonly property var fieldRows: {
    var rows = []
    if (!entry) return rows
    if (entry.author !== "") rows.push({ label: "Author", value: entry.author })
    if (versionText !== "") rows.push({ label: "Version", value: versionText })
    if (entry.categoryPresent === true && entry.category !== "")
      rows.push({ label: "Category", value: entry.category })
    if (entry.kind !== "") rows.push({ label: "Kind", value: entry.kind })
    if (entry.license !== "") rows.push({ label: "License", value: entry.license })
    if (entry.verified === true) rows.push({ label: "Marketplace review", value: "Verified" })
    if (Model.starLabel(entry.stars) !== "")
      rows.push({ label: "GitHub stars", value: Model.starLabel(entry.stars) })
    if (Model.starLabel(entry.marketplaceHearts) !== "")
      rows.push({ label: "Marketplace hearts", value: Model.starLabel(entry.marketplaceHearts) })
    rows.push({ label: "Availability", value: stateText })
    if (needsPlacement)
      rows.push({ label: "Placement", value: "Choose a bar section before installation" })
    return rows
  }

  readonly property var actions: {
    var values = []
    if (repoUrl !== "") values.push({ kind: "repository", label: "Open repository" })
    if (versionFallbackUrl !== "") values.push({ kind: "release", label: "Open " + versionText + " on GitHub" })
    if (entry && entry.installable) values.push({ kind: "install", label: "Install " + entry.name })
    values.push({ kind: "close", label: "Close details" })
    return values
  }

  function activate(index) {
    if (index < 0 || index >= actions.length) return
    var kind = actions[index].kind
    if (kind === "repository") repositoryNavigationRequested(repoUrl)
    else if (kind === "release")
      githubNavigationRequested(versionReleaseCandidates, versionFallbackUrl)
    else if (kind === "install") installRequested()
    else closed()
  }

  function handleKey(event) {
    if (!opened) return false
    if (event.key === Qt.Key_Escape) {
      closed()
      return true
    }

    var backwards = event.key === Qt.Key_Up || event.key === Qt.Key_Left
      || event.key === Qt.Key_Backtab
    var forwards = event.key === Qt.Key_Down || event.key === Qt.Key_Right
      || event.key === Qt.Key_Tab
    if (backwards || forwards) {
      var delta = backwards ? -1 : 1
      selectedAction = (selectedAction + actions.length + delta) % actions.length
      ensureActionVisible(actionRepeater.itemAt(selectedAction))
      return true
    }
    if (event.key === Qt.Key_Return || event.key === Qt.Key_Enter) {
      activate(selectedAction)
      return true
    }
    return false
  }

  function ensureActionVisible(item) {
    if (!item) return
    var top = item.mapToItem(detailsContent, 0, 0).y
    var bottom = top + item.height
    if (top < detailsScroll.contentY) detailsScroll.contentY = top
    else if (bottom > detailsScroll.contentY + detailsScroll.height)
      detailsScroll.contentY = bottom - detailsScroll.height
  }

  onEntryChanged: previewIndex = 0
  onOpenedChanged: if (opened) { selectedAction = 0; detailsScroll.contentY = 0 }
  onActionsChanged: if (selectedAction >= actions.length) selectedAction = Math.max(0, actions.length - 1)
  visible: opened

  Rectangle {
    anchors.fill: parent
    color: root.scrim

    MouseArea { anchors.fill: parent; onClicked: root.closed() }

    BorderSurface {
      id: card
      width: Math.min(parent.width - Style.space(32), Style.space(520))
      height: Math.min(parent.height - Style.space(32), Style.space(600))
      anchors.centerIn: parent
      color: root.background
      borderSpec: Border.flat(Color.accent, Style.normalBorderWidth)
      padding: Style.space(18)
      radius: Style.cornerRadius

      MouseArea { anchors.fill: parent; onClicked: {} }

      Item {
        anchors.fill: parent
        anchors.topMargin: card.contentTopInset
        anchors.rightMargin: card.contentRightInset
        anchors.bottomMargin: card.contentBottomInset
        anchors.leftMargin: card.contentLeftInset

        Item {
          id: detailsHeader
          anchors.left: parent.left
          anchors.right: parent.right
          anchors.top: parent.top
          height: Math.max(nameLabel.implicitHeight + idLabel.implicitHeight + Style.space(2), closeButton.height)

          Column {
            anchors.left: parent.left
            anchors.right: closeButton.left
            anchors.rightMargin: Style.space(10)
            anchors.verticalCenter: parent.verticalCenter
            spacing: Style.space(2)

            Text {
              id: nameLabel
              textFormat: Text.PlainText
              width: parent.width
              text: root.entry ? root.entry.name : ""
              color: root.foreground
              font.family: root.fontFamily
              font.pixelSize: Style.font.title
              font.bold: true
              elide: Text.ElideRight
            }

            Text {
              id: idLabel
              textFormat: Text.PlainText
              width: parent.width
              text: root.entry ? root.entry.id : ""
              color: root.secondaryForeground
              font.family: root.fontFamily
              font.pixelSize: Style.font.caption
              elide: Text.ElideRight
            }
          }

          PanelActionButton {
            id: closeButton
            anchors.right: parent.right
            anchors.verticalCenter: parent.verticalCenter
            iconText: "󰅖"
            tooltipText: "Close details"
            foreground: root.foreground
            fontFamily: root.fontFamily
            onClicked: root.closed()
          }
        }

        Flickable {
          id: detailsScroll
          anchors.left: parent.left
          anchors.right: parent.right
          anchors.top: detailsHeader.bottom
          anchors.topMargin: Style.space(12)
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

            // ---- Preview. It leads the body because the picture is what the
            // card promised: opening details should confirm the listing you
            // clicked before it starts explaining it.
            Rectangle {
              id: detailsPreview
              width: parent.width
              // The frame takes the picture's own shape once it is known, so
              // nothing is ever cropped away: the card crops to stay uniform
              // in a grid, but details exist to show the whole thing. Capped
              // at square so a tall image cannot push the text off screen —
              // it still fits inside, just with gutters. 16:9 is only the
              // placeholder tile while nothing has loaded.
              height: detailsThumbnail.status === Image.Ready && detailsThumbnail.implicitWidth > 0
                ? Math.min(width, Math.round(width * detailsThumbnail.implicitHeight / detailsThumbnail.implicitWidth))
                : Math.round(width * 9 / 16)
              radius: Style.cornerRadius
              clip: true
              // The accent tile is only the placeholder. Once the picture is
              // up, a fitted image narrower than the frame leaves gutters,
              // and those read as part of the panel — not as a coloured
              // mat around the photo — only if they are the panel's colour.
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
                  // A WebP failure is a fact about this Qt build, not about
                  // this plugin, so it is reported up once and the whole panel
                  // stops asking for that format.
                  if (root.previewSource === (root.entry ? root.entry.thumbnail : "")) root.previewUndecodable()
                  root.previewIndex++
                }
                asynchronous: true
                cache: true
                fillMode: Image.PreserveAspectFit
                sourceSize.width: 720
                visible: status === Image.Ready
              }
            }

            Text {
              textFormat: Text.PlainText
              width: parent.width
              visible: root.entry && root.entry.description !== ""
              height: visible ? implicitHeight : 0
              text: visible ? root.entry.description : ""
              color: root.foreground
              font.family: root.fontFamily
              font.pixelSize: Style.font.bodySmall
              wrapMode: Text.WordWrap
            }

            Column {
              width: parent.width
              spacing: Style.space(5)

              Repeater {
                model: root.fieldRows

                Item {
                  required property var modelData
                  width: detailsContent.width
                  height: Math.max(fieldLabel.implicitHeight, fieldValue.implicitHeight)

                  Text {
                    id: fieldLabel
                    textFormat: Text.PlainText
                    anchors.left: parent.left
                    anchors.top: parent.top
                    width: Style.space(130)
                    text: modelData.label
                    color: root.secondaryForeground
                    font.family: root.fontFamily
                    font.pixelSize: Style.font.caption
                    font.bold: true
                  }

                  Text {
                    id: fieldValue
                    textFormat: Text.PlainText
                    anchors.left: fieldLabel.right
                    anchors.right: parent.right
                    anchors.top: parent.top
                    text: modelData.value
                    color: root.foreground
                    font.family: root.fontFamily
                    font.pixelSize: Style.font.caption
                    wrapMode: Text.WordWrap
                  }
                }
              }
            }

            Rectangle {
              width: parent.width
              visible: root.blockedReason !== ""
              height: visible ? blockedText.implicitHeight + Style.space(12) : 0
              radius: Style.cornerRadius
              color: Util.alpha(Color.urgent, 0.10)

              Text {
                id: blockedText
                textFormat: Text.PlainText
                anchors.fill: parent
                anchors.margins: Style.space(6)
                text: root.blockedReason
                color: root.foreground
                font.family: root.fontFamily
                font.pixelSize: Style.font.caption
                wrapMode: Text.WordWrap
              }
            }

            Text {
              textFormat: Text.PlainText
              width: parent.width
              text: "Installation warning: plugins run unsandboxed inside omarchy-shell. Review the repository before installing."
              color: root.secondaryForeground
              font.family: root.fontFamily
              font.pixelSize: Style.font.caption
              wrapMode: Text.WordWrap
            }

            Column {
              width: parent.width
              spacing: Style.space(6)

              Repeater {
                id: actionRepeater
                model: root.actions

                BorderSurface {
                  required property int index
                  required property var modelData

                  readonly property bool selected: root.selectedAction === index
                  width: detailsContent.width
                  height: Style.space(34)
                  color: selected ? Util.alpha(root.foreground, 0.08) : "transparent"
                  borderSpec: Border.flat(
                    selected ? Color.accent : Util.alpha(root.foreground, 0.38),
                    Style.normalBorderWidth)
                  radius: 0

                  Text {
                    textFormat: Text.PlainText
                    anchors.centerIn: parent
                    text: modelData.label
                    color: selected ? Color.accent : root.foreground
                    font.family: root.fontFamily
                    font.pixelSize: Style.font.caption
                  }

                  MouseArea {
                    anchors.fill: parent
                    hoverEnabled: true
                    cursorShape: Qt.PointingHandCursor
                    onEntered: root.selectedAction = index
                    onClicked: root.activate(index)
                  }
                }
              }
            }
          }
        }
      }
    }
  }
}
