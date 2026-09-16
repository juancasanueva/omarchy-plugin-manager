import QtQuick
import qs.Commons
import "Model.js" as Model

// Presentation only: the owning panel supplies inventory and handles navigation.
Column {
  id: root

  required property string pluginsBasePath
  property string installedVersion: ""
  required property color foreground
  required property color secondaryForeground
  required property string fontFamily
  readonly property string repositoryUrl: "https://github.com/juancasanueva/omarchy-plugin-manager"
  readonly property string versionLabel: Model.releaseVersionLabel(installedVersion)

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
    height: installationPath.implicitHeight + Style.space(12) * 2
    radius: Style.cornerRadius
    color: Style.normalFill
    border.width: 1
    border.color: Qt.alpha(root.secondaryForeground, 0.35)

    Text {
      id: installationPath
      objectName: "installationPath"
      anchors.left: parent.left
      anchors.right: parent.right
      anchors.margins: Style.space(12)
      anchors.verticalCenter: parent.verticalCenter
      textFormat: Text.PlainText
      text: "Installed in " + root.pluginsBasePath
      color: root.foreground
      font.family: root.fontFamily
      font.pixelSize: Style.font.body
      wrapMode: Text.WrapAnywhere
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
