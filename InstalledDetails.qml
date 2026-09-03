import QtQuick
import Quickshell
import qs.Commons
import qs.Ui
import "Model.js" as Model

// The right-hand pane of the expanded Installed tab: everything the row knows
// about one plugin, laid out with room to breathe, and the same four actions
// the row offers as labelled buttons. The row stays the compact form of this;
// nothing here is decided differently from PluginRow, it is only said in
// full — the gates on update, enable, disable and remove are the row's gates.
Item {
  id: root

  property var row: null
  property bool verified: false
  property bool actionsEnabled: true
  property bool updateEnabled: true
  property bool updating: false
  property color foreground: Color.foreground
  required property color secondaryForeground
  property string fontFamily: Style.font.family

  signal updateRequested()
  signal removeRequested()
  signal enableRequested()
  signal disableRequested()
  signal repositoryNavigationRequested(string url)

  readonly property bool hasUpdate: row ? row.behind === true : false
  readonly property bool upToDate: Model.upToDate(row)
  readonly property bool canEnable: Model.canEnable(row)
  readonly property bool canDisable: Model.canDisable(row)
  readonly property string repoUrl: Model.rowRepoUrl(row)
  readonly property string repoLabel: Model.repoShortLabel(repoUrl)
  readonly property string versionText: Model.versionLabel(row)

  readonly property string updateText: {
    if (!row || !row.updatable) return ""
    if (hasUpdate) return "Update available"
    if (row.updateChecked === true) return "Up to date"
    return "Not checked"
  }

  // Label/value pairs, in the order a reader wants them: who, which version,
  // what it plugs into, where it came from, then the two things that change.
  readonly property var fieldRows: {
    var rows = []
    if (!row) return rows
    var author = Model.authorLabel(row)
    if (author !== "") rows.push({ label: "Author", value: author })
    if (versionText !== "") rows.push({ label: "Version", value: versionText })
    var kinds = Model.kindsLabel(row.kinds)
    if (kinds !== "") rows.push({ label: "Kinds", value: kinds })
    rows.push({ label: "Source", value: row.group === "built-in" ? "Built-in" : "Installed" })
    if (repoLabel !== "") rows.push({ label: "Repository", value: repoLabel, link: repoUrl })
    if (updateText !== "") rows.push({ label: "Update", value: updateText })
    rows.push({ label: "Status", value: row.enabled ? "Enabled" : "Disabled" })
    return rows
  }

  // Nothing selected: say so quietly, where the details would be.
  Text {
    // Never rich text: AutoText would fetch what a crafted string points at.
    textFormat: Text.PlainText
    anchors.centerIn: parent
    width: parent.width - Style.space(40)
    visible: !root.row
    text: "Select a plugin to see its details."
    color: root.secondaryForeground
    font.family: root.fontFamily
    font.pixelSize: Style.font.body
    wrapMode: Text.WordWrap
    horizontalAlignment: Text.AlignHCenter
  }

  Flickable {
    id: detailsScroll
    anchors.fill: parent
    visible: root.row !== null
    contentWidth: width
    contentHeight: detailsColumn.implicitHeight
    clip: true
    boundsBehavior: Flickable.StopAtBounds
    interactive: contentHeight > height

    Column {
      id: detailsColumn
      width: detailsScroll.width
      spacing: Style.space(14)

      Row {
        id: nameLine
        width: parent.width
        spacing: Style.space(8)

        Text {
          id: name
          // Never rich text: AutoText would fetch what a crafted string points at.
          textFormat: Text.PlainText
          anchors.verticalCenter: parent.verticalCenter
          width: Math.min(implicitWidth, nameLine.width - (verifiedPill.visible ? verifiedPill.width + nameLine.spacing : 0))
          text: root.row ? root.row.name : ""
          color: root.foreground
          font.family: root.fontFamily
          font.pixelSize: Style.font.heading
          font.bold: true
          elide: Text.ElideRight
        }

        // Same pill as the row: the marketplace's word, shown as a signal,
        // not a guarantee.
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

      Text {
        // Never rich text: AutoText would fetch what a crafted string points at.
        textFormat: Text.PlainText
        width: parent.width
        visible: text !== ""
        text: Model.descriptionLine(root.row)
        color: root.foreground
        font.family: root.fontFamily
        font.pixelSize: Style.font.body
        wrapMode: Text.WordWrap
      }

      PanelSeparator { foreground: root.foreground }

      Column {
        width: parent.width
        spacing: Style.space(6)

        Repeater {
          model: root.fieldRows

          Item {
            id: field
            required property var modelData

            width: parent.width
            height: Math.max(fieldLabel.implicitHeight, fieldValue.implicitHeight)

            readonly property bool isLink: modelData.link !== undefined && modelData.link !== ""

            Text {
              id: fieldLabel
              // Never rich text: AutoText would fetch what a crafted string points at.
              textFormat: Text.PlainText
              anchors.left: parent.left
              anchors.top: parent.top
              width: Style.space(110)
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
              color: field.isLink && linkMouse.containsMouse ? Color.accent : root.foreground
              font.family: root.fontFamily
              font.pixelSize: Style.font.caption
              font.underline: field.isLink && linkMouse.containsMouse
              wrapMode: Text.WrapAnywhere

              MouseArea {
                id: linkMouse
                anchors.fill: parent
                enabled: field.isLink
                hoverEnabled: field.isLink
                cursorShape: field.isLink ? Qt.PointingHandCursor : Qt.ArrowCursor
                onClicked: root.repositoryNavigationRequested(field.modelData.link)
              }
            }
          }
        }
      }

      PanelSeparator { foreground: root.foreground }

      // The row's four actions, written out. Each keeps the row's own gate:
      // disable is a direct action, enable may first ask where, update is
      // dead on an up-to-date checkout, and remove exists only for what is
      // ours to delete. Side by side, wrapping when the pane runs out of
      // width: a toolbar reads faster than a stack.
      Flow {
        id: actionRow
        width: parent.width
        spacing: Style.space(6)

        Button {
          visible: root.canEnable || root.canDisable
          text: root.canDisable ? "Disable" : "Enable"
          iconText: root.canDisable ? "󰔡" : "󰔢"
          tooltipText: root.canDisable
            ? (Model.needsPlacement(root.row)
              ? "Disable — take it out of the bar, keep it installed"
              : "Disable this plugin, keep it installed")
            : (Model.needsPlacement(root.row)
              ? "Enable — choose where in the bar it goes"
              : "Enable this plugin")
          bordered: true
          foreground: root.foreground
          fontFamily: root.fontFamily
          fontSize: Style.font.caption
          enabled: root.actionsEnabled
          opacity: enabled ? 1 : 0.4
          onClicked: root.canDisable ? root.disableRequested() : root.enableRequested()
        }

        Button {
          id: updateButton
          visible: root.row ? root.row.updatable === true : false
          text: root.updating ? "Updating…" : (root.hasUpdate ? "Update" : "Update")
          iconText: root.updating ? "" : "󰑐"
          iconSpinning: root.updating
          tooltipText: {
            if (!root.row) return "Update this checkout"
            if (root.hasUpdate) return "Update available — pull from " + root.row.remote
            if (root.row.updateChecked === true) return "Up to date with " + root.row.remote
            return root.row.remote !== "" ? "Update from " + root.row.remote : "Update this checkout"
          }
          bordered: true
          foreground: root.hasUpdate ? Color.accent : root.foreground
          fontFamily: root.fontFamily
          fontSize: Style.font.caption
          enabled: root.actionsEnabled && root.updateEnabled && !root.upToDate
          opacity: root.updating ? 1 : (enabled ? 1 : 0.4)
          onClicked: root.updateRequested()
        }

        Button {
          visible: root.row ? root.row.removable === true : false
          text: "Remove"
          iconText: "󰩹"
          tooltipText: "Remove this plugin"
          bordered: true
          foreground: root.foreground
          // The kit's Button paints its hover state from `accent`; urgent is
          // the same warning the row's trash icon gives on hover.
          accent: Color.urgent
          fontFamily: root.fontFamily
          fontSize: Style.font.caption
          enabled: root.actionsEnabled
          opacity: enabled ? 1 : 0.4
          onClicked: root.removeRequested()
        }

        Button {
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
      }
    }
  }
}
