import QtQuick
import Quickshell
import Quickshell.Io
import "Model.js" as Model

// Everything the plugin manager knows and does, with no window attached: the
// installed rows and their update check, the marketplace catalog, and the
// commands that add, update, remove, enable and disable plugins.
//
// It exists so that more than one surface can show the same plugins. The bar
// popup and the expanded window are separate QML trees loaded by different
// hosts, and neither can reach into the other's state; each owns a store of
// its own instead and binds to it. Nothing here knows about selection,
// filters, dialogs or focus — those are decisions a surface makes, and the
// store only reports what happened through its signals.
//
// Every command runs as an argv array, never through a shell, so a repository
// url or a plugin id can never become a command. The scripts below take their
// variable parts as positional arguments for the same reason.
Item {
  id: root

  // ---- Installed plugins --------------------------------------------------

  property var rows: []
  property bool loading: false
  property string loadError: ""

  // Checked in the background after the rows are already on screen, so a
  // surface never waits on the network to show what is installed.
  property bool checkingUpdates: false
  readonly property int behindCount: Model.countBehind(rows)
  readonly property int installedTotal: Model.countRemovable(rows)

  // A Process is reusable only after both its exit and collector callbacks
  // have settled. The callbacks may arrive in either order, so `running` alone
  // is not enough to decide that a fresh load/check pair can safely start.
  property bool loadProcessExited: true
  property bool loadOutputFinished: true
  property bool updateProcessExited: true
  property bool updateOutputFinished: true
  property bool freshUpdateCycleQueued: false
  readonly property bool updateActionsEnabled:
    !busy && loadProcessSettled() && updateProcessSettled()

  // Held so a report that lands while the rows are being rebuilt is not lost.
  // Model.applyUpdateReport binds every replay to the freshly loaded checkout
  // HEAD, so an old generation can remain pending without regaining authority.
  property string pendingUpdateReport: ""

  // ---- Marketplace catalog ------------------------------------------------
  //
  // The catalog omarchyplugins.com publishes. Read from the disk cache first —
  // it is also what tells the Installed rows who is verified — and fetched
  // afresh on request.

  property var catalog: []
  readonly property var verifiedIds: Model.verifiedIdSet(catalog)
  property bool catalogLoading: false
  property bool catalogLoaded: false
  property string catalogError: ""

  // The registry's previews are WebP, which Qt only decodes when
  // qt6-imageformats is installed. Rather than probing for it, the first card
  // that fails tells us, and every card falls back to the registry's own
  // accent-and-initials tile from then on.
  property bool previewsSupported: true

  // ---- In-flight action ---------------------------------------------------

  property string busyKind: ""   // "add" | "update" | "remove"
  // Which row an update is running on, by id: busyId carries the label for
  // messages, and labels are not unique.
  property string busyRowId: ""
  property string busyId: ""
  readonly property bool busy: busyKind !== ""

  // Kept past the exit so a late stderr can still upgrade the message it
  // belongs to (see actionProc below).
  property string actionStderr: ""
  property string lastActionKind: ""
  property int lastExitCode: 0

  property string status: ""
  property bool statusIsError: false

  // ---- What a surface may want to know ------------------------------------

  // A load is starting, whoever asked for it — a surface that has something
  // in flight of its own (a release probe, say) can retire it here.
  signal reloadStarted()
  // The rows were replaced by a successful read; a selection index may now
  // point past the end.
  signal rowsLoaded()
  signal actionFinished(string kind, string label, int exitCode)

  // Installing something changes which cards should read "installed". Re-stamp
  // rather than rebuild: the catalog's sort and its fetch both survive.
  onRowsChanged: {
    if (catalog.length === 0) return
    var stampedState = Model.restampCatalogInstallState(
      catalog, Model.installedIdSet(rows), null)
    // Nothing changed, nothing assigned: a fresh array would reset the grid
    // and rebuild every visible card, right in the middle of an animation.
    if (!stampedState.changed) return
    catalog = stampedState.entries
  }

  // ---- Loading ------------------------------------------------------------

  function loadProcessSettled() {
    return !loadProc.running && root.loadProcessExited && root.loadOutputFinished
  }

  function updateProcessSettled() {
    return !updateProc.running && root.updateProcessExited && root.updateOutputFinished
  }

  function reload() {
    if (!root.loadProcessSettled()) return false
    root.loadProcessExited = false
    root.loadOutputFinished = false
    root.loading = true
    root.reloadStarted()
    loadProc.running = true
    return true
  }

  function applyLoad(raw) {
    loading = false

    var sections = Model.splitSections(raw)
    var listEntries = sections ? Model.parseArray(sections.list) : null
    if (!sections || !listEntries) {
      // Deliberately keep the rows we already have. An empty list would read
      // as "no plugins installed", which is a different and much scarier
      // claim than "could not read".
      loadError = "Could not read the plugin list"
      return
    }

    loadError = ""
    rows = Model.mergePlugins(
      listEntries,
      Model.parseArray(sections.catalog) || [],
      Model.parseGitMap(sections.git),
      Model.parseManifestMeta(sections.manifest))
    rowsLoaded()
    if (pendingUpdateReport !== "") applyUpdateReport(pendingUpdateReport)
  }

  // ---- Update checks ------------------------------------------------------

  function checkUpdates() {
    if (!root.updateProcessSettled()) return false
    root.updateProcessExited = false
    root.updateOutputFinished = false
    root.checkingUpdates = true
    updateProc.running = true
    return true
  }

  // A successful pull invalidates both snapshots. One bounded bit remembers
  // that debt while either old process settles; repeated requests coalesce.
  // The replacement load/check pair starts together only when both reusable
  // Process objects have completed both lifecycle callbacks.
  function requestFreshUpdateCycle() {
    root.freshUpdateCycleQueued = true
    root.drainFreshUpdateCycle()
  }

  function drainFreshUpdateCycle() {
    if (!root.freshUpdateCycleQueued
        || !root.loadProcessSettled() || !root.updateProcessSettled()) return false
    root.freshUpdateCycleQueued = false
    root.reload()
    root.checkUpdates()
    return true
  }

  function applyUpdateReport(raw) {
    checkingUpdates = false
    pendingUpdateReport = raw
    if (rows.length === 0) return
    rows = Model.applyUpdateReport(rows, Model.parseUpdateReport(raw))
  }

  // ---- Catalog ------------------------------------------------------------

  function loadCatalog(force) {
    if (catalogProc.running) return
    catalogLoading = true
    catalogError = ""
    catalogProc.command = ["bash", "-c", catalogScript, "catalog", force === true ? "1" : "0"]
    catalogProc.running = true
  }

  function applyCatalog(raw) {
    catalogLoading = false

    var doc = Model.parseCatalog(raw)
    if (!doc) {
      // Keep whatever was already on screen. An empty grid would claim the
      // marketplace has nothing in it.
      catalogError = "Could not read the plugin catalog"
      return
    }

    catalog = Model.catalogEntries(doc, Model.installedIdSet(rows))
    catalogLoaded = true
    catalogError = ""
  }

  // ---- Actions ------------------------------------------------------------

  function setStatus(text, isError) {
    status = text
    statusIsError = isError === true
  }

  function startDisable(row) {
    runDetached(Model.successMessage("disable", row.name),
                Model.disableNote(),
                Model.disableCommand(row))
  }

  // Detached, and announced through a notification rather than the status
  // line — for the same reason installing is. Switching a bar widget on or off
  // rewrites `bar.layout`; the bar rebuilds its widgets, and the popup is one
  // of them. It is gone before `onExited` could fire, so a status message here
  // is written to something nobody can read, and a Process owned by a
  // destroyed surface is not a safe place for the command itself either.
  function runDetached(summary, detail, command) {
    if (command.length === 0) return
    Quickshell.execDetached(["bash", "-c", noticeScript, "notice", summary, detail].concat(command))
    setStatus(summary, false)
  }

  function startEnable(row, section) {
    runDetached(Model.successMessage("enable", row.name),
                Model.enableNote(section),
                Model.enableCommand(row, section))
  }

  // Run a command, then say what happened where the answer will still exist:
  // $1 summary, $2 detail, and everything after that is the command itself,
  // passed as separate arguments so none of it is ever parsed as shell.
  readonly property string noticeScript: ""
    + "set -u -o pipefail; "
    + "summary=\"$1\"; detail=\"$2\"; shift 2; "
    + "if ! err=$(\"$@\" 2>&1 >/dev/null | tail -1); then "
    + "  notify-send -a 'Plugin Manager' \"$summary failed\" \"$err\"; exit 1; "
    + "fi; "
    + "notify-send -a 'Plugin Manager' \"$summary\" \"$detail\""

  // Clone, then place — as one detached command.
  //
  // Detached is not an optimisation, it is the requirement. The moment the
  // clone lands in ~/.config/omarchy/plugins the shell tears every plugin
  // widget down and rebuilds it, the popup among them, and a Process owned by
  // a destroyed surface cannot be relied on to finish. The placement would be
  // the half that got dropped.
  //
  // What is given up is the status line, which nobody was going to read on a
  // popup that no longer exists. The script reports through a desktop
  // notification instead, which outlives all of this.
  function startAdd(url, id, section, label) {
    // Positional arguments, never text spliced into the script, so no url can
    // become a command.
    Quickshell.execDetached(["bash", "-c", installScript, "install", url, id, section, label])
    setStatus(Model.actionGerund("add") + " " + label + "…", false)
  }

  // Update needs no confirmation: it is a fast-forward of a checkout the user
  // already chose to trust, and it destroys nothing. The gate is public so a
  // surface can decide whether a click is even a request before it retires
  // anything of its own on the strength of it.
  function canStartUpdate(row) {
    if (!row || !row.updatable || Model.upToDate(row) || busy
        || !root.loadProcessSettled() || !root.updateProcessSettled()) return false
    return true
  }

  function startUpdate(row) {
    if (!canStartUpdate(row)) return
    busyRowId = row.id
    runAction("update", row.name, ["omarchy", "plugin", "update", row.id, "--yes"])
  }

  function runAction(kind, label, command) {
    if (busy || actionProc.running) return
    busyKind = kind
    busyId = label
    setStatus("", false)
    actionStderr = ""
    actionProc.command = command
    actionProc.running = true
  }

  // ---- Processes ----------------------------------------------------------

  // One round trip for the whole picture: enabled state from `plugin list`,
  // source directories and descriptions from `plugin catalog`, which checkouts
  // a pull can reach from the filesystem, any exact manifest-version tag proven
  // at each checkout's HEAD, and the author and version each manifest declares.
  // The section markers print unconditionally so a failed command shows up as
  // unparseable output rather than as a silently short list.
  //
  // The catalog is fetched once and reused: it is also the only list of every
  // manifest path on the system, built-ins included, and running the command
  // twice would double the slowest step of the load.
  Process {
    id: loadProc
    command: ["bash", "-c",
      "catalog=$(omarchy plugin catalog); "
      + "printf '===list===\\n'; "
      + "omarchy plugin list --json; "
      + "printf '\\n===catalog===\\n'; "
      + "printf '%s' \"$catalog\"; "
      + "printf '\\n===git===\\n'; "
      + "for dir in \"$HOME\"/.config/omarchy/plugins/*/; do "
      + "  [ -d \"$dir/.git\" ] || continue; "
      + "  path=\"${dir%/}\"; "
      + "  version=$(jq -r '.version // \"\"' \"$path/manifest.json\" 2>/dev/null); "
      + "  head=$(git -C \"$path\" rev-parse HEAD 2>/dev/null); exact_tag=; "
      // Prefer the v-prefixed convention when both exact refs point at HEAD.
      // show-ref proves the literal ref exists before rev-list peels annotated
      // tags to the commit they name; neither command contacts the network.
      + "  if [ -n \"$version\" ] && [ -n \"$head\" ]; then "
      + "    for tag in \"v$version\" \"$version\"; do "
      + "      ref=\"refs/tags/$tag\"; "
      + "      git -C \"$path\" show-ref --verify --quiet \"$ref\" || continue; "
      + "      tag_commit=$(git -C \"$path\" rev-list -n 1 \"$ref\" 2>/dev/null); "
      + "      if [ -n \"$tag_commit\" ] && [ \"$tag_commit\" = \"$head\" ]; then exact_tag=$tag; break; fi; "
      + "    done; "
      + "  fi; "
      // JSON escaping keeps hostile path/remote bytes inside this one record;
      // they cannot forge another checkout or exact-tag field.
      + "  remote=$(git -C \"$path\" remote get-url origin 2>/dev/null); "
      + "  jq -cn --arg path \"$path\" --arg remote \"$remote\" --arg exactTag \"$exact_tag\" --arg headSha \"$head\" "
      + "    '{path: $path, remote: $remote, exactTag: $exactTag, headSha: $headSha}'; "
      + "done; "
      + "printf '\\n===manifest===\\n'; "
      // One jq over every manifest at once rather than one process per plugin.
      // Fields the manifest omits print as empty columns, which is what the
      // parser expects; a manifest that will not parse simply contributes no
      // line and its row falls back to the id namespace.
      + "printf '%s' \"$catalog\" | jq -r '.[].manifestPath // empty' "
      + "  | tr '\\n' '\\0' "
      + "  | xargs -0 -r jq -r '[.id, (.author // \"\"), (.version // \"\")] | @tsv' 2>/dev/null"
    ]
    stdout: StdioCollector {
      waitForEnd: true
      onStreamFinished: {
        root.applyLoad(text)
        root.loadOutputFinished = true
        root.drainFreshUpdateCycle()
      }
    }
    onExited: function(exitCode) {
      root.loadProcessExited = true
      root.drainFreshUpdateCycle()
    }
    onRunningChanged: if (!running) root.drainFreshUpdateCycle()
  }

  // Clone, wait for the shell to notice, then place. Upstream's own
  // `--enable` path cannot be used for this: it reads the section from an
  // interactive `gum choose` that returns immediately under `--yes`, so it
  // would land the widget in whatever section the author nominated. The panel
  // asks first and passes the answer through here instead.
  //
  // Everything variable arrives as a positional argument, never spliced into
  // the text: $1 url, $2 plugin id, $3 section (any of which may be empty).
  readonly property string installScript: ""
    // pipefail matters here: the error text is taken through `| tail -1`, and
    // without it the pipeline would report tail's exit status — which always
    // succeeds — and every failed install would be announced as a success.
    + "set -u -o pipefail; "
    + "url=\"$1\"; id=\"$2\"; section=\"$3\"; label=\"$4\"; "
    + "note() { notify-send -a 'Plugin Manager' \"$1\" \"$2\"; }; "
    // stderr is captured and stdout dropped, then reduced to its last line:
    // the omarchy scripts put the reason there, and a notification body is no
    // place for a git transcript.
    + "if ! err=$(omarchy plugin add \"$url\" --yes 2>&1 >/dev/null | tail -1); then "
    + "  note \"Could not install $label\" \"$err\"; exit 1; "
    + "fi; "
    // No id means the url field, which cannot know what it is about to clone.
    // The plugin is added and left off; its row carries an Enable button.
    + "if [ -z \"$id\" ]; then "
    + "  note \"Added $label\" 'Enable it from the plugin manager.'; exit 0; "
    + "fi; "
    // The shell rescans asynchronously and `omarchy plugin enable` fails
    // outright on an id it has not discovered yet — the same wait upstream
    // does before its own enable.
    + "for _ in $(seq 40); do "
    + "  omarchy plugin list --json | jq -e --arg id \"$id\" 'any(.[]; .id == $id)' >/dev/null 2>&1 && break; "
    + "  sleep 0.05; "
    + "done; "
    + "if ! err=$(omarchy plugin enable \"$id\" ${section:+\"$section\"} 2>&1 >/dev/null | tail -1); then "
    + "  note \"Added $label, but could not enable it\" \"$err\"; exit 1; "
    + "fi; "
    + "if [ -n \"$section\" ]; then note \"Installed $label\" \"Placed in the $section section of the bar.\"; "
    + "else note \"Installed $label\" 'Enabled.'; fi"

  // Fetch, join, shrink, cache. The catalog and its anonymous engagement stats
  // are separate Marketplace sources; jq joins hearts by plugin id while it
  // projects the large catalog down before any of it reaches the shell's JSON
  // parser. Missing stats stay null rather than becoming made-up zeroes. A
  // catalog fetch failure falls back to a compatible cached copy rather than
  // emptying the grid. The projection schema keeps a fresh legacy cache from
  // silently omitting fields the current UI requires.
  readonly property string catalogScript: ""
    + "set -u -o pipefail; "
    // The 8 MiB catalog ceiling is over 3x today's 2.4 MiB payload; the 1 MiB
    // stats ceiling is over 15x today's 67 KiB payload. The projection should
    // shrink the catalog, so the same 8 MiB ceiling leaves substantial growth
    // room while placing a hard bound on cache and shell-parser input.
    + "catalog_max=8388608; stats_max=1048576; projection_max=8388608; projection_schema=1; "
    + "dir=\"$HOME/.cache/omarchy-plugin-manager\"; file=\"$dir/catalog.json\"; "
    + "cache_usable() { local size; [ -s \"$file\" ] || return 1; "
    + "  size=$(stat -c %s -- \"$file\" 2>/dev/null) || return 1; [ \"$size\" -le \"$projection_max\" ] || return 1; "
    + "  jq -e --argjson schema \"$projection_schema\" '(.projectionSchemaVersion == $schema) and (.plugins | type == \"array\")' \"$file\" >/dev/null 2>&1; }; "
    + "mkdir -p \"$dir\"; "
    + "if [ \"$1\" != 1 ] && cache_usable; then "
    + "  age=$(( $(date +%s) - $(stat -c %Y \"$file\") )); "
    + "  if [ \"$age\" -lt 21600 ]; then cat \"$file\"; exit 0; fi; "
    + "fi; "
    + "catalog_tmp=$(mktemp); stats_tmp=$(mktemp); tmp=$(mktemp \"$dir/.catalog.json.tmp.XXXXXX\"); "
    + "cleanup_catalog() { rm -f \"$catalog_tmp\" \"$stats_tmp\" \"$tmp\"; }; trap cleanup_catalog EXIT; "
    + "curl -fsSL --max-time 25 --max-filesize \"$catalog_max\" " + Model.CATALOG_URL + " -o \"$catalog_tmp\" 2>/dev/null & catalog_pid=$!; "
    + "curl -fsSL --max-time 15 --max-filesize \"$stats_max\" " + Model.MARKETPLACE_STATS_URL + " -o \"$stats_tmp\" 2>/dev/null & stats_pid=$!; "
    + "wait \"$catalog_pid\"; catalog_status=$?; wait \"$stats_pid\"; stats_status=$?; "
    + "if [ \"$stats_status\" -ne 0 ] || ! jq -e '.plugins | type == \"object\"' \"$stats_tmp\" >/dev/null 2>&1; then "
    + "  printf '%s' '{\"plugins\":{}}' > \"$stats_tmp\"; "
    + "fi; "
    + "if [ \"$catalog_status\" -eq 0 ] "
    + "   && jq -c --argjson schema \"$projection_schema\" --slurpfile stats \"$stats_tmp\" '{projectionSchemaVersion: $schema, generatedAt, plugins: [.plugins[] as $plugin | $plugin | {id,name,description,author,version,category,tags,kind,repo,installCommand,installAvailable,installNote,verificationStatus,sourceType,stars,addedAt,listedAt,marketplaceHearts: ($stats[0].plugins[$plugin.id].hearts // null),accent,initials,license,previewThumbnail,listingValidatedBranch}]}' \"$catalog_tmp\" 2>/dev/null "
    // One sentinel byte distinguishes an exact-limit projection from an
    // oversized one; pipefail also rejects jq errors and its bounded SIGPIPE.
    + "      | head -c \"$((projection_max + 1))\" > \"$tmp\" "
    + "   && [ -s \"$tmp\" ] && [ \"$(stat -c %s -- \"$tmp\")\" -le \"$projection_max\" ]; then "
    + "  if mv \"$tmp\" \"$file\"; then cat \"$file\"; else exit 1; fi; "
    + "else "
    + "  if cache_usable; then cat \"$file\"; else exit 1; fi; "
    + "fi"

  // No fetch and no clone: ls-remote asks the remote for one sha and downloads
  // nothing, so eleven checkouts resolve in about a second. The manifest is
  // read only for the ones actually behind, pinned to the exact remote commit.
  readonly property string updateScript: ""
    + "set -u; export GIT_TERMINAL_PROMPT=0 GIT_ASKPASS=/bin/true; "
    + "tmpdir=; temp_root=; owner_prefix=; output_revoked=0; worker_sessions=(); "
    // Every worker is a session leader, so its trusted PID is also the exact
    // boundary containing git, timeout, curl, and any network descendants.
    // No caller or unrelated process can share that newly created session.
    + "terminate_workers() { output_revoked=1; "
    + "  for sid in \"${worker_sessions[@]}\"; do /usr/bin/pkill -TERM -s \"$sid\" 2>/dev/null || :; done; "
    + "  for sid in \"${worker_sessions[@]}\"; do /usr/bin/pkill -KILL -s \"$sid\" 2>/dev/null || :; done; "
    + "  for pid in \"${worker_sessions[@]}\"; do wait \"$pid\" 2>/dev/null || :; done; "
    + "  worker_sessions=(); }; "
    + "cleanup() { status=$?; trap - EXIT HUP INT TERM; "
    + "  if [ \"${#worker_sessions[@]}\" -gt 0 ]; then terminate_workers; fi; "
    + "  if [ -n \"$tmpdir\" ] && [ -n \"$temp_root\" ] && [ -n \"$owner_prefix\" ] "
    + "     && [ \"$temp_root\" != / ] && [ \"$tmpdir\" != \"$temp_root\" ]; then "
    + "    case \"$tmpdir\" in \"$temp_root\"/\"$owner_prefix\".*) rm -rf -- \"$tmpdir\" ;; esac; "
    + "  fi; exit \"$status\"; }; "
    + "signal_exit() { status=\"$1\"; trap - HUP INT TERM; terminate_workers; exit \"$status\"; }; "
    + "arm_signal_traps() { trap 'signal_exit 129' HUP; trap 'signal_exit 130' INT; trap 'signal_exit 143' TERM; }; "
    // Bash delivers traps between commands. During the two-command spawn/PID
    // append boundary, defer the exit until the new trusted session is stored.
    + "launch_worker() { pending_signal=0; "
    + "  trap 'pending_signal=129' HUP; trap 'pending_signal=130' INT; trap 'pending_signal=143' TERM; "
    + "  /usr/bin/setsid /usr/bin/bash -c 'set -u; update_worker \"$1\" \"$2\"' worker \"$1\" \"$2\" & "
    + "  worker_sessions+=(\"$!\"); arm_signal_traps; "
    + "  if [ \"$pending_signal\" -ne 0 ]; then signal_exit \"$pending_signal\"; fi; }; "
    + "trap 'cleanup' EXIT; arm_signal_traps; "
    + "umask 077; owner_token=; IFS= read -r owner_token < /proc/sys/kernel/random/uuid 2>/dev/null || owner_token=; "
    + "case \"$owner_token\" in ''|*[!0-9a-f-]*) owner_token=\"${RANDOM}${RANDOM}${RANDOM}${RANDOM}\" ;; esac; "
    + "owner_prefix=\"omarchy-plugin-manager-updates.$$.$owner_token\"; "
    + "make_tmpdir() { temp_root=\"$1\"; attempt=0; "
    + "  while [ \"$attempt\" -lt 8 ]; do tmpdir=\"$temp_root/$owner_prefix.$attempt\"; "
    + "    if mkdir -m 700 -- \"$tmpdir\" 2>/dev/null; then return 0; fi; "
    + "    tmpdir=; attempt=$((attempt + 1)); "
    + "  done; temp_root=; return 1; }; "
    + "xdg_root=\"${XDG_RUNTIME_DIR:-}\"; xdg_mode=; "
    + "if [ -n \"$xdg_root\" ]; then xdg_mode=$(stat -c %a -- \"$xdg_root\" 2>/dev/null); fi; "
    + "if [ -n \"$xdg_root\" ] && [ \"${xdg_root#/}\" != \"$xdg_root\" ] && [ \"$xdg_root\" != / ] "
    + "   && [ -d \"$xdg_root\" ] && [ -w \"$xdg_root\" ] && [ -x \"$xdg_root\" ] "
    + "   && [ -O \"$xdg_root\" ] && [ ! -L \"$xdg_root\" ] && [ \"$xdg_mode\" = 700 ] "
    + "   && make_tmpdir \"$xdg_root\"; then :; "
    + "elif [ -d /tmp ] && [ -w /tmp ] && [ -x /tmp ] && make_tmpdir /tmp; then :; "
    + "else exit 1; fi; "
    + "update_worker() { path=\"$1\"; outfile=\"$2\"; "
    + "  branch=$(git -C \"$path\" rev-parse --abbrev-ref HEAD 2>/dev/null); "
    + "  local_sha=$(git -C \"$path\" rev-parse HEAD 2>/dev/null); "
    + "  remote_sha=$(timeout 12 git -C \"$path\" ls-remote origin \"refs/heads/$branch\" 2>/dev/null | cut -f1); "
    + "  local_version=$(jq -r '.version // \"\"' \"$path/manifest.json\" 2>/dev/null); "
    + "  remote_version=\"\"; "
    + "  if [ -n \"$remote_sha\" ] && [ \"$remote_sha\" != \"$local_sha\" ]; then "
    + "    origin=$(git -C \"$path\" remote get-url origin 2>/dev/null); "
    + "    case \"$origin\" in https://github.com/*) "
    + "      slug=${origin#https://github.com/}; slug=${slug%.git}; "
    + "      remote_version=$(curl -fsSL --max-time 8 \"https://raw.githubusercontent.com/$slug/$remote_sha/manifest.json\" 2>/dev/null | jq -r '.version // \"\"' 2>/dev/null); "
    + "    ;; esac; "
    + "  fi; "
    + "  jq -cn --arg path \"$path\" --arg localSha \"$local_sha\" --arg remoteSha \"$remote_sha\" "
    + "    --arg localVersion \"$local_version\" --arg remoteVersion \"$remote_version\" "
    + "    '{path: $path, localSha: $localSha, remoteSha: $remoteSha, localVersion: $localVersion, remoteVersion: $remoteVersion}' "
    + "    > \"$outfile.tmp\" && mv -- \"$outfile.tmp\" \"$outfile.json\"; "
    + "}; export -f update_worker; "
    + "index=0; "
    + "for dir in \"$HOME\"/.config/omarchy/plugins/*/; do "
    + "  [ -d \"$dir/.git\" ] || continue; "
    // A numeric producer-owned filename keeps untrusted paths out of the
    // filesystem protocol. Workers publish by atomic rename only after jq has
    // completed one record; the parent emits those records after every remote
    // check has finished, so even versions far above pipe atomicity cannot
    // interleave.
    + "  outfile=\"$tmpdir/$index\"; index=$((index + 1)); "
    + "  launch_worker \"${dir%/}\" \"$outfile\"; "
    + "done; "
    + "while [ \"${#worker_sessions[@]}\" -gt 0 ]; do "
    + "  pid=\"${worker_sessions[0]}\"; wait \"$pid\" || :; worker_sessions=(\"${worker_sessions[@]:1}\"); "
    + "done; [ \"$output_revoked\" -eq 0 ] || exit 1; "
    + "payload=; i=0; while [ \"$i\" -lt \"$index\" ]; do "
    + "  file=\"$tmpdir/$i.json\"; if [ -s \"$file\" ]; then "
    + "    record=$(cat -- \"$file\"); payload+=\"$record\"$'\\n'; "
    + "  fi; i=$((i + 1)); "
    + "done; [ \"$output_revoked\" -eq 0 ] || exit 1; "
    // Once committed, publish through one shell builtin. Bash defers traps
    // until the builtin returns, so cancellation observes either no batch or
    // the complete batch, never an interruptible sequence of external cats.
    + "trap '' HUP INT TERM; printf '%s' \"$payload\""

  Process {
    id: updateProc
    command: ["bash", "-c", root.updateScript]
    stdout: StdioCollector {
      waitForEnd: true
      onStreamFinished: {
        root.applyUpdateReport(text)
        root.updateOutputFinished = true
        root.drainFreshUpdateCycle()
      }
    }
    onExited: function(exitCode) {
      root.checkingUpdates = false
      root.updateProcessExited = true
      root.drainFreshUpdateCycle()
    }
    onRunningChanged: if (!running) root.drainFreshUpdateCycle()
  }

  Process {
    id: catalogProc
    stdout: StdioCollector {
      waitForEnd: true
      onStreamFinished: root.applyCatalog(text)
    }
    onExited: function(exitCode) {
      if (exitCode === 0) return
      root.catalogLoading = false
      root.catalogError = "Could not reach omarchyplugins.com"
    }
  }

  Process {
    id: actionProc
    stdout: StdioCollector { waitForEnd: true }

    // Exit and stream-finished have no guaranteed order. When a failed exit
    // beats the collector it publishes the exit-code message; the specific
    // one replaces it once stderr lands.
    stderr: StdioCollector {
      waitForEnd: true
      onStreamFinished: {
        root.actionStderr = String(text || "").trim()
        if (root.statusIsError && root.actionStderr !== "")
          root.setStatus(Model.failureMessage(root.lastActionKind, root.actionStderr, root.lastExitCode), true)
      }
    }

    onExited: function(exitCode) {
      var kind = root.busyKind
      var label = root.busyId

      root.lastActionKind = kind
      root.lastExitCode = exitCode
      root.busyKind = ""
      root.busyId = ""
      root.busyRowId = ""

      if (exitCode === 0) {
        root.setStatus(Model.successMessage(kind, label), false)
        if (kind === "update") {
          // The successful pull invalidates the old report immediately. Load
          // and the fresh check may finish in either order; HEAD equality makes
          // both orders deterministic without serializing the processes.
          root.pendingUpdateReport = ""
          root.rows = Model.applyUpdateReport(root.rows, {})
        }
      } else {
        root.setStatus(Model.failureMessage(kind, root.actionStderr, exitCode), true)
      }

      if (exitCode === 0 && kind === "update") root.requestFreshUpdateCycle()
      else root.reload()
      root.actionFinished(kind, label, exitCode)
    }
  }

}
