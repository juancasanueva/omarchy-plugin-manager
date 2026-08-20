# Plugin Manager

An Omarchy bar widget that lists every plugin the shell discovered and lets
you add, update, and remove them without leaving the bar.

![kind: bar-widget](https://img.shields.io/badge/kind-bar--widget-informational)

## What it does

Click the puzzle icon in the bar and you get one list:

- **Every discovered plugin**, first-party and third-party, with its enabled
  state, id, and kinds.
- **Add** — paste a git repository url and it runs
  `omarchy plugin add <url> --enable --yes` behind a confirmation.
- **Update** — for any plugin that is a git checkout, runs
  `omarchy plugin update <id> --yes`.
- **Remove** — for anything under `~/.config/omarchy/plugins`, runs
  `omarchy plugin remove <id> --yes` behind a confirmation.

Built-in plugins under `/usr/share/omarchy` show as `built-in` and have no
update or remove button — they are not ours to touch.

## Why it confirms

Adding a plugin clones a repository and loads its QML into the long-running
`omarchy-shell` process. Plugin code is **unsandboxed**: it runs with your
user's full privileges. Removing deletes a directory. Both actions confirm
first, and the add dialog shows the full url so you can read it before it
runs.

Commands are executed as argv arrays, never through a shell, so a repository
url cannot become a command. Urls are also validated against `https://`,
`ssh://`, and `git@host:path` before they are passed on.

## Keyboard

| Key | Action |
|-----|--------|
| `↑` `↓` / `k` `j` | Move the selection |
| `Enter` | Update the selected plugin |
| `Delete` | Remove the selected plugin |
| `a` | Focus the repository url field |
| `r` | Re-read the plugin list |
| `Esc` | Close the panel |

## Install

```bash
omarchy plugin add https://github.com/juancasanueva/omarchy-plugin-manager.git --enable
```

Then place it in the bar if it did not land where you want it:

```bash
omarchy bar move io.github.juancasanueva.plugin-manager right
```

## Develop

The plugin directory must live at
`~/.config/omarchy/plugins/io.github.juancasanueva.plugin-manager`. Saving any
file under `~/.config/omarchy/plugins/` hot-reloads the plugin code.

```bash
omarchy plugin validate ~/.config/omarchy/plugins/io.github.juancasanueva.plugin-manager
qmllint -I /usr/share/omarchy/shell BarWidget.qml Panel.qml

omarchy-shell shell rescanPlugins
omarchy-shell shell toggle io.github.juancasanueva.plugin-manager '{}'
```

## Layout

| File | Role |
|------|------|
| `manifest.json` | Plugin contract — id, kind, entry point |
| `BarWidget.qml` | The bar slot and the open/close contract the bar routes through |
| `Panel.qml` | The list, the actions, and the confirmations |
| `Model.js` | Pure parsing and merging of the CLI output |

## License

MIT — see [LICENSE](LICENSE).
