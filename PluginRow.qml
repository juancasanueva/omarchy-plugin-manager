import QtQuick
import Quickshell
import qs.Commons
import qs.Ui
import "Model.js" as Model

// One plugin in the list: what it is called, what it does, and the two things
// you can do to it.
//
// Four stacked lines: the name, then what it actually does, then who wrote it
// with what it plugs into and what version is on disk, then where its source
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
  property bool showSeparator: false
  property color foreground: Color.foreground
  property string fontFamily: Style.font.family

  signal clicked()
  signal updateRequested()
  signal removeRequested()
  signal enableRequested()
  signal disableRequested()

  readonly property string badge: Model.sourceBadge(row)
  readonly property bool hasUpdate: row ? row.behind === true : false

  // Installed but switched off. For a bar widget that means it has no place
  // in the bar yet, which is the state the grey dot is reporting.
  readonly property bool canEnable: Model.canEnable(row)

  // Off the bar, still on disk. The inverse of enable, and the only way back
  // from one that turned out to be the wrong idea.
  readonly property bool canDisable: Model.canDisable(row)

  // The switch is drawn for every row, but it only moves for a row the shell
  // will actually act on. A plugin that is on and cannot be switched off still
  // gets to say so — a row with no control at all reads as a rendering gap
  // rather than as a deliberate "this one stays on".
  readonly property bool canToggle: canEnable || canDisable

  readonly property string repoUrl: Model.rowRepoUrl(row)
  readonly property string repoLabel: Model.repoShortLabel(repoUrl)

  // Argv array through Omarchy's own launcher, so it opens in whichever
  // browser `omarchy default browser` selected — and the url has already been
  // checked to be https before it gets there.
  function openRepo() {
    if (repoUrl === "") return
    Quickshell.execDetached(["omarchy-launch-browser", repoUrl])
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
  // different from one that is, and this bar is the whole difference.
  //
  // Full height rather than a dot beside the name: the row is four lines tall
  // now, and a mark that only meets the first of them reads as belonging to
  // the title instead of to the plugin.
  Rectangle {
    id: stateBar
    anchors.left: parent.left
    anchors.leftMargin: Style.space(10)
    anchors.top: parent.top
    anchors.bottom: parent.bottom
    anchors.topMargin: Style.space(6)
    anchors.bottomMargin: Style.space(6)
    width: Style.space(3)
    radius: width / 2
    color: root.row && root.row.enabled ? Color.accent : Color.muted
    opacity: root.row && root.row.enabled ? 1 : 0.5
  }

  Column {
    id: details
    anchors.left: stateBar.right
    // Wider than the gap the dot needed: a 3px rule sitting flush against the
    // text would read as a border on the row rather than as a state marker.
    anchors.leftMargin: Style.space(12)
    anchors.right: actions.left
    anchors.rightMargin: Style.space(10)
    anchors.verticalCenter: parent.verticalCenter
    spacing: Style.space(2)

    // The name gets the line to itself, so a long one elides against the row's
    // full width rather than against whatever the metadata beside it left over.
    Text {
      id: name
      // Never rich text: AutoText would fetch what a crafted string points at.
      textFormat: Text.PlainText
      width: parent.width
      text: root.row ? root.row.name : ""
      color: root.foreground
      font.family: root.fontFamily
      // A step above the metadata and the blurb under it, so the name reads as
      // the row's heading rather than one more line of text.
      font.pixelSize: Style.font.subtitle
      font.bold: true
      elide: Text.ElideRight
    }

    // As many lines as the description actually needs — no reserve underneath
    // it and no ceiling over it.
    //
    // This used to be pinned at two lines, which was wrong in both directions:
    // a one-line blurb paid for a blank line it never used, and anything
    // longer was cut off mid-sentence with no way to read the rest. A
    // description is the line you opened this list to read, so a row that
    // hides half of it has failed at the one job it had. Rows now differ in
    // height, which is the price, and it is the cheaper mistake: an uneven
    // list is something you can see past, a truncated sentence is not.
    Text {
      // Never rich text: AutoText would fetch what a crafted string points at.
      textFormat: Text.PlainText
      width: parent.width
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
      verticalAlignment: Text.AlignTop
    }

    // Who wrote it, what it plugs into, and which version is on disk — the
    // three facts you check before updating or removing something, on one
    // glanceable line below the description.
    Text {
      // Never rich text: AutoText would fetch what a crafted string points at.
      textFormat: Text.PlainText
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

    // Where the plugin came from, but only when nothing else already said it.
    //
    // A row that draws its repository link underneath has already told you it
    // is a git checkout, and repeating that in a badge is one more thing to
    // read for no fact gained. What the badge is actually for is the row with
    // no link: a checkout whose origin has gone missing and a folder somebody
    // dropped in by hand both lose the link and the update button, and without
    // this they would render identically despite being different things.
    //
    // It also yields to an update chip, because that is the thing worth acting
    // on and the space is the same.
    Text {
      // Never rich text: AutoText would fetch what a crafted string points at.
      textFormat: Text.PlainText
      anchors.verticalCenter: parent.verticalCenter
      visible: root.badge !== "" && !root.hasUpdate && root.repoUrl === ""
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
        // Never rich text: AutoText would fetch what a crafted string points at.
        textFormat: Text.PlainText
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

    // On or off, in one control. Two icon buttons that swapped places with each
    // other made the reader decode a glyph to learn the current state and then
    // decode it again to work out what clicking would do; a switch shows the
    // state and the action at once, and it is the control the rest of the shell
    // already uses for on and off.
    //
    // It sits where those two buttons sat rather than at the far edge: update
    // and remove keep their positions, and the destructive one keeps the corner
    // it has always had.
    //
    // `checked` is bound straight to the row, never flipped locally. Enabling a
    // bar widget asks where it goes first, and a knob that threw itself across
    // before that question was answered would be reporting a state the shell
    // has not reached — and would stay wrong if the question was cancelled.
    ToggleSwitch {
      id: enabledSwitch
      anchors.verticalCenter: parent.verticalCenter
      visible: root.row !== null
      checked: root.row ? root.row.enabled === true : false
      // Two different reasons a click does nothing, kept apart because the kit
      // keeps them apart. `interactive` is the structural one — this row has no
      // off — and it dims. `busy` is the passing one, a command already in
      // flight: it swallows the click but leaves hover and the tooltip alone,
      // so the switch does not blink every time a background refresh runs.
      interactive: root.canToggle
      busy: !root.actionsEnabled
      opacity: root.canToggle ? 1 : 0.4
      foreground: root.foreground
      onToggled: root.canDisable ? root.disableRequested() : root.enableRequested()

      PanelToolTip {
        visible: enabledSwitch.containsMouse
        text: {
          if (root.canDisable) {
            return Model.needsPlacement(root.row)
              ? "Disable — take it out of the bar, keep it installed"
              : "Disable this plugin, keep it installed"
          }
          return Model.needsPlacement(root.row)
            ? "Enable — choose where in the bar it goes"
            : "Enable this plugin"
        }
        fontFamily: root.fontFamily
      }
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
