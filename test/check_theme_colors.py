#!/usr/bin/env python3
"""Check actual plugin palette bindings in an isolated Wayland/Quickshell session.

No panel is opened and no install, update, removal or navigation action is run.
"""
import argparse
import json
import os
from pathlib import Path
import re
import subprocess
import tempfile


QML = r'''import QtQuick
import Quickshell
import qs.Commons as Theme
ShellRoot {
  id: testRoot
  property var objects: []
  Component.onCompleted: Qt.callLater(run)
  function find(item, name) {
    if (item.objectName === name) return item
    var children = item.children || []
    for (var i = 0; i < children.length; i++) {
      var found = find(children[i], name)
      if (found) return found
    }
    return null
  }
  function run() {
    var files = FILES
    var passed = 0, failures = []
    for (var i = 0; i < files.length; i++) {
      var file = files[i], name = file.slice(file.lastIndexOf('/') + 1)
      var component = Qt.createComponent(file)
      if (component.status !== Component.Ready) {
        failures.push(name + ': ' + component.errorString()); continue
      }
      var properties = {}
      if (['InstalledDetails.qml', 'InstalledListRow.qml', 'PluginRow.qml', 'CatalogDetailsPane.qml', 'CatalogCard.qml', 'PluginDetails.qml', 'SettingsInfo.qml'].indexOf(name) >= 0)
        properties.secondaryForeground = Qt.alpha(Theme.Color.foreground, 0.54)
      if (name === 'SettingsInfo.qml') {
        properties.foreground = Theme.Color.foreground
        properties.fontFamily = Theme.Style.font.family
      }
      var object = component.createObject(testRoot, properties)
      if (!object) { failures.push(name + ': could not instantiate'); continue }
      objects.push(object)
      var checks = {}
      if (name === 'Expanded.qml') checks.foreground = Theme.Color.menu.text
      else if (name === 'Panel.qml') checks.contentForeground = Theme.Color.foreground
      else if (name !== 'SettingsInfo.qml' && name !== 'BarWidget.qml') checks.foreground = Theme.Color.foreground
      if (['InstalledDetails.qml', 'CatalogDetailsPane.qml'].indexOf(name) >= 0) checks.background = Theme.Color.menu.background
      if (['ChoiceDialog.qml', 'ActionConfirmDialog.qml', 'PluginDetails.qml'].indexOf(name) >= 0) checks.background = Theme.Color.background
      if (['ChoiceDialog.qml', 'ActionConfirmDialog.qml'].indexOf(name) >= 0) checks.selectedText = Theme.Color.accent
      var ok = true
      for (var property in checks) {
        if (!Qt.colorEqual(object[property], checks[property])) {
          failures.push(name + '.' + property + ': expected ' + checks[property] + ', got ' + object[property]); ok = false
        }
      }
      if (name === 'SettingsInfo.qml') {
        var text = find(object, 'installationPath')
        if (!text || !Qt.colorEqual(text.color, Theme.Color.accent)) {
          failures.push(name + ': installation path does not use the theme accent'); ok = false
        }
      }
      if (name === 'BarWidget.qml') {
        var badge = (object.children || []).filter(function(item) {
          return item.width === Theme.Style.space(6) && item.height === item.width
        })[0]
        if (!badge || !Qt.colorEqual(badge.color, Theme.Color.accent)) {
          failures.push(name + ': update badge does not use the theme accent'); ok = false
        }
      }
      if (ok) passed++
      component.destroy()
    }
    console.log('PLUGIN_MANAGER_COLOR_TESTS ' + JSON.stringify({passed:passed, failures:failures}))
    Qt.quit()
  }
}
'''


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--plugin-dir', type=Path, default=Path(__file__).resolve().parents[1])
    args = parser.parse_args()
    if not os.environ.get('WAYLAND_DISPLAY'):
        parser.error('Run inside an isolated Wayland session')
    names = ('Expanded.qml', 'Panel.qml', 'InstalledDetails.qml', 'InstalledListRow.qml',
             'PluginRow.qml', 'CatalogDetailsPane.qml', 'CatalogCard.qml', 'PluginDetails.qml',
             'ChoiceDialog.qml', 'ActionConfirmDialog.qml', 'SettingsInfo.qml', 'BarWidget.qml')
    files = [(args.plugin_dir.resolve() / name).as_uri() for name in names]
    shell = Path(os.environ.get('OMARCHY_PATH', '/usr/share/omarchy')) / 'shell'
    with tempfile.TemporaryDirectory(prefix='plugin-manager-colors-') as directory:
        root = Path(directory)
        imports = root / 'imports'
        imports.mkdir()
        (imports / 'qs').symlink_to(shell, target_is_directory=True)
        config = root / 'shell.qml'
        config.write_text(QML.replace('FILES', json.dumps(files)))
        env = dict(os.environ, QML_IMPORT_PATH=str(imports), QT_QPA_PLATFORM='wayland',
                   QT_QPA_PLATFORMTHEME='basic', QT_QUICK_BACKEND='software')
        try:
            result = subprocess.run(['qs', '--no-color', '-p', str(config)], env=env,
                                    text=True, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, timeout=20)
        except subprocess.TimeoutExpired as error:
            print((error.stdout or b'').decode('utf-8', 'replace'))
            print('Theme-color check timed out')
            return 1
        print(result.stdout, end='')
        match = re.search(r'PLUGIN_MANAGER_COLOR_TESTS (\{[^\n]+\})', result.stdout)
        report = json.loads(match[1]) if match else {}
        return 0 if result.returncode == 0 and report.get('passed') == len(names) and report.get('failures') == [] else 1


if __name__ == '__main__':
    raise SystemExit(main())
