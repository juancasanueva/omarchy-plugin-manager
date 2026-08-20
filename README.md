# Plugin Manager

An Omarchy bar widget that lists every plugin the shell discovered and lets
you add, update, and remove them without leaving the bar.

![kind: bar-widget](https://img.shields.io/badge/kind-bar--widget-informational)

## What it does

Click the puzzle icon in the bar and you get your plugins in two lists:

- **Installed** — everything under `~/.config/omarchy/plugins`, with an update
  and a remove button on every row.
- **Built-in** — everything shipped under `/usr/share/omarchy`. No buttons:
  these are not ours to pull or delete.

The split is not cosmetic. In one mixed list, most rows carry controls that do
nothing, and you have to work out which from a badge. Two sections make the
available actions constant within each one.

Every row shows **what the plugin actually does** — the description from its
manifest, wrapped across two lines, because one elided line usually cuts off
before it has said anything. The two lines are reserved even when the text is
short, so rows keep a uniform height as you filter. A plugin whose author left
the description out says so, which is how you tell an empty manifest field
from a failed read.

Two controls narrow both lists at once:

- **Search by name** (`/`) — matches the name and the id, so typing
  `hyprmoncfg` finds `crmne.hyprmoncfg`. It deliberately does not search
  descriptions: a search that matched prose would surface plugins whose names
  look nothing like what you typed.
- **Kind filter** (`f`) — widget, panel, overlay, menu, service, bar. The
  chips are built from the kinds actually installed, so the row never offers a
  filter that would match nothing.

When nothing matches, the message names whichever control excluded everything
— a stale search term sitting behind a kind chip is easy to forget about.

### The three actions

- **Add** — paste a git repository url; runs
  `omarchy plugin add <url> --enable --yes` behind a confirmation.
- **Update** — for a plugin that is a git checkout with an origin remote, runs
  `omarchy plugin update <id> --yes`. A checkout with no origin has nothing to
  fast-forward from, so it gets no button rather than one that can only fail.
- **Remove** — for anything under `~/.config/omarchy/plugins`, runs
  `omarchy plugin remove <id> --yes` behind a confirmation.

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
| `↑` `↓` / `k` `j` | Move the selection, across both sections |
| `Enter` | Update the selected plugin |
| `Delete` | Remove the selected plugin |
| `/` | Focus the search box |
| `a` | Focus the repository url field |
| `f` | Cycle the kind filter |
| `r` | Re-read the plugin list |
| `Esc` | Clear the search, then leave the field, then close the panel |

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
| `Panel.qml` | The two lists, search, filter, actions, and confirmations |
| `PluginRow.qml` | One row: name, id, kinds, description, and its two buttons |
| `Model.js` | Pure parsing, merging, grouping, searching, and filtering |

## License

MIT — see [LICENSE](LICENSE).
