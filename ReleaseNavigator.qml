import QtQuick
import Quickshell
import Quickshell.Io
import "Model.js" as Model

// Click-time navigation to a GitHub Release, shared by the popup and the
// expanded panel. A version link names a tag; whether that tag has a Release
// page is only known by asking, so a HEAD request decides which page to open
// and a fallback URL covers the answer "none". The state machine lives in
// Model.js as pure transitions; this item owns the state, the probe process
// and the one browser-launching sink, so neither window carries a copy.
Item {
  id: root

  property var state: Model.releaseNavigationInitialState()
  readonly property bool busy: state.activeGeneration !== 0

  // The only browser-launching sink. Callers hand it URLs already accepted by
  // a Model transition; the argv remains one isolated URL.
  function openBrowserUrl(url) {
    var trusted = Model.browsableUrl(url)
    if (trusted !== "") Quickshell.execDetached(["omarchy-launch-browser", trusted])
  }

  function apply(transition) {
    if (!transition) return
    state = transition.state
    if (transition.stopProbe && releaseProbe.running) releaseProbe.running = false
    if (transition.startRequest) startProbe(transition.startRequest)
    if (transition.openUrl !== "") openBrowserUrl(transition.openUrl)
    if (transition.scheduleStart) Qt.callLater(function() {
      apply(Model.releaseNavigationStartQueuedTransition(state))
    })
  }

  function startProbe(entry) {
    if (!entry || entry.generation !== state.activeGeneration) return
    var command = Model.releaseProbeCommand(entry.probeUrl)
    if (command.length === 0) {
      apply(Model.releaseNavigationProbeStartFailedTransition(state))
      return
    }
    releaseProbe.command = command
    releaseProbe.running = true
  }

  // A version link: try the Release candidates, fall back to the tag page.
  function request(candidates, fallbackUrl) {
    var value = Model.githubNavigationRequest(candidates, fallbackUrl)
    apply(Model.releaseNavigationRequestTransition(state, value))
  }

  // A plain link: opens directly, and retires any probe still in flight so a
  // late answer cannot open a second page.
  function navigate(url) {
    apply(Model.releaseNavigationDirectTransition(state, url))
  }

  // Anything that changes what the user is looking at retires the probe.
  function revoke() {
    apply(Model.releaseNavigationRevokeTransition(state))
  }

  Process {
    id: releaseProbe
    stdout: StdioCollector {
      waitForEnd: true
      onStreamFinished: root.apply(
        Model.releaseNavigationProbeOutputTransition(root.state, text))
    }
    onExited: function(exitCode) { root.apply(
      Model.releaseNavigationProbeExitedTransition(root.state, exitCode)) }
  }
}
