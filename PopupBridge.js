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

function register(widget) {
  if (widget && widgets.indexOf(widget) < 0) widgets.push(widget)
}

function unregister(widget) {
  var index = widgets.indexOf(widget)
  if (index >= 0) widgets.splice(index, 1)
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
