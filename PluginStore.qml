import QtQuick
import QtQml.WorkerScript
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
  // One retry per load attempt; cleared by the next successful read.
  property bool loadRetried: false
  // Set by loadOnOpen(): the catalog and the update check wait until the
  // list has landed. The catalog parse holds the main thread for seconds in
  // QML, and the list read needs the shell to answer an IPC call in that
  // same window; run together, the list came back empty.
  property bool openLoadPending: false

  // ---- Marketplace catalog ------------------------------------------------
  //
  // The catalog omarchyplugins.com publishes. Read from the disk cache first —
  // it is also what tells the Installed rows who is verified — and fetched
  // afresh on request.

  property var catalog: []
  readonly property var verifiedIds: Model.verifiedIdSet(catalog)
  readonly property var starsById: Model.catalogStarsById(catalog)
  property bool catalogLoading: false
  property bool catalogLoaded: false
  property string catalogError: ""

  // The registry's previews are WebP, which Qt only decodes when
  // qt6-imageformats is installed. Rather than probing for it, the first card
  // that fails tells us, and every card falls back to the registry's own
  // accent-and-initials tile from then on.
  property bool previewsSupported: true

  // ---- In-flight action ---------------------------------------------------

  property string busyKind: ""   // "install" | "update" | "remove"
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

  // ---- Pending confirmation -----------------------------------------------
  //
  // What is being asked, and about which plugin. Shared here rather than in
  // each surface because the popup and the expanded window ask the very same
  // questions with the very same answers; only the dialogs that put the
  // question on screen belong to the surface.

  // The plugin id of the surface using this store. Disabling that one plugin
  // takes the surface down with it, which is the single disable that needs a
  // warning before it runs.
  property string selfId: ""

  // The scoped shell API of the surface that owns this store, when it has
  // one (the expanded window). It is the sanctioned way to write this
  // plugin's inline shell.json entry; a surface without it can only read.
  property var shell: null

  // This plugin's own inline shell.json entry, as the loader printed it.
  // Read here rather than from the shell API because both surfaces need it,
  // the popup has no shell API of its own, and shell.json is already what the
  // store watches: a write goes through the host, the host rewrites the
  // file, the watcher reloads, and every surface sees the same value.
  // Two views of that entry: `selfEntry` is the whole thing, kept so a write
  // can hand every key back to the host (updateEntryInline replaces the
  // entry, it does not merge); `selfSettings` is the strict view the panel
  // reads. `selfEntryLoaded` says the last load actually produced the entry:
  // until it has, or after a failed load, there is nothing safe to write
  // over, so the switch refuses rather than rewriting the entry from nothing.
  property var selfEntry: ({})
  property bool selfEntryLoaded: false
  property var selfSettings: ({})
  readonly property bool allowUnverifiedUpdates: Model.allowUnverifiedUpdates(selfSettings)
  onAllowUnverifiedUpdatesChanged: rows = Model.applyPinnedUpdates(rows, catalog, allowUnverifiedUpdates)

  // Installing code nobody reviewed is a different decision from updating to
  // it, so it is a different key. Flipping it re-stamps the cards already on
  // screen: the answer is derived from data the panel is holding, and making
  // the user wait on a refetch for it would be theatre.
  readonly property bool allowUnverifiedInstalls: Model.allowUnverifiedInstalls(selfSettings)
  onAllowUnverifiedInstallsChanged: restampCatalog()

  // Persist one setting through the host, merged over the entry as it was
  // loaded. The local copies move only when the host accepted the write; the
  // watcher reload then confirms it on every surface. `current` is the value
  // in force, so asking for what is already set is a no-op rather than a write.
  function writeSelfSetting(key, value, current) {
    var want = value === true
    if (want === current) return true
    if (!selfEntryLoaded || !selfEntry) {
      setStatus("Settings unavailable until the plugin list loads", true)
      return false
    }
    if (!shell || typeof shell.updateEntryInline !== "function" || selfId === "") {
      setStatus("Could not save the setting: no shell connection", true)
      return false
    }
    var next = Model.withSelfSetting(selfEntry, key, want)
    if (shell.updateEntryInline(selfId, next) !== true) {
      setStatus("Could not save the setting", true)
      return false
    }
    selfEntry = next
    selfSettings = Model.parseSelfSettings(JSON.stringify(next))
    return true
  }

  function setAllowUnverifiedUpdates(value) {
    return writeSelfSetting("allowUnverifiedUpdates", value, allowUnverifiedUpdates)
  }

  function setAllowUnverifiedInstalls(value) {
    return writeSelfSetting("allowUnverifiedInstalls", value, allowUnverifiedInstalls)
  }

  property string pendingKind: ""
  property string pendingId: ""
  property string pendingLabel: ""
  property string pendingUrl: ""
  // The one commit an open install question names, so the answer can be held
  // to exactly that snapshot when the catalog has moved on underneath it.
  property string pendingVerifiedCommit: ""
  // The branch an open unreviewed install question names, for the same reason:
  // there is no commit to hold it to until the helper resolves one.
  property string pendingBranch: ""
  readonly property bool confirming: pendingKind !== "" && pendingKind !== "place" && pendingKind !== "move"

  // Enabling a bar widget is a different question from the yes/no ones above:
  // not "are you sure" but "where". It gets its own dialog rather than a
  // default section, because a widget dropped into a section the user did not
  // choose is a widget they have to go hunting for.
  readonly property bool placing: pendingKind === "place" || pendingKind === "move"

  // The section a widget being moved sits in now, so the question can leave
  // that one out. Held with the rest of the pending state.
  property string pendingSection: ""

  // Whether the plugin being added takes a place in the bar. Read off the
  // registry listing, since the manifest that would say so is not on disk yet.
  property bool pendingPlacementNeeded: false

  // The section chosen for a plugin that is not installed yet. Held from the
  // moment the question is answered until the install command is built, since
  // by the time the clone lands the surface no longer exists to be asked.
  property string pendingPlacement: ""

  readonly property var placementChoices: pendingKind === "move"
    ? Model.moveOptions(pendingSection) : Model.placementOptions()
  readonly property string placementMessage: pendingKind === "move"
    ? "Move " + pendingLabel + " to which section of the bar?"
    : "Where in the bar should " + pendingLabel + " go?"

  // Only an unreviewed update enters a dialog, and it offers the exact diff.
  readonly property string confirmCompareUrl: pendingKind === "update"
    ? Model.updateCompareUrl(Model.findRow(rows, pendingId)) : ""

  readonly property string confirmMessage: {
    if (pendingKind === "install" && pendingBranch !== "")
      return Model.installUnverifiedConfirmMessage(pendingLabel, pendingUrl, pendingBranch, pendingPlacementNeeded)
    if (pendingKind === "install")
      return "Install " + pendingLabel + "?\n\n"
        + pendingUrl + "\n\n"
        // Exactly what lands on disk: the reviewed commit, not whatever the
        // branch points at now. Stated as a review rather than a guarantee —
        // a badge that reads as a safety promise is worse than no badge,
        // because it retires the judgement the next sentence is asking for.
        + "Only the marketplace-verified snapshot " + Model.shortSha(pendingVerifiedCommit)
        + " is installed, never the repository's current tip. Verification is a review and not a guarantee. "
        + "Plugins run unsandboxed inside omarchy-shell. Only add repositories whose code you are willing to run."
        + Model.catalogPlacementConfirmationNote(pendingPlacementNeeded)
    if (pendingKind === "remove")
      return "Remove " + pendingLabel + "?\n\nIts folder under ~/.config/omarchy/plugins is deleted."
    if (pendingKind === "update")
      return Model.updateUnverifiedConfirmMessage(pendingLabel, Model.findRow(rows, pendingId))
    if (pendingKind === "disable")
      return "Disable " + pendingLabel + "?\n\n"
        + "This is the panel you are looking at. It leaves the bar and this window closes with it — "
        + "nothing is uninstalled, but you will need a terminal to put it back:\n\n"
        + "omarchy plugin enable " + selfId + " right"
    return ""
  }

  // ---- What a surface may want to know ------------------------------------

  // A load is starting, whoever asked for it — a surface that has something
  // in flight of its own (a release probe, say) can retire it here.
  signal reloadStarted()
  // The rows were replaced by a successful read; a selection index may now
  // point past the end.
  signal rowsLoaded()
  signal actionFinished(string kind, string label, int exitCode)

  // Installing something changes which cards should read "installed", and the
  // install opt-in changes which are offered at all. Re-stamp rather than
  // rebuild: the catalog's sort and its fetch both survive.
  onRowsChanged: restampCatalog()

  function restampCatalog() {
    if (catalog.length === 0) return
    var stampedState = Model.restampCatalogInstallState(
      catalog, Model.installedIdSet(rows), null, allowUnverifiedInstalls)
    // Nothing changed, nothing assigned: a fresh array would reset the grid
    // and rebuild every visible card, right in the middle of an animation.
    if (!stampedState.changed) return
    catalog = stampedState.entries
  }

  onCatalogChanged: rows = Model.applyPinnedUpdates(rows, catalog, allowUnverifiedUpdates)

  // ---- Loading ------------------------------------------------------------

  function loadProcessSettled() {
    return !loadProc.running && root.loadProcessExited && root.loadOutputFinished
  }

  function updateProcessSettled() {
    return !updateProc.running && root.updateProcessExited && root.updateOutputFinished
  }

  function loadOnOpen() {
    openLoadPending = true
    reload()
  }

  function finishOpenLoad() {
    if (!openLoadPending) return
    openLoadPending = false
    checkUpdates()
    if (!catalogLoaded && !catalogLoading) loadCatalog(false)
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
      // `omarchy plugin list` asks the shell itself over IPC, and a shell that
      // is busy — starting up, or building the expanded overlay — answers
      // with nothing. One bounded retry turns that into a slightly later
      // success instead of a spurious error.
      if (!loadRetried) {
        loadRetried = true
        loading = true
        loadRetry.start()
        return
      }
      // Deliberately keep the rows we already have. An empty list would read
      // as "no plugins installed", which is a different and much scarier
      // claim than "could not read".
      loadError = "Could not read the plugin list"
      // The entry may have changed under a load that failed; do not write
      // over it from a stale copy.
      selfEntryLoaded = false
      finishOpenLoad()
      return
    }

    loadError = ""
    loadRetried = false
    // A null entry is one the loader printed but this code could not read
    // (oversized or not one JSON object): the setting stays off and the
    // switch refuses to write until a later load reads it whole.
    selfEntry = Model.parseSelfEntry(sections.settings)
    selfEntryLoaded = selfEntry !== null
    selfSettings = Model.parseSelfSettings(sections.settings)
    var merged = Model.mergePlugins(
      listEntries,
      Model.parseArray(sections.catalog) || [],
      Model.parseGitMap(sections.git),
      Model.parseManifestMeta(sections.manifest),
      Model.parseLayoutSections(sections.layout))
    // The last report is replayed onto the fresh rows before they are
    // assigned, not after: every assignment rebuilds every row on every
    // surface, and the replay is the same rows with badges. It binds to the
    // freshly loaded HEAD as before, so a stale report still says nothing.
    if (pendingUpdateReport !== "")
      merged = Model.applyUpdateReport(merged, Model.parseUpdateReport(pendingUpdateReport))
    rows = Model.applyPinnedUpdates(merged, catalog, allowUnverifiedUpdates)
    rowsLoaded()
    finishOpenLoad()
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
    rows = Model.applyPinnedUpdates(Model.applyUpdateReport(rows, Model.parseUpdateReport(raw)), catalog, allowUnverifiedUpdates)
  }

  // ---- Catalog ------------------------------------------------------------

  // The helper owns the cache: it opens ~/.cache/omarchy-plugin-manager by
  // owner-checked no-follow descriptors, reads the projection through them
  // and publishes a fresh one with a descriptor-relative rename, so nothing
  // here names a cache path a symlink could redirect. Same scrubbed
  // environment as the transactions; the helper takes its home from passwd.
  function loadCatalog(force) {
    if (catalogProc.running) return
    catalogLoading = true
    catalogError = ""
    catalogProc.command = ["/usr/bin/env", "-i", "--", "PATH=/usr/bin:/bin",
      "/usr/bin/python3", "-I", "-S", pinnedHelperPath,
      JSON.stringify({ schemaVersion: 1, catalog: { force: force === true } })]
    catalogProc.running = true
  }

  // Parsing 2MB of catalog JSON and sanitising every field of 2150 entries
  // takes seconds in QML's engine, and on the main thread those seconds are
  // ones in which the shell answers no IPC at all — including the call that
  // reads the plugin list. The build runs on a worker thread instead; each
  // request is numbered so a reply overtaken by a newer request is dropped.
  property int catalogGeneration: 0

  WorkerScript {
    id: catalogWorker
    source: "CatalogWorker.js"
    onMessage: function(message) { root.applyCatalogResult(message) }
  }

  function applyCatalog(raw) {
    catalogGeneration += 1
    catalogWorker.sendMessage({
      generation: catalogGeneration,
      raw: raw,
      installedIds: Object.keys(Model.installedIdSet(rows))
    })
  }

  function applyCatalogResult(message) {
    if (!message || message.generation !== catalogGeneration) return
    catalogLoading = false
    if (!message.entries) {
      // Keep whatever was already on screen. An empty grid would claim the
      // marketplace has nothing in it.
      catalogError = message.error || "Could not read the plugin catalog"
      return
    }
    catalog = message.entries
    catalogLoaded = true
    catalogError = ""
    // The worker knows nothing about this plugin's own settings, so it builds
    // every entry with the install opt-in off. One re-stamp here is what makes
    // a fresh fetch agree with the switch; it assigns nothing when it is off.
    restampCatalog()
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

  // ---- Asking -------------------------------------------------------------
  //
  // Each ask returns whether the request was taken. A surface uses that to do
  // only its own bookkeeping — close a details view, retire a link probe —
  // and only for a request that was real, so a click on a greyed button never
  // costs anything.

  // Installing from the catalog runs the bundled helper on one reviewed
  // commit — the registry's own install command is read for its url, shown,
  // and never executed. Under the install opt-in a listing the marketplace
  // never reviewed offers its validated branch instead, and the helper
  // resolves that branch to one commit and pins it.
  function askInstall(entry) {
    // Fail closed on the snapshot too: `installable` is derived from it, and
    // the confirmation is about to name what it carries.
    if (!entry || !entry.installable || busy) return false
    var unreviewed = entry.installUnverified === true
    // The setting is re-read here rather than taken from the stamp on the
    // entry, which a re-stamp may not have caught up with yet.
    if (unreviewed && !allowUnverifiedInstalls) return false
    var snapshot = unreviewed ? entry.unverifiedSnapshot : entry.updateSnapshot
    if (!snapshot) return false
    // The url the question shows is the repository the request fetches, not
    // the registry's free-text install command: a dialog that named a
    // different place than the one being cloned would be worse than silent.
    pendingUrl = String(snapshot.repository)
    pendingLabel = entry.name
    pendingId = entry.id
    pendingBranch = unreviewed ? String(snapshot.branch) : ""
    pendingVerifiedCommit = unreviewed ? "" : String(snapshot.verifiedCommit)
    pendingPlacementNeeded = Model.catalogNeedsPlacement(entry)
    pendingKind = "install"
    return true
  }

  function askRemove(row) {
    if (!row || !row.removable || busy) return false
    pendingId = row.id
    pendingLabel = row.name
    pendingUrl = ""
    pendingKind = "remove"
    return true
  }

  // Enabling is not destructive and needs no "are you sure" — but a bar widget
  // has to be told where it goes, and only the user knows that.
  function askEnable(row) {
    if (!Model.canEnable(row) || busy) return false

    if (!Model.needsPlacement(row)) {
      // A service, an overlay, or a whole-bar plugin: nothing to place, so the
      // question would have exactly one answer.
      startEnable(row, "")
      return true
    }

    pendingId = row.id
    pendingLabel = row.name
    pendingUrl = ""
    pendingKind = "place"
    return true
  }

  // Disabling takes a widget out of the bar and leaves it on disk, so it is
  // reversible from the row it just greyed out — no confirmation needed. With
  // one exception: the surface's own row, whose Enable button leaves with it.
  function askDisable(row) {
    if (!Model.canDisable(row) || busy) return false

    if (row.id === selfId) {
      pendingId = row.id
      pendingLabel = row.name
      pendingUrl = ""
      pendingKind = "disable"
      return true
    }

    startDisable(row)
    return true
  }

  // A widget already in the bar can change section. It asks the same
  // "where" question the enable switch does, minus the section it is in, and
  // the move itself is the enable command with a section: the shell moves a
  // placed widget rather than adding it twice (PluginRegistry.setEnabled).
  function askMove(row) {
    if (!Model.canMove(row) || busy) return false
    pendingId = row.id
    pendingLabel = row.name
    pendingUrl = ""
    pendingSection = String(row.barSection || "")
    pendingKind = "move"
    return true
  }

  // The direct form, for a control that already names the target section.
  // Detached like enable and disable: the layout rewrite rebuilds the bar's
  // widgets, the popup among them, so the answer goes to a notification.
  function startMoveTo(row, section) {
    if (busy) return false
    var command = Model.moveCommand(row, section)
    if (command.length === 0) return false
    runDetached(Model.successMessage("move", row.name), Model.moveNote(section), command)
    return true
  }

  function confirmPlacement(section) {
    // Three questions share this dialog: where to put a plugin being
    // installed, where to put one already sitting in the list switched off,
    // and where to move one that is already in the bar.
    if (pendingPlacementNeeded) {
      startAdd(section)
      return
    }
    if (pendingKind === "move") {
      var moving = Model.findRow(rows, pendingId)
      var movingLabel = pendingLabel
      cancelPending()
      if (!moving) {
        setStatus("Could not move " + movingLabel + ": it is no longer in the list", true)
        return
      }
      startMoveTo(moving, section)
      return
    }

    var row = Model.findRow(rows, pendingId)
    var label = pendingLabel
    cancelPending()
    if (!row) {
      // The list was reloaded out from under the question — enabling a row
      // that is no longer there would either fail or, worse, hit whatever now
      // carries that id.
      setStatus("Could not enable " + label + ": it is no longer in the list", true)
      return
    }
    startEnable(row, section)
  }

  function cancelPending() {
    pendingKind = ""
    pendingUnverifiedSha = ""
    pendingVerifiedCommit = ""
    pendingBranch = ""
    pendingSection = ""
    pendingId = ""
    pendingLabel = ""
    pendingUrl = ""
    pendingPlacementNeeded = false
  }

  // Confirmation answered. A bar widget still owes us one more answer, and it
  // has to be collected now: cloning a plugin makes the shell rebuild every
  // plugin widget, the surfaces included, so there is no "after the install"
  // in which to ask anything.
  function confirmPending() {
    if (pendingKind === "disable") {
      var row = Model.findRow(rows, pendingId)
      cancelPending()
      if (row) startDisable(row)
      return
    }
    if (pendingKind === "update") {
      // Re-gated on the live row: the list may have reloaded, the check may
      // have moved the tip, or the setting may have been switched off while
      // the question was on screen. Only the exact commit the dialog named
      // is ever installed; anything else is a no-op, never a substitute.
      var target = Model.findRow(rows, pendingId)
      var expected = pendingUnverifiedSha
      cancelPending()
      if (!target || target.unverifiedEligible !== true || target.remoteSha !== expected
          || !canStartUpdate(target)) return
      runUpdate(target)
      return
    }
    if (pendingKind === "install") {
      if (pendingId !== "" && pendingPlacementNeeded) {
        pendingKind = "place"
        return
      }
      startAdd("")
    } else if (pendingKind === "remove") {
      runAction("remove", pendingLabel, ["omarchy", "plugin", "remove", pendingId, "--yes"])
      cancelPending()
    }
  }

  // Install, then place — one helper request built from the answers collected
  // above. The pending state is cleared first: by the time the checkout lands
  // the surface no longer exists to clear anything.
  //
  // Re-gated on the live catalog and on the setting, exactly as an update is:
  // the grid may have refetched and the switch may have gone off while the
  // question was on screen. Only what the dialog named is ever installed; a
  // snapshot or a branch that moved is a no-op, never a substitute.
  function startAdd(section) {
    var id = pendingId
    var label = pendingLabel
    var commit = pendingVerifiedCommit
    var branch = pendingBranch
    cancelPending()
    var entry = Model.findRow(catalog, id)
    var request = Model.installRequest(entry, section, allowUnverifiedInstalls)
    if (!request || String(request.verifiedCommit || "") !== commit
        || String(request.branch || "") !== branch) {
      setStatus("Could not install " + label + ": the listing changed", true)
      return
    }
    launchInstall(request, label)
  }

  // Detached is not an optimisation, it is the requirement. The moment the
  // checkout lands in ~/.config/omarchy/plugins the shell tears every plugin
  // widget down and rebuilds it, the popup among them, and a Process owned by
  // a destroyed surface cannot be relied on to finish. The helper forks an
  // independent worker before it touches the plugin root, so publication and
  // placement finish whatever happens to this observer; only the result can
  // be lost, and a desktop notification covers that.
  function launchInstall(request, label) {
    if (busy || pinnedProc.running || actionProc.running) return
    busyRowId = ""
    busyId = label
    busyKind = "install"
    pinnedOutput = ""
    pinnedExited = false
    pinnedOverflow = false
    setStatus(request.branch
      ? "Installing the unreviewed tip of " + label
        + "; closing this window does not cancel it"
      : "Installing the verified snapshot of " + label
        + "; closing this window does not cancel it", false)
    // Process.command is QStringList; avoid the environment property's
    // QVariantHash binding, which this installed QML toolchain cannot type.
    pinnedProc.command = ["/usr/bin/env", "-i", "--", "PATH=/usr/bin:/bin",
      "WAYLAND_DISPLAY=" + String(Quickshell.env("WAYLAND_DISPLAY") || ""),
      "/usr/bin/python3", "-I", "-S", pinnedHelperPath, JSON.stringify(request)]
    pinnedProc.running = true
  }

  // The commit an open unreviewed-update question names, so the answer can
  // be held to exactly that commit.
  property string pendingUnverifiedSha: ""

  // The request a row's Update would send: the verified snapshot when one is
  // installable, otherwise the observed unreviewed tip if the user's setting
  // allows it, otherwise nothing. Cached catalog data chooses the request,
  // never authorizes publication; the helper rechecks a verified one.
  function updateRequest(row) {
    if (!row) return null
    if (row.pinnedEligible === true) return Model.pinnedRequest(row, catalogLoaded ? catalog : null)
    if (row.unverifiedEligible === true && allowUnverifiedUpdates) return Model.unverifiedRequest(row)
    return null
  }

  // All entry points bind the displayed tuple, even programmatic callers.
  function canStartUpdate(row) {
    if (!row || busy || pinnedProc.running
        || !root.loadProcessSettled() || !root.updateProcessSettled()) return false
    var current = Model.findRow(rows, row.id)
    var request = updateRequest(row)
    if (!current || !request || current.headSha !== row.headSha
        || current.updateOrigin !== row.updateOrigin) return false
    if (row.pinnedEligible === true)
      return row.verifiedTargetSha === request.verifiedCommit && current.pinnedEligible === true
    return current.unverifiedEligible === true && current.remoteSha === request.unverifiedCommit
  }

  // A verified snapshot installs on the click. An unreviewed commit asks
  // first, naming the exact commit, with the diff one click away.
  function startUpdate(row) {
    if (!canStartUpdate(row)) return
    if (row.pinnedEligible === true) {
      runUpdate(row)
      return
    }
    pendingId = row.id
    pendingLabel = row.name
    pendingUrl = ""
    pendingUnverifiedSha = row.remoteSha
    pendingKind = "update"
  }

  readonly property string pinnedHelperPath:
    decodeURIComponent(Qt.resolvedUrl("helpers/pinned_update.py").toString().replace(/^file:\/\//, ""))
  property string pinnedOutput: ""
  property bool pinnedExited: false
  property bool pinnedOverflow: false

  function runUpdate(row) {
    if (!canStartUpdate(row) || actionProc.running) return
    var request = updateRequest(row)
    busyRowId = row.id
    busyId = row.name
    busyKind = "update"
    pinnedOutput = ""
    pinnedExited = false
    pinnedOverflow = false
    setStatus((request.verifiedCommit ? "Installing the verified snapshot" : "Installing unreviewed commit " + Model.shortSha(request.unverifiedCommit))
      + "; closing this window does not cancel it", false)
    // Process.command is QStringList; avoid the environment property's
    // QVariantHash binding, which this installed QML toolchain cannot type.
    pinnedProc.command = ["/usr/bin/env", "-i", "--", "PATH=/usr/bin:/bin",
      "WAYLAND_DISPLAY=" + String(Quickshell.env("WAYLAND_DISPLAY") || ""),
      "/usr/bin/python3", "-I", "-S", pinnedHelperPath, JSON.stringify(request)]
    pinnedProc.running = true
  }

  // Both helper shapes land here: the same bounded result, the same statuses
  // read from a fixed list, and the same refusal to report anything the
  // helper did not say. Only the words differ.
  function finishPinnedUpdate() {
    if (!pinnedExited || (busyKind !== "update" && busyKind !== "install")) return
    var installing = busyKind === "install"
    var done = installing ? "installed" : "updated"
    var outcome = "outcome unknown; inspect retained transactions"
    var reason = ""
    try {
      var result = JSON.parse(pinnedOutput)
      var allowed = installing
        ? ["installed", "installed; reload failed", "installed; enable failed",
           "installed; finalization failed", "unchanged; install refused", "unchanged; request refused"]
        : ["updated", "updated; reload failed", "updated; finalization failed",
           "unchanged; update refused", "unchanged; request refused"]
      if (!pinnedOverflow && result && allowed.indexOf(result.status) >= 0) {
        outcome = result.status
        // The helper's own static prose; still bounded to printable ASCII here.
        if (typeof result.reason === "string")
          reason = result.reason.replace(/[^\x20-\x7e]/g, "").slice(0, 200)
      }
    } catch (error) {}
    var changed = outcome.indexOf(done) === 0
    var kind = busyKind
    var label = busyId
    busyKind = ""
    busyId = ""
    busyRowId = ""
    pinnedOutput = ""
    setStatus(outcome.indexOf("unchanged") === 0 && reason !== "" ? outcome + ": " + reason : outcome,
              outcome !== done)
    if (changed) {
      if (!installing) {
        pendingUpdateReport = ""
        rows = Model.applyPinnedUpdates(Model.applyUpdateReport(rows, {}), null, allowUnverifiedUpdates)
      }
      root.requestFreshUpdateCycle()
    } else root.reload()
    root.actionFinished(kind, label, outcome === done ? 0 : 1)
  }

  function runAction(kind, label, command) {
    if (kind === "update" || busy || actionProc.running) return
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
  // Enable and disable are detached commands that rewrite shell.json. The
  // bar rebuilds the popup with its new state, so the popup never needed to
  // notice; the expanded panel is not a bar widget and would keep showing the
  // old rows, so its store watches the file the way the shell itself does and
  // reloads once the write has settled and the shell has read it too.
  // Opt-in, because the popup exists once per monitor and three copies
  // reloading at once for a change the bar already handles is pure waste.
  property bool watchConfig: false

  FileView {
    id: shellConfig
    path: Quickshell.env("HOME") + "/.config/omarchy/shell.json"
    watchChanges: root.watchConfig
    printErrors: false
    onFileChanged: if (root.watchConfig) configReload.restart()
  }

  Timer {
    id: configReload
    interval: 1000
    repeat: false
    onTriggered: root.reload()
  }

  Timer {
    id: loadRetry
    interval: 1500
    repeat: false
    onTriggered: root.reload()
  }

  Process {
    id: loadProc
    command: ["bash", "-c",
      "catalog=$(omarchy plugin catalog); "
      // This plugin's own inline entry, wherever shell.json keeps it. Bounded
      // read, one object or nothing; the id is this plugin's fixed manifest id.
      + "printf '===settings===\\n'; "
      + "head -c 1048577 -- \"$HOME/.config/omarchy/shell.json\" 2>/dev/null "
      + "  | jq -c --arg id io.github.juancasanueva.plugin-manager "
      + "    '[(.bar.layout // {} | .[]? | .[]?), (.plugins // [] | .[]?)] "
      + "     | map(select(type == \"object\" and (.id | tostring) == $id)) | first // empty' 2>/dev/null; "
      // Which section every bar widget sits in, as one array on one line, so
      // a row can say where it is and the move control can leave that out.
      // Same bounded read; a layout jq cannot print is simply no layout.
      + "printf '===layout===\\n'; "
      + "head -c 1048577 -- \"$HOME/.config/omarchy/shell.json\" 2>/dev/null "
      + "  | jq -c '[(.bar.layout // {}) | to_entries[] | .key as $section "
      + "     | (.value | if type == \"array\" then .[] else empty end) "
      + "     | {id: ((if type == \"object\" then .id else . end) | tostring), section: $section}]' 2>/dev/null; "
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
      // The newest commits reachable from HEAD, so the panel can tell a
      // verified snapshot the checkout already contains from one it lacks.
      + "  ancestors=$(git -C \"$path\" rev-list --max-count=128 HEAD 2>/dev/null); "
      + "  jq -cn --arg path \"$path\" --arg remote \"$remote\" --arg exactTag \"$exact_tag\" --arg headSha \"$head\" --arg ancestors \"$ancestors\" "
      + "    '{path: $path, remote: $remote, exactTag: $exactTag, headSha: $headSha, ancestors: $ancestors}'; "
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
    // A pinned update leaves the checkout detached, and a branch named HEAD
    // exists on no remote; compare a detached checkout against the remote's
    // default branch instead, which is what the marketplace verifies.
    + "  if [ \"$branch\" = HEAD ]; then ref=HEAD; else ref=\"refs/heads/$branch\"; fi; "
    + "  remote_sha=$(timeout 12 git -C \"$path\" ls-remote origin \"$ref\" 2>/dev/null | head -n 1 | cut -f1); "
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
    clearEnvironment: true
    stdout: StdioCollector {
      waitForEnd: true
      onStreamFinished: root.applyCatalog(text)
    }
    onExited: function(exitCode) {
      if (exitCode === 0) return
      // Whatever the stream handed the worker was the output of a failed
      // fetch; a newer generation makes the worker's reply fall on the floor.
      root.catalogGeneration += 1
      root.catalogLoading = false
      root.catalogError = "Could not reach omarchyplugins.com"
    }
  }

  // The Python worker is independent of this observer's lifecycle. Destruction
  // may kill the observer; the bounded worker keeps its journal and finalizes.
  Process {
    id: pinnedProc
    clearEnvironment: true
    stdout: SplitParser {
      splitMarker: ""
      onRead: function(chunk) {
        if (root.pinnedOutput.length + chunk.length > 4096) {
          root.pinnedOverflow = true
          root.pinnedOutput = ""
        } else if (!root.pinnedOverflow) root.pinnedOutput += chunk
      }
    }
    stderr: SplitParser { splitMarker: ""; onRead: function(chunk) {} }
    onExited: function(exitCode) {
      root.pinnedExited = true
      // Drain final raw chunks before interpreting the one bounded result.
      Qt.callLater(root.finishPinnedUpdate)
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
      } else {
        root.setStatus(Model.failureMessage(kind, root.actionStderr, exitCode), true)
      }

      root.reload()
      root.actionFinished(kind, label, exitCode)
    }
  }

}
