// The way back from the expanded window to the popup.
//
// A panel plugin's scoped shell carries no bar reference, and shell.summon
// routes a plugin that also declares a panel kind to the panel loader, never
// to its bar widget. So the expanded window cannot ask the host to reopen the
// popup. Both windows live in one QML engine, and a `.pragma library` script
// is a single shared instance there: each per-monitor bar widget registers
// itself here, and the expanded window picks the one on the output it was
// summoned to. Nothing crosses a process or trusts anything but live QML
// objects the plugin itself created.
.pragma library

var widgets = []
var moveOwner = null
// Never retain a popup closure or a move plan here; the store owns dispatch.
var continuation = null

function register(widget) {
  if (widget && widgets.indexOf(widget) < 0) widgets.push(widget)
  if (widget && typeof widget.setMoveOwner === "function") widget.setMoveOwner(moveOwner)
}

function unregister(widget) {
  var index = widgets.indexOf(widget)
  if (index >= 0) widgets.splice(index, 1)
  if (widget && typeof widget.setMoveOwner === "function") widget.setMoveOwner(null)
}

function registerOwner(owner) {
  if (moveOwner === owner) return
  cancelArrange()
  moveOwner = owner
  for (var i = 0; i < widgets.length; i++) register(widgets[i])
}

function unregisterOwner(owner) {
  if (moveOwner === owner) registerOwner(null)
}

// Cancellation revokes only reopening, never the client's reconciliation lock.
function cancelArrange() {
  continuation = null
  if (moveOwner) moveOwner.continuationActive = false
}

// A single Installed placement return, not a saved session or a popup reference.
function placementOrigin(value) {
  if (!value || value.tab !== "installed") return null
  var out = { tab: "installed" }
  var limits = { selectedId: 128, query: 1024, group: 64, kind: 128, status: 64 }
  for (var key in limits) {
    if (typeof value[key] !== "string" || value[key].length > limits[key]) return null
    out[key] = value[key]
  }
  if (typeof value.scroll !== "number" || !isFinite(value.scroll)
      || value.scroll < 0 || value.scroll > 10000000) return null
  out.scroll = value.scroll
  return Object.freeze(out)
}

function requestMove(widget, snapshot, fromSection, fromIndex, section, gap, origin) {
  if (!moveOwner || widgets.indexOf(widget) < 0 || moveOwner.busy) return false
  var view = origin === undefined ? null : placementOrigin(origin)
  if (origin !== undefined && !view) return false
  var owner = moveOwner
  var screen = String(widget.screenName || "")
  if (!owner.start(snapshot, fromSection, fromIndex, section, gap)) return false
  continuation = { screen: screen, generation: owner.generation, attempts: 0, origin: view }
  owner.continuationActive = true
  return true
}

// The retained owner's 100ms timer calls this. Allow three seconds AFTER exit
// for a rebuilt bar/panel to become ready. Prefer the original output; only
// the final attempt may fall back if that output has no registered widget.
function continueArrange(owner) {
  if (owner !== moveOwner || !continuation) return
  if (continuation.generation !== owner.generation) { cancelArrange(); return }
  if (owner.pending && !owner.exited) return
  var route = continuation
  route.attempts++
  var chosen = null
  for (var i = 0; i < widgets.length; i++) {
    var widget = widgets[i]
    if (widget && String(widget.screenName || "") === route.screen) {
      chosen = widget
      break
    }
  }
  if (!chosen && route.attempts >= 30 && widgets.length) chosen = widgets[0]
  // Consume before invoking UI code: a synchronous close/cancel/new request
  // must not be overwritten by the completion of this older attempt.
  continuation = null
  var opened = false
  if (chosen) {
    if (route.origin) opened = typeof chosen.openPlacementView === "function"
      && chosen.openPlacementView(route.origin, route.attempts >= 30) === true
    else opened = typeof chosen.openArrange === "function" && chosen.openArrange() === true
  }
  if (continuation || owner !== moveOwner) return
  if (!opened && route.attempts < 30 && owner.continuationActive) continuation = route
  else owner.continuationActive = false
}

// Open the popup on `screenName`, or on the first live widget when no
// instance sits on that output (a monitor unplugged between summons). Returns
// whether a popup was opened.
function openPopup(screenName) {
  var name = String(screenName || "")
  var chosen = null
  for (var i = 0; i < widgets.length; i++) {
    var widget = widgets[i]
    if (!widget || typeof widget.open !== "function") continue
    if (!chosen) chosen = widget
    if (name !== "" && String(widget.screenName || "") === name) {
      chosen = widget
      break
    }
  }
  if (!chosen) return false
  chosen.open()
  return true
}
