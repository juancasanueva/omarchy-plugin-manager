# Plugin Manager

An Omarchy bar widget that manages your plugins from the bar: browse the
marketplace, install from it — choosing where in the bar each widget goes —
and enable, disable, update, or remove what you already have.

![kind: bar-widget](https://img.shields.io/badge/kind-bar--widget-informational)

![The Installed tab: a puzzle icon and Plugins heading above an add-repository
field, labelled Kind and Status dropdowns, a Search field, and separated plugin
rows with descriptions, metadata, repository links, switches, and actions](preview.png)

## What it does

Click the puzzle icon and you get two tabs.

## The Installed tab

What the shell actually found, in two sections:

- **Installed** — everything under `~/.config/omarchy/plugins`, with update
  and remove buttons alongside the on/off switch.
- **Built-in** — everything shipped under `/usr/share/omarchy`. These can be
  switched on and off like any other plugin, but not pulled or deleted: they
  are not ours to change.

The split is not cosmetic. In one mixed list, most rows carry controls that do
nothing, and you have to work out which from a badge. Two sections make the
available actions constant within each one.

A bar down the left of each row says whether the plugin is on. For a bar
widget "on" means exactly one thing — it has a place in the bar — because
that is what the shell itself reports.

Under the name, every row states **what the plugin actually does** — the
description from its manifest, wrapped across as many lines as it takes. It
used to be pinned at two, which was wrong in both directions: a
one-line blurb paid for a blank line it never used, and anything longer was
cut off mid-sentence with no way to read the rest. Rows therefore differ in
height, and that is the better trade — an uneven list is something you can
see past, a truncated sentence is not. A plugin whose author left the
description out says so, which is how you tell an empty manifest field
from a failed read. After the description comes **who wrote it, what it plugs
into, and which version is on disk** — read from each plugin's own
`manifest.json` at load time, so it is there for every plugin rather than only
the git checkouts an update check happens to reach. For a user Git checkout with
a current GitHub origin, that version is also the Release name to look up.
Clicking it checks `v<version>` first, then `<version>`. The first published
GitHub Release opens. If neither exists, navigation falls back in exactness
order: a matching local version tag at `HEAD`, the loaded `HEAD` commit, then
the validated repository root. The checkout does not need a local tag to make
the version interactive; the tag is provenance for the best fallback, not
proof that GitHub published a Release. Built-ins and rows without this current
Git checkout contract remain plain. The bounded GitHub API checks happen only
after the click — opening the panel makes no Release API request. Last comes a
link to the plugin's own repository:
reading what you are running is the whole defence here, and it should not get
harder once a plugin is installed. Git remotes are converted to something a
browser can open, so ssh and `git@host:path` checkouts link too.

A row that shows that link needs no badge saying it came from git — the link
already said so. So the `git` / `local` badge appears only on rows that have
no link, where it is the one thing separating a checkout whose origin has
gone missing from a folder somebody dropped in by hand. Both lose the link
and the update button; without the badge they would look identical.

Three controls share a row and narrow both lists at once:

- **Kind filter** (`f`) — bar-widget, panel, overlay, menu, service. The
  dropdown is built from the kinds actually installed, so the row never offers a
  filter that would match nothing. A plugin that replaces the whole bar and one
  that mounts inside it share the **Bar-widget** option, because both answer the
  same question; each row still names its own kind.
- **Status filter** — **All**, **Enabled**, **Disabled**, or **Update**.
  Enabled/Disabled read the same on/off state shown by each row's switch;
  Update shows checkouts whose background check confirmed a different remote
  commit.
- **Search by name** (`/`) — matches the name and the id, so typing
  `hyprmoncfg` finds `crmne.hyprmoncfg`. It deliberately does not search
  descriptions: a search that matched prose would surface plugins whose names
  look nothing like what you typed.

When nothing matches, the message names whichever control excluded everything
— including status when it is hiding otherwise matching plugins.

### Knowing what needs updating

Rows with an update carry an accent badge — `1.0.0 → 1.2.0` when the versions
differ, or just `update` when they do not. The header counts them, so you know
before scrolling. When the current origin is a valid GitHub repository and both
commits are known, the badge always has GitHub's exact commit comparison as its
fallback. If the remote manifest names a different version, clicking the badge
checks published Releases named `v<remoteVersion>` and then `<remoteVersion>`.
The first match opens; two 404s, a rate limit, timeout, malformed response, or
other probe failure opens the exact comparison instead. The API result proves
only that the displayed target version has a published Release; navigation is
still built locally and never trusts a response-provided URL. Same-version
updates skip Release lookup and keep the tooltip **View changes on GitHub**.

**The signal is commits, not version strings.** Authors do not reliably bump
`manifest.json`: of the two checkouts that were genuinely behind when this was
built, both reported the *same* version at each end. A version comparison would
have shown nothing for either. The catalog is no better — it publishes the
version at the commit the registry last validated, which can lag a repository
by several releases.

So the check compares your checkout's `HEAD` against the remote's, using one
branch `git ls-remote` per repository. Nothing is cloned, and no background tag
or Release lookup runs. For a checkout that is behind, the remote manifest is
read at that exact branch commit so a later click can look up the version it
actually names. The check runs in the background *after* the rows are on screen,
so the panel never waits on the network to show you what you already have. A
remote it cannot reach is reported as unknown rather than as up to date — being
quietly told nothing is how a stale plugin sits there looking current.

### The actions

- **Add** — paste a git repository url; runs `omarchy plugin add <url> --yes`
  behind a confirmation. The plugin is cloned and left switched off, because a
  bare url says nothing about what is inside it; the row it becomes carries
  the switch.
- **Enable / disable** — one switch per row, not a pair of icons that trade
  places. An icon that changes with the state makes you read the glyph to
  learn where the plugin stands and read it again to work out what clicking
  will do; a switch is already showing you both. Switching one on asks a bar
  widget *where* it goes first and lands it in the section you picked;
  anything else simply goes on. Switching one off takes a widget out of the
  bar and leaves the plugin on disk. The knob only moves once the shell has
  actually done it, so cancelling the placement question leaves the switch
  where it was rather than lying about a plugin that never went on.

  Whether a plugin can be switched off is the shell's call, not this panel's:
  a whole bar has no off, only a successor. Those rows still draw the switch,
  dimmed and fixed on — a row with no control at all reads as something that
  failed to render. Disabling this panel closes the window you are clicking
  in, so that one confirms and hands you the command to undo it.
- **Update** — for a plugin that is a git checkout with an origin remote, runs
  `omarchy plugin update <id> --yes`. A checkout with no origin has nothing to
  fast-forward from, so it gets no button rather than one that can only fail.
- **Remove** — for anything under `~/.config/omarchy/plugins`, runs
  `omarchy plugin remove <id> --yes` behind a confirmation.

## The Browse tab

![The Browse tab: a puzzle icon and Plugins heading with a Browse-only
Marketplace button between the tabs and refresh, aligned category and search
controls, and a grid of compact plugin cards with previews, descriptions,
creator lines, versions, GitHub stars, Marketplace hearts, installed or blocked
state, and details or install actions](preview-browse.png)

<sub>Shown with `qt6-imageformats` installed, so the registry thumbnails
decode too. Without it the second source is skipped and more cards fall back
to accent tiles — see below.</sub>

The second tab is the [omarchyplugins.com](https://omarchyplugins.com)
marketplace. Search matches name, id, author, and description. Category and
kind options come from the current catalog, while Availability narrows to
plugins that can be installed here or plugins already installed. All four
filters compose, and an empty result offers **Clear filters** rather than
leaving you at a dead end.

Sort explicitly by **GitHub stars**, **Marketplace hearts**, **Recently added**
(newest first), or **Name**.
Unknown counts stay unknown and sort after real counts; stars and hearts are
never combined. Names and ids provide deterministic tie-breakers.

Cards are summaries: preview, three description lines, creator, version,
separate popularity counts, installed state, and an install or details action.
Open details by clicking a card or selecting it and pressing `Enter`. The
details surface shows every available catalog fact used by the manager,
including the full description, author, version, category, kind, license,
repository and Release actions, both popularity counts, install state,
placement requirement, and installation limitations. Missing fields are
omitted rather than replaced with claims the catalog did not make.

Repository and Release actions open through `omarchy-launch-browser`, so they
land in whichever browser `omarchy default browser` selected, and only trusted
`https://` URLs are passed to it. Use `Tab`, arrow keys, or `Shift+Tab` to move
between details actions, `Enter` to activate one, and `Esc` to close.

The creator gets one line and the catalog version shares the next with `★`
GitHub stars and `♥` anonymous Marketplace hearts. The
metrics stay separate: stars come from each `catalog.json` listing, while hearts
come from `https://api.omarchyplugins.com/v1/stats` at
`plugins[pluginId].hearts`. Missing or malformed counts are omitted rather than
shown as zero.

For an exact GitHub repository, opening the Release action checks names
`v<version>` and then `<version>` through the same bounded, click-time probe used
by Installed rows. A match opens the published Release; absence or failure falls
back to the validated repository root. Non-GitHub and missing versions remain
plain or absent, and opening Browse never performs a Release API request.

Not everything the registry lists is installable in one command — suites ship
their own installers, and some repos are not plugin-shaped. Those cards show a
visible blocked reason, with the full explanation in details, instead of a
button that could only fail.
Plugins you already have carry an `installed` badge on the preview, beside the
`verified` one, rather than offering themselves again.

### Installing asks where it goes

Cloning a plugin makes the shell tear every plugin widget down and rebuild it
— this panel among them. There is no "after the install" in which a plugin's
own window can ask you anything, so the section question comes *before*
anything is cloned, off the kind the registry publishes. Both answers in hand,
the install runs detached and reports through a desktop notification, because
a process owned by a destroyed panel cannot be relied on to finish and the
placement is the half that would be dropped.

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
| `↑` `↓` / `k` `j` | Move the selection; Browse also supports `←` `→` |
| `Enter` | Update the selected Installed plugin; open the selected Browse card's details |
| `Delete` | Remove the selected plugin |
| `/` | Focus the search box |
| `a` | Focus the repository url field |
| `f` | Cycle the kind filter (Installed) |
| `1` `2` | Switch to the Installed / Browse tab |
| `r` | Re-read the plugin list or re-fetch the active Browse catalog |
| `Esc` | Clear the search, then leave the field, then close the panel |

In Browse details, `Tab`, `Shift+Tab`, and the arrow keys move between actions;
`Enter` activates the selected action and `Esc` returns to the card grid.

## Install

```bash
omarchy plugin add https://github.com/juancasanueva/omarchy-plugin-manager.git --enable
```

Then move it if it did not land where you want it:

```bash
omarchy bar move io.github.juancasanueva.plugin-manager --section right
```

## Remove

```bash
omarchy plugin remove io.github.juancasanueva.plugin-manager --yes
```

That deletes `~/.config/omarchy/plugins/io.github.juancasanueva.plugin-manager`
and takes the widget out of your bar. Nothing is left behind: the only other
thing this plugin writes is a catalog cache, which you can drop with

```bash
rm -rf ~/.cache/omarchy-plugin-manager
```

To take it off the bar without uninstalling it, use the panel's own disable
button, or:

```bash
omarchy plugin disable io.github.juancasanueva.plugin-manager
```

## Requirements

Everything this plugin runs is already part of a standard Omarchy install. It
shells out to `omarchy` and `omarchy-shell` for every action it takes, plus:

| Command | Used for |
|---------|----------|
| `git` | reading each checkout's origin and comparing `HEAD` against the remote |
| `jq` | parsing plugin manifests and projecting the marketplace catalog |
| `curl` | fetching the catalog and remote manifests |
| `notify-send` | reporting an install's outcome, since the panel is torn down by one |
| `bash`, coreutils | the loading and install scripts |
| `omarchy-launch-browser` | opening repository links in your chosen browser |

Optional: **`qt6-imageformats`** turns on the registry's WebP card thumbnails
(see [above](#where-the-card-previews-come-from)). Without it the panel falls
back to repository `preview.png` files and accent tiles.

### What it writes

Nothing, directly. Every change to your configuration goes through the
`omarchy plugin` commands, and only on an explicit click: enabling or
disabling a plugin edits `~/.config/omarchy/shell.json` through
`omarchy plugin enable`/`disable`, and installing or removing one goes through
`omarchy plugin add`/`remove`. Its own cache lives in
`~/.cache/omarchy-plugin-manager/`.

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
| `PluginRow.qml` | One row: name, author/kind/version, description, repository link, on/off switch, and its buttons |
| `CatalogCard.qml` | One compact marketplace card: preview, summary, state, metrics, details, and install |
| `PluginDetails.qml` | Full Marketplace metadata, trusted links, limitations, and keyboard actions |
| `ChoiceDialog.qml` | The modal that asks which one, where ConfirmDialog asks whether |
| `Model.js` | Pure parsing, merging, grouping, searching, and filtering |

## License

MIT — see [LICENSE](LICENSE).
