// The catalog build, off the main thread. Model.js is included rather than
// duplicated: the worker runs exactly the parsing and sanitising the tests
// cover, and the main thread only ever receives finished entries.
//
// A message crosses threads by copy, so the request carries plain data (the
// raw text and a list of installed ids) and the reply carries plain entries.
// The generation number travels with both so the store can drop a reply
// that a newer request has already overtaken.
Qt.include("Model.js")

WorkerScript.onMessage = function(message) {
  var built = buildCatalog(message.raw, message.installedIds)
  WorkerScript.sendMessage({ generation: message.generation, entries: built.entries, error: built.error })
}
