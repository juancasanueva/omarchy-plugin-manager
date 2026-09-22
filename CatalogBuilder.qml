import QtQuick
import Quickshell
import Quickshell.Io
import "Model.js" as Model

// This config runs only in the supervised offscreen process, never in the
// desktop engine. The input is an inherited, already bounded descriptor.
ShellRoot {
  FileView {
    id: request
    path: "/proc/self/fd/" + Quickshell.env("CATALOG_REQUEST_FD")
    onLoaded: Qt.callLater(build)
  }

  function build() {
    try {
      var message = JSON.parse(request.text())
      var result = Model.buildCatalog(message.raw, message.installedIds)
      console.log("CATALOG_RESULT:" + JSON.stringify({
        generation: message.generation, entries: result.entries, error: result.error
      }))
    } catch (error) {
      console.log("CATALOG_RESULT:" + JSON.stringify({ entries: null, error: "Could not read the plugin catalog" }))
    }
    // quit has no receiver during Component.onCompleted; leave initialization
    // before emitting it. There is no WorkerScript engine to tear down here.
    Qt.callLater(Qt.quit)
  }
}
