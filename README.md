# Plugin Manager

An Omarchy bar widget that manages your plugins from the bar: browse the
marketplace, install from it, and update or remove what you already have.

![kind: bar-widget](https://img.shields.io/badge/kind-bar--widget-informational)

![The plugin manager panel: a repository url field, kind filter chips beside a
search box, and the installed plugins listed with their descriptions, each row
carrying an update and a remove button](preview.png)

## What it does

Click the puzzle icon and you get two tabs.

## The Installed tab

What the shell actually found, in two sections:

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

Two controls share a row and narrow both lists at once:

- **Search by name** (`/`) — matches the name and the id, so typing
  `hyprmoncfg` finds `crmne.hyprmoncfg`. It deliberately does not search
  descriptions: a search that matched prose would surface plugins whose names
  look nothing like what you typed.
- **Kind filter** (`f`) — widget, panel, overlay, menu, service, bar. The
  chips are built from the kinds actually installed, so the row never offers a
  filter that would match nothing.

When nothing matches, the message names whichever control excluded everything
— a stale search term sitting behind a kind chip is easy to forget about.

### Knowing what needs updating

Every row shows its installed version, and rows with an update carry an accent
badge — `1.0.0 → 1.2.0` when the versions differ, or just `update` when they
do not. The header counts them, so you know before scrolling.

**The signal is commits, not version strings.** Authors do not reliably bump
`manifest.json`: of the two checkouts that were genuinely behind when this was
built, both reported the *same* version at each end. A version comparison would
have shown nothing for either. The catalog is no better — it publishes the
version at the commit the registry last validated, which can lag a repository
by several releases.

So the check compares your checkout's `HEAD` against the remote's, using
`git ls-remote`: one sha per repository, nothing downloaded, about a second for
a dozen plugins. It runs in the background *after* the rows are on screen, so
the panel never waits on the network to show you what you already have. A
remote it cannot reach is reported as unknown rather than as up to date —
being quietly told nothing is how a stale plugin sits there looking current.

### The three actions

- **Add** — paste a git repository url; runs
  `omarchy plugin add <url> --enable --yes` behind a confirmation.
- **Update** — for a plugin that is a git checkout with an origin remote, runs
  `omarchy plugin update <id> --yes`. A checkout with no origin has nothing to
  fast-forward from, so it gets no button rather than one that can only fail.
- **Remove** — for anything under `~/.config/omarchy/plugins`, runs
  `omarchy plugin remove <id> --yes` behind a confirmation.

## The Browse tab

![The Browse tab: a category dropdown and catalog search above a grid of plugin
cards, each with a preview tile, a five-line description, a link to the source
repository, author, star count, and an install button](preview-browse.png)

<sub>Shown with `qt6-imageformats` installed, so the registry thumbnails
decode too. Without it the second source is skipped and more cards fall back
to accent tiles — see below.</sub>

The second tab is the [omarchyplugins.com](https://omarchyplugins.com)
marketplace — 726 community plugins, searchable by name, author, or
description, filterable by category, sorted by stars. Installing runs the same
`omarchy plugin add` the Installed tab does, behind the same confirmation.

Each card carries five lines of the plugin's own description and a clickable
link to its source repository, because reading the code before you run it is
the whole defence here — the way to it belongs on the card, not behind a
detail view. Links open through `omarchy-launch-browser`, so they land in
whichever browser `omarchy default browser` selected, and only `https://` urls
are ever passed to it.

Not everything the registry lists is installable in one command — suites ship
their own installers, and some repos are not plugin-shaped. Those cards show
the registry's own explanation instead of a button that could only fail.
Plugins you already have say `installed` rather than offering themselves again.

### Where the catalog comes from

`https://omarchyplugins.com/catalog.json`, the same file the website renders
from, generated by
[HANCORE-linux/omarchy-plugin-marketplace](https://github.com/HANCORE-linux/omarchy-plugin-marketplace)
(MIT). It is fetched on your first visit to the tab, projected down to the
fields this panel uses with `jq`, and cached for six hours in
`~/.cache/omarchy-plugin-manager/`. A failed fetch falls back to the cached
copy — a stale storefront beats an apparently empty one. The refresh button
forces a re-fetch.

The catalog's `installCommand` is **read, never executed**: the url is parsed
out of it, validated, and passed to the same argv array everything else uses.

### Where the card previews come from

Each card tries three sources in order and stops at the first that decodes:

1. **The repository's own `preview.png`**, read straight from
   `raw.githubusercontent.com` at the branch the registry validated. Most
   plugins ship one — 31 of a 40-repo sample — and PNG is a format Qt always
   reads.
2. **The registry's curated thumbnail.** These are WebP, which Qt decodes only
   when `qt6-imageformats` is installed. It is not a dependency of Omarchy or
   Quickshell, so on a stock system this step is skipped after the first
   failure tells the panel so.
3. **The accent-and-initials tile** the registry ships for listings with no
   screenshot at all.

Installing `qt6-imageformats` adds the second source, which fills in most of
what the first one misses:

```bash
sudo pacman -S qt6-imageformats
```

### Verified is a signal, not a promise

The registry runs a security baseline over listings and marks some verified.
The badge is shown, and the install dialog says in words that a review is not
a guarantee. Plugin code runs unsandboxed with your user's privileges whether
or not it carries a badge.

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
| `f` | Cycle the kind filter (Installed) |
| `1` `2` | Switch to the Installed / Browse tab |
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
| `Panel.qml` | Both tabs, search, filters, actions, and confirmations |
| `PluginRow.qml` | One row: name, id, kinds, description, and its two buttons |
| `CatalogCard.qml` | One marketplace card: preview, blurb, stars, install |
| `Model.js` | Pure parsing, merging, grouping, searching, and filtering |

## License

MIT — see [LICENSE](LICENSE).
