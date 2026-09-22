import QtQuick
import qs.Commons
import qs.Ui
import "Model.js" as Model

// Presentation only: the owning panel supplies inventory and handles navigation.
Column {
  id: root

  property string pluginsBasePath: ""
  property string updateDataPath: ""
  property string updateDataCount: "Unavailable"
  property bool updateDataLoading: false
  property bool cleanupEnabled: false
  property string cleanupOutcome: ""
  property string installedVersion: ""
  required property color foreground
  required property color secondaryForeground
  required property string fontFamily
  readonly property string repositoryUrl: "https://github.com/juancasanueva/omarchy-plugin-manager"
  readonly property string versionLabel: Model.releaseVersionLabel(installedVersion)

  signal cleanupRequested()
  signal repositoryNavigationRequested(string url)
  signal githubNavigationRequested(var candidates, string fallbackUrl)

  spacing: Style.space(14)

  Text {
    width: parent.width
    textFormat: Text.PlainText
    text: "Info"
    color: root.foreground
    font.family: root.fontFamily
    font.pixelSize: Style.font.title
    font.bold: true
    wrapMode: Text.WrapAnywhere
  }

  Rectangle {
    id: infoCard
    width: parent.width
    height: updateInfo.implicitHeight + Style.space(12) * 2
    radius: Style.cornerRadius
    color: Style.normalFill
    border.width: 1
    border.color: Qt.alpha(root.secondaryForeground, 0.35)

    Column {
      id: updateInfo
      anchors.left: parent.left
      anchors.right: parent.right
      anchors.margins: Style.space(12)
      anchors.verticalCenter: parent.verticalCenter
      spacing: Style.space(10)

      Text {
        objectName: "installationPath"
        width: parent.width
        textFormat: Text.PlainText
        text: "Plugins installed in " + (root.pluginsBasePath !== "" ? root.pluginsBasePath
          : root.updateDataLoading ? "Loading…" : "Unavailable")
        color: root.foreground
        font.family: root.fontFamily
        font.pixelSize: Style.font.body
        wrapMode: Text.WrapAnywhere
      }

      Text {
        objectName: "updateDataPathText"
        width: parent.width
        textFormat: Text.PlainText
        text: "Plugin Manager Updates are in " + (root.updateDataPath !== "" ? root.updateDataPath
          : root.updateDataLoading ? "Loading…" : "Unavailable")
        color: root.foreground
        font.family: root.fontFamily
        font.pixelSize: Style.font.body
        wrapMode: Text.WrapAnywhere
      }

      Text {
        objectName: "updateDataCounter"
        width: parent.width
        textFormat: Text.PlainText
        text: root.updateDataCount
        color: root.foreground
        font.family: root.fontFamily
        font.pixelSize: Style.font.body
        wrapMode: Text.WrapAnywhere
      }

      Text {
        width: parent.width
        textFormat: Text.PlainText
        text: "Active entries only; archive excluded. Delete removes completed data from both."
        color: root.secondaryForeground
        font.family: root.fontFamily
        font.pixelSize: Style.font.caption
        wrapMode: Text.WrapAnywhere
      }

      Button {
        objectName: "deleteUpdateDataButton"
        width: parent.width
        implicitHeight: deleteLabel.implicitHeight + Style.space(16)
        bordered: true
        enabled: root.cleanupEnabled
        opacity: enabled ? 1 : 0.4
        foreground: root.foreground
        fontFamily: root.fontFamily
        // The host's built-in label does not wrap. Keep its real interaction
        // and border, with a bounded PlainText label for narrow Settings.
        Text {
          id: deleteLabel
          anchors.centerIn: parent
          width: Math.max(0, parent.width - Style.space(24))
          textFormat: Text.PlainText
          text: "Delete update data"
          color: root.foreground
          font.family: root.fontFamily
          font.pixelSize: Style.font.caption
          horizontalAlignment: Text.AlignHCenter
          wrapMode: Text.WrapAnywhere
        }
        onClicked: root.cleanupRequested()
      }

      Text {
        objectName: "cleanupOutcomeText"
        visible: root.cleanupOutcome !== ""
        width: parent.width
        textFormat: Text.PlainText
        text: root.cleanupOutcome
        color: root.foreground
        font.family: root.fontFamily
        font.pixelSize: Style.font.caption
        wrapMode: Text.WrapAnywhere
      }
    }
  }

  Text {
    width: parent.width
    textFormat: Text.PlainText
    text: "About"
    color: root.foreground
    font.family: root.fontFamily
    font.pixelSize: Style.font.title
    font.bold: true
    wrapMode: Text.WrapAnywhere
  }

  Rectangle {
    id: aboutCard
    width: parent.width
    height: identity.implicitHeight + Style.space(12) * 2
    radius: Style.cornerRadius
    color: Style.normalFill
    border.width: 1
    border.color: Qt.alpha(root.secondaryForeground, 0.35)

    Column {
      id: identity
      anchors.left: parent.left
      anchors.right: parent.right
      anchors.margins: Style.space(12)
      anchors.verticalCenter: parent.verticalCenter
      spacing: Style.space(4)

      Text {
        width: parent.width
        textFormat: Text.PlainText
        text: "Plugin Manager"
        color: root.foreground
        font.family: root.fontFamily
        font.pixelSize: Style.font.body
        font.bold: true
        wrapMode: Text.WrapAnywhere
      }

      Text {
        objectName: "repositoryLink"
        width: parent.width
        textFormat: Text.PlainText
        text: "GitHub repository"
        color: root.foreground
        font.family: root.fontFamily
        font.pixelSize: Style.font.body
        font.underline: true
        wrapMode: Text.WrapAnywhere

        MouseArea {
          anchors.fill: parent
          cursorShape: Qt.PointingHandCursor
          onClicked: root.repositoryNavigationRequested(root.repositoryUrl)
        }
      }

      Text {
        objectName: "versionLink"
        width: parent.width
        textFormat: Text.PlainText
        text: root.versionLabel !== "" ? "Version " + root.versionLabel : "Version unavailable"
        enabled: root.versionLabel !== ""
        color: enabled ? root.foreground : root.secondaryForeground
        font.family: root.fontFamily
        font.pixelSize: Style.font.body
        font.underline: enabled
        wrapMode: Text.WrapAnywhere

        MouseArea {
          anchors.fill: parent
          cursorShape: Qt.PointingHandCursor
          onClicked: root.githubNavigationRequested(
            Model.githubReleaseCandidates(root.repositoryUrl, root.installedVersion), root.repositoryUrl)
        }
      }

      Text {
        width: parent.width
        textFormat: Text.PlainText
        text: "Juan Casanueva"
        color: root.secondaryForeground
        font.family: root.fontFamily
        font.pixelSize: Style.font.body
        wrapMode: Text.WrapAnywhere
      }
    }
  }
}
