import QtQuick
import Quickshell
import qs.Commons
import qs.Ui
import "Model.js" as Model

// One plugin in the list: what it is called, what it does, and the two things
// you can do to it.
//
// Four stacked lines: the name, then who wrote it with what it plugs into and
// what version is on disk, then what it actually does, then where its source
// lives. A list of names
// tells you what is installed but not what any of it is for, and the two
// facts you weigh before pulling or deleting something are the author and the
// version. When a manifest carries no description the row says so rather than
// leaving a blank, because "the author omitted it" and "the panel failed to
// read it" are different problems.
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
  signal enableRequested()

  readonly property string badge: Model.sourceBadge(row)
  readonly property bool hasUpdate: row ? row.behind === true : false

  // Installed but switched off. For a bar widget that means it has no place
  // in the bar yet, which is the state the grey dot is reporting.
  readonly property bool canEnable: Model.canEnable(row)

  readonly property string repoUrl: Model.rowRepoUrl(row)
  readonly property string repoLabel: Model.repoShortLabel(repoUrl)

  // Argv array through Omarchy's own launcher, so it opens in whichever
  // browser `omarchy default browser` selected — and the url has already been
  // checked to be https before it gets there.
  function openRepo() {
    if (repoUrl === "") return
    Quickshell.execDetached(["omarchy-launch-browser", repoUrl])
  }

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

    // The name gets the line to itself, so a long one elides against the row's
    // full width rather than against whatever the metadata beside it left over.
    Text {
      id: name
      width: parent.width
      text: root.row ? root.row.name : ""
      color: root.foreground
      font.family: root.fontFamily
      // A step above the metadata and the blurb under it, so the name reads as
      // the row's heading rather than one more line of text.
      font.pixelSize: Style.font.subtitle
      elide: Text.ElideRight
    }

    // Who wrote it, what it plugs into, and which version is on disk — the
    // three facts you check before updating or removing something, on one
    // glanceable line under the name.
    Text {
      width: parent.width
      text: {
        var meta = Model.metaLine(root.row)
        var version = Model.versionLabel(root.row)
        return version === "" ? meta : meta + "  ·  " + version
      }
      color: Color.muted
      font.family: root.fontFamily
      font.pixelSize: Style.font.caption
      elide: Text.ElideRight
    }

    Text {
      width: parent.width
      // The natural height wins when the text actually wraps, because a
      // computed two-line box that lands a fraction short fits only one line
      // and elides — the reserve is a floor, not a ceiling.
      height: Math.max(implicitHeight, root.descriptionHeight)
      text: Model.descriptionLine(root.row)
      // The panel foreground, dimmed a little — not Color.muted. The author
      // and kinds above are glanceable metadata and can afford to recede; the
      // description is the line you are actually here to read, and muted
      // renders too close to the background on darker themes.
      color: root.foreground
      opacity: Model.hasDescription(root.row) ? 0.85 : 0.45
      font.family: root.fontFamily
      font.pixelSize: Style.font.caption
      font.italic: !Model.hasDescription(root.row)
      wrapMode: Text.WordWrap
      maximumLineCount: 2
      elide: Text.ElideRight
      verticalAlignment: Text.AlignTop
    }

    // The source, one click away. Same link the browse cards carry, for the
    // same reason: reading what you are running is the whole defence, and it
    // should not stop being one click away the moment a plugin is installed.
    // Rows with no reachable origin — built-ins, a folder dropped in by hand —
    // simply do not draw it.
    Item {
      width: parent.width
      height: repoLink.implicitHeight
      visible: root.repoUrl !== ""

      Text {
        id: repoLink
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
        // it does not also select the row underneath.
        onClicked: root.openRepo()
      }
    }
  }

  Row {
    id: actions
    anchors.right: parent.right
    anchors.rightMargin: Style.space(8)
    anchors.verticalCenter: parent.verticalCenter
    spacing: Style.space(4)

    // Where the plugin came from, unless it has an update — then the update
    // takes the space, because it is the thing worth acting on.
    Text {
      anchors.verticalCenter: parent.verticalCenter
      visible: root.badge !== "" && !root.hasUpdate
      text: root.badge
      color: Color.muted
      font.family: root.fontFamily
      font.pixelSize: Style.font.caption
      rightPadding: Style.space(6)
    }

    Rectangle {
      anchors.verticalCenter: parent.verticalCenter
      visible: root.hasUpdate
      width: updateBadge.implicitWidth + Style.space(12)
      height: updateBadge.implicitHeight + Style.space(4)
      radius: height / 2
      color: Qt.rgba(Color.accent.r, Color.accent.g, Color.accent.b, 0.16)

      Text {
        id: updateBadge
        anchors.centerIn: parent
        text: "󰚰 " + Model.updateBadge(root.row)
        color: Color.accent
        font.family: root.fontFamily
        font.pixelSize: Style.font.caption
      }
    }

    Item {
      visible: root.hasUpdate
      width: Style.space(6)
      height: 1
    }

    // First in the row, because on a disabled plugin it is the only action
    // that changes anything you can see.
    PanelActionButton {
      anchors.verticalCenter: parent.verticalCenter
      visible: root.canEnable
      iconText: "󰐥"
      tooltipText: Model.needsPlacement(root.row)
        ? "Enable — choose where in the bar it goes"
        : "Enable this plugin"
      foreground: root.foreground
      fontFamily: root.fontFamily
      enabled: root.actionsEnabled
      opacity: enabled ? 1 : 0.4
      onClicked: root.enableRequested()
    }

    PanelActionButton {
      anchors.verticalCenter: parent.verticalCenter
      visible: root.row ? root.row.updatable === true : false
      iconText: "󰑐"
      tooltipText: {
        if (!root.row) return "Update this checkout"
        if (root.hasUpdate) return "Update available — pull from " + root.row.remote
        if (root.row.updateChecked === true) return "Up to date with " + root.row.remote
        return root.row.remote !== "" ? "Update from " + root.row.remote : "Update this checkout"
      }
      foreground: root.hasUpdate ? Color.accent : root.foreground
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
