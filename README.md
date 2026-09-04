# Plugin Manager

An Omarchy bar widget that manages your plugins from the bar: browse the
marketplace, install from it — choosing where in the bar each widget goes —
and enable, disable, update, or remove what you already have. It opens as a
popup under the bar and expands, on request, into a full-size panel with a
details pane.

![kind: bar-widget](https://img.shields.io/badge/kind-bar--widget-informational)

![The popup's Installed tab: a puzzle icon and Plugins heading with an
installed, total, and to-update summary, Installed and Browse tabs, expand and
refresh icons, labelled Source, Kind, and Status dropdowns, a Search field, and
separated plugin rows with descriptions, metadata, repository links, update
badges, switches, and actions above a hint bar with filter keys on the left and
row actions on the right](preview.png)

## What it does

Click the puzzle icon and you get two tabs in a popup: **Installed**, which is
what the shell actually found on disk, and **Browse**, which is the
marketplace. Both are described below. When the popup is too small for the
job, the same two tabs open in a full-size panel.

## The expanded panel

![The expanded panel's Installed tab: the same heading and summary, a search
box and Source, Kind, and Status dropdowns in one labelled row, a list of
plugin rows with state marks, verified pills, star counts, and one-line
descriptions beside a details pane showing the selected plugin's name, on/off
switch, Update, Remove, and Open repository buttons, its screenshot, and its
description, above a hint bar with tab, action, and close keys](preview-expanded.png)

The popup is built for a glance. When you want room, the icon left of the
refresh button (`󰊓`) hands the same manager to a full-size panel, and the `󰊔`
icon in the same corner brings the popup back. The header, the tabs, the
summary counts, the opening animation and the card flip between tabs are the
ones the popup has; what changes is how much each tab can show.

**Installed** becomes a list beside a details pane. The rows are summaries:
a mark leads the name — a green check when the checkout is up to date, an
orange arrow when an update is confirmed — followed by the `verified` pill
and, on the right, the repository's GitHub star count, with one line of
description underneath. Everything else moves to the pane on the right, which
shows the selected plugin in full: its name, the on/off switch and the Update,
Remove, and Open repository buttons laid out under it, the plugin's own
screenshot, the whole description, and its facts. The screenshot is the
checkout's `preview.png` when it ships one, otherwise the catalog preview for
the same id. The Version fact is a link that resolves to the matching GitHub
Release at click time, exactly as the popup's row does. Your place in the list
survives a trip to Browse and back, and the pane refreshes on its own once the
shell has finished an enable or disable.

![The expanded panel's Browse tab: a search box beside Category, Kind,
Availability, and Sort dropdowns above a four-column grid of marketplace cards
with whole previews, names, descriptions, star and heart counts, and installed
and verified badges](preview-expanded-browse.png)

**Browse** becomes a wider grid of the same cards, with the card pictures shown
whole rather than cropped to the frame, so a tall or wide screenshot is still
the screenshot. The cards drop their info and install buttons because a card
opens a full page instead: click it, or select it and press `Enter`.

![The expanded panel's Browse details page: a Back button, the plugin's preview
shown whole, its name with star and heart counts, author and kind, verified
and installed pills, the full description, a table of catalog facts, the
installation warning, and Open repository and Release buttons](preview-expanded-details.png)

The details page takes the whole panel. It leads with the preview and the
name, then the author and kind, the `verified` and `installed` pills, the full
description, and every catalog fact the manager has — author, version,
category, kind, license, review status, stars, hearts, availability, and
whether installation will ask for a bar section — followed by the installation
warning and the repository and Release buttons. A plugin you do not have yet
gets an **Install** button here; the confirmation overlays the page, and the
page stays open once the install lands so you can see the `installed` pill
arrive. The filter row hides while the page is up, `Esc` or **Back** returns
you to the grid.

Both tabs share one search box and, on this surface, it wears a caption like
the dropdowns beside it and grows an `x` the moment there is something to
clear. The hint bar names the tab keys as well as the actions — `[1] INSTALLED
[2] BROWSE` on the right, before `[ESC] CLOSE` — so every way in and out is
written down.

Under the hood the plugin registers a second kind, `panel`, whose entry point
is `Expanded.qml`. Both surfaces share one data layer, `PluginStore.qml`, so
an install, update, enable, disable or remove is the same code whichever
window you started it from, and the catalog is parsed on a worker thread so a
two-thousand-entry marketplace never freezes the window that asked for it.
One consequence of the extra kind: the shell now routes
`omarchy-shell shell toggle io.github.juancasanueva.plugin-manager` to the
expanded panel, which makes it the thing to bind a hotkey to, while the bar
button still opens the popup.

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

A labelled filter row sits above Search, in the same shape the Browse tab
uses, and every control narrows both lists at once:

- **Source filter** (`s`) — **All**, **Installed**, or **Built-in**. Picking one
  section hides the other, which is also the quickest way to see that a
  section is empty.
- **Kind filter** (`f`) — bar-widget, panel, overlay, menu, service. The
  dropdown is built from the kinds actually installed, so the row never offers a
  filter that would match nothing. A plugin that replaces the whole bar and one
  that mounts inside it share the **Bar-widget** option, because both answer the
  same question; each row still names its own kind.
- **Status filter** (`t`) — **All**, **Enabled**, **Disabled**, or **Update**.
  Enabled/Disabled read the same on/off state shown by each row's switch;
  Update shows checkouts whose background check confirmed a different remote
  commit.
- **Search by name** (`/`) — matches the name and the id, so typing
  `hyprmoncfg` finds `crmne.hyprmoncfg`. It deliberately does not search
  descriptions: a search that matched prose would surface plugins whose names
  look nothing like what you typed. An `x` appears at the end of the box while
  there is a term to clear, and switching tabs clears it too: the two tabs
  search different things, so a term carried across would be a different
  query silently shrinking the other list.

The hint bar under the list shows the filters on the left — `[S] SOURCE
[F] KIND  [T] STATUS`, each naming its dropdown while neutral and its value,
brighter, once it narrows — and the row actions on the right.
When nothing matches, the message names whichever controls excluded everything
— including source and status when they are hiding otherwise matching plugins.

### Knowing what needs updating

Rows with an update carry an accent badge — `1.0.0 → 1.2.0` when the versions
differ, or just `update` when they do not. The header counts them, so you know
before scrolling; the bar's puzzle icon marks the same confirmed state with a
small blue dot. When the current origin is a valid GitHub repository and both
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

- **Add** — from the Browse tab only; there is no url field. Installing a
  card runs `omarchy plugin add <url> --yes` behind a confirmation, with the
  url taken from the catalog entry rather than typed in.
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
  Omarchy's own command shows the diff and asks before it pulls; `--yes` skips
  that, so the review happens here instead. The marketplace reviews one exact
  commit per plugin, and the update is one click only when the remote commit
  *is* that reviewed snapshot. Anything else — a repository that has moved
  past its reviewed commit, a plugin the marketplace does not list, or a
  catalog that has not loaded yet — puts up a confirmation that says exactly
  what nobody has reviewed, with a link to the diff on GitHub when the remote
  is there.
- **Remove** — for anything under `~/.config/omarchy/plugins`, runs
  `omarchy plugin remove <id> --yes` behind a confirmation.

## The Browse tab

![The popup's Browse tab: a puzzle icon and Plugins heading with a Browse-only
Marketplace link to the left of the tabs, labelled Category, Kind,
Availability, and Sort dropdowns above a search field, and a grid of compact
plugin cards with previews, descriptions, creator lines, versions, GitHub
stars, Marketplace hearts, installed and verified badges, and details or
install actions, above a hint bar with filter keys on the left and details and
search keys on the right](preview-browse.png)

<sub>Shown with `qt6-imageformats` installed, so the registry thumbnails
decode too. Without it the second source is skipped and more cards fall back
to accent tiles — see below.</sub>

The second tab is the [omarchyplugins.com](https://omarchyplugins.com)
marketplace. Search matches name, id, author, and description. Category and
kind options come from the current catalog, while Availability narrows to
plugins that can be installed here or plugins already installed. All four
filters compose, and an empty result offers **Clear filters** rather than
leaving you at a dead end. The hint bar under the grid shows the filters on
the left — `[C] CATEGORY  [F] KIND  [A] AVAILABILITY  [S] RECENTLY ADDED`,
each naming its dropdown while neutral and its value, brighter, once it
narrows — and `[↵] DETAILS  [/] SEARCH` on the right.

Sort explicitly by **GitHub stars**, **Marketplace hearts**, **Recently added**
(newest first), or **Name**.
Unknown counts stay unknown and sort after real counts; stars and hearts are
never combined. Names and ids provide deterministic tie-breakers.

Cards are summaries: preview, three description lines, creator, version,
separate popularity counts, installed state, and an install or details action.
Open details by clicking a card or selecting it and pressing `Enter`. In the
popup the details open over the grid; in the expanded panel they take the
whole window. Either way the details surface leads with the same preview the
card showed, then shows every available catalog fact used by the manager,
including the full description, author, version, category, kind, license,
repository and Release actions, both popularity counts, install state,
placement requirement, and installation limitations. Missing fields are
omitted rather than replaced with claims the catalog did not make.

Repository and Release actions open through `omarchy-launch-browser`, so they
land in whichever browser `omarchy default browser` selected, and only trusted
`https://` URLs are passed to it. Use `Tab`, arrow keys, or `Shift+Tab` to move
between details actions, `Enter` to activate one, and `Esc` to close.

The creator gets one line and the catalog version shares the next with a
yellow star for GitHub stars and a red heart for anonymous Marketplace hearts,
each count sitting on its icon's baseline beside the details and install
buttons. The metrics stay separate: stars come from each `catalog.json`
listing, while hearts
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
(MIT). It is read from the cache when the panel opens and fetched when that
cache is missing or stale, projected down to the fields this panel uses with
`jq`, and cached for six hours in `~/.cache/omarchy-plugin-manager/`. A failed fetch falls back to the cached
copy — a stale storefront beats an apparently empty one. The refresh button
forces a re-fetch.

The work per keystroke is kept small on purpose. Each entry's lowercased
search text and its listing timestamp are derived once, on the worker thread,
so the main thread does one substring test per entry rather than lowercasing
four fields and parsing a date. The catalog is sorted once per sort mode and
then filtered in that order, since filtering keeps the order it is given, so
typing never re-sorts two thousand entries. The search box itself is
debounced: the lists follow it after a short pause rather than rebuilding
every visible row or card once per letter, and clearing applies at once. And
the Browse grid has no model until the tab has been shown, because a hidden
`GridView` still builds the cards in its viewport — and fetches their
previews — the moment the catalog lands.

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
The badge is shown on Browse cards and, joined by id to the same catalog, as a
pill beside the name of Installed rows — so what you already run says whether
the registry reviewed it. The install dialog says in words that a review is not
a guarantee. Plugin code runs unsandboxed with your user's privileges whether
or not it carries a badge.

## Why it confirms

Adding a plugin clones a repository and loads its QML into the long-running
`omarchy-shell` process. Plugin code is **unsandboxed**: it runs with your
user's full privileges. Removing deletes a directory. Both actions confirm
first, and the install dialog shows the full url so you can read it before it
runs. There is no free-text url entry: every url comes from a catalog entry.

Commands are executed as argv arrays, never through a shell, so a repository
url cannot become a command. Urls are also validated against `https://`,
`ssh://`, and `git@host:path` before they are passed on.

## Keyboard

| Key | Action |
|-----|--------|
| `↑` `↓` / `k` `j` | Move the selection; Browse also supports `←` `→` and `h` `l` |
| `Enter` | Update the selected Installed plugin; open the selected Browse card's details |
| `Delete` | Remove the selected plugin |
| `/` | Focus the search box |
| `f` | Cycle the Kind dropdown on either tab |
| `s` | Cycle Source (Installed) or Sort (Browse) |
| `t` | Installed: cycle the Status dropdown |
| `c` `a` | Browse: cycle the Category and Availability dropdowns |
| `1` `2` | Switch to the Installed / Browse tab |
| `r` | Re-read the plugin list or re-fetch the active Browse catalog |
| `Esc` | Clear the search, then leave the field, then close the panel |

In Browse details, `Tab`, `Shift+Tab`, and the arrow keys move between actions;
`Enter` activates the selected action and `Esc` returns to the card grid. The
expanded panel answers the same keys, with `1` and `2` written into its hint
bar.

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
qmllint -I /usr/share/omarchy/shell BarWidget.qml Panel.qml Expanded.qml

omarchy-shell shell rescanPlugins
omarchy-shell shell toggle io.github.juancasanueva.plugin-manager '{}'
```

## Layout

| File | Role |
|------|------|
| `manifest.json` | Plugin contract — id, kinds, entry points |
| `BarWidget.qml` | The bar slot and the open/close contract the bar routes through |
| `Panel.qml` | The popup: both tabs, search, filters, and the dialogs |
| `Expanded.qml` | The full-size panel: Installed as list plus details, Browse as a wider card grid with a full-page details face |
| `InstalledListRow.qml` | One summary row in the expanded list: state mark, name, verified pill, star count, one line of description |
| `InstalledDetails.qml` | One installed plugin in full: switch and action buttons, screenshot, description, facts, and links |
| `CatalogDetailsPane.qml` | The expanded panel's Browse details page: preview, facts, warning, repository, Release, and Install |
| `PluginStore.qml` | The shared data layer: plugin list, update check, catalog fetch, actions, and what is pending confirmation |
| `CatalogWorker.js` | The worker thread that parses the catalog so the window never waits on it |
| `ReleaseNavigator.qml` | The click-time Release probe and the one place a browser is launched from, shared by both surfaces |
| `PluginRow.qml` | One popup row: name, author/kind/version, description, repository link, on/off switch, and its buttons |
| `CatalogCard.qml` | One compact marketplace card: preview, summary, state, metrics, details, and install |
| `PluginDetails.qml` | The popup's Browse details: full Marketplace metadata, trusted links, limitations, and keyboard actions |
| `ChoiceDialog.qml` | The modal that asks which one, where ConfirmDialog asks whether |
| `Model.js` | Pure parsing, merging, grouping, searching, and filtering |

## License

MIT — see [LICENSE](LICENSE).
