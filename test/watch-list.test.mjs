import { readFileSync } from "node:fs"
import { test } from "node:test"
import assert from "node:assert/strict"

const read = name => readFileSync(new URL(`../${name}`, import.meta.url), "utf8")
const Model = new Function(read("Model.js") + `
  return { watchingIds, withWatching, isWatched, MAX_WATCHING, MAX_SETTINGS_BYTES, parseSelfEntry,
    parseSelfSettings, filterCatalog, catalogAvailabilityOptions, catalogIsFiltering, catalogEmptyMessage,
    actionHints, browseFilterHints }`)()

const entries = [
  { id: "acme.weather", name: "Weather", installable: true, installed: false },
  { id: "acme.clock", name: "Clock", installable: false, installed: true },
  { id: "acme.radio", name: "Radio", installable: true, installed: false }
]

test("the watch list is read strictly from this plugin's own entry", () => {
  const ids = Model.watchingIds({ openAs: "window", watching: ["acme.radio", "acme.weather", "acme.radio",
    "bad id", "../escape", "a..b", "", 42, null, { id: "acme.clock" }, "__proto__", "constructor",
    "x".repeat(129)] })
  assert.equal(Object.getPrototypeOf(ids), null)
  assert.deepEqual(Object.keys(ids), ["acme.radio", "acme.weather", "constructor"])
  assert.equal(Model.isWatched({ id: "acme.radio" }, ids), true)
  assert.equal(Model.isWatched({ id: "acme.clock" }, ids), false)
  assert.equal(Model.isWatched(null, ids), false)
  for (const entry of [null, undefined, {}, { watching: "acme.radio" }, { watching: { 0: "acme.radio" } }])
    assert.deepEqual(Object.keys(Model.watchingIds(entry)), [], JSON.stringify(entry))
  const many = Array.from({ length: 300 }, (_, i) => "acme.w" + i)
  assert.equal(Object.keys(Model.watchingIds({ watching: many })).length, Model.MAX_WATCHING)
  assert.equal(Model.MAX_WATCHING, 200)
  // An array is not a setting: the boolean and integer readers never see it.
  assert.deepEqual(Model.parseSelfSettings(JSON.stringify({ watching: ["acme.radio"], openAs: "window" })),
    { openAs: "window" })
})

test("watching appends, unwatching removes, and every other key of the entry survives", () => {
  const entry = { id: "io.github.juancasanueva.plugin-manager", openAs: "window", transactionLimit: 8 }
  const one = Model.withWatching(entry, "acme.radio", true)
  assert.deepEqual(one, { openAs: "window", transactionLimit: 8, watching: ["acme.radio"] })
  const two = Model.withWatching(one, "acme.weather", true)
  assert.deepEqual(two.watching, ["acme.radio", "acme.weather"])
  assert.deepEqual(Model.withWatching(two, "acme.radio", true).watching, ["acme.radio", "acme.weather"],
    "already watched")
  assert.deepEqual(Model.withWatching(two, "acme.radio", false).watching, ["acme.weather"])
  assert.deepEqual(Model.withWatching(Model.withWatching(two, "acme.radio", false), "acme.weather", false),
    { openAs: "window", transactionLimit: 8 }, "an empty list leaves no key behind")
  assert.deepEqual(entry, { id: "io.github.juancasanueva.plugin-manager", openAs: "window", transactionLimit: 8 })
  // Malformed stored values are dropped rather than carried into the write.
  assert.deepEqual(Model.withWatching({ watching: ["acme.radio", "bad id", 7] }, "acme.clock", true).watching,
    ["acme.radio", "acme.clock"])
  for (const id of ["", "bad id", "../x", "-flag", 42, null, "x".repeat(129)])
    assert.equal(Model.withWatching(entry, id, true), null, JSON.stringify(id))
})

test("a full list refuses another plugin, and the entry stays within what the reader accepts", () => {
  const ids = Array.from({ length: 200 }, (_, i) => (i + "a").padEnd(128, "x"))
  let entry = { openAs: "window", allowUnverifiedUpdates: true, allowUnverifiedInstalls: true, transactionLimit: 64 }
  for (const id of ids) entry = Model.withWatching(entry, id, true)
  assert.equal(entry.watching.length, 200)
  assert.ok(JSON.stringify({ id: "io.github.juancasanueva.plugin-manager", ...entry }).length <= Model.MAX_SETTINGS_BYTES)
  assert.deepEqual(Model.parseSelfEntry(JSON.stringify(entry)), entry, "the full list still reads back")
  assert.equal(Model.withWatching(entry, "acme.radio", true), null, "full")
  assert.equal(Model.withWatching(entry, ids[0], true).watching.length, 200, "already watched is not an add")
  assert.equal(Model.withWatching(entry, ids[0], false).watching.length, 199)
  // Whatever else the entry holds, a write that would not read back is refused.
  assert.equal(Model.withWatching({ note: "x".repeat(Model.MAX_SETTINGS_BYTES) }, "acme.radio", true), null)
})

test("Browse narrows to the watch list through the Availability filter", () => {
  assert.deepEqual(Model.catalogAvailabilityOptions(), [
    { value: "all", label: "All" }, { value: "available", label: "Available" },
    { value: "installed", label: "Installed" }, { value: "watching", label: "Watching" }])
  const watched = Model.watchingIds({ watching: ["acme.radio", "acme.clock", "acme.gone"] })
  assert.deepEqual(Model.filterCatalog(entries, "all", "all", "watching", "", watched).map(e => e.id),
    ["acme.clock", "acme.radio"], "catalog order, installed or not, missing listings skipped")
  assert.deepEqual(Model.filterCatalog(entries, "all", "all", "watching", "rad", watched).map(e => e.id), ["acme.radio"])
  assert.deepEqual(Model.filterCatalog(entries, "all", "all", "watching", "").map(e => e.id), [], "no list, nothing watched")
  assert.deepEqual(Model.filterCatalog(entries, "all", "all", "all", "", watched).map(e => e.id),
    ["acme.weather", "acme.clock", "acme.radio"], "other filters ignore the list")
  assert.equal(Model.catalogIsFiltering("all", "all", "watching", ""), true)
  assert.equal(Model.catalogEmptyMessage("all", "all", "watching", ""),
    "You are not watching any plugins. Press w on a card, or Watch in its details, to add one.")
  assert.equal(Model.catalogEmptyMessage("all", "all", "watching", "rad"), "No plugins match “rad” and the selected filters.")
  assert.equal(Model.browseFilterHints({ availability: "watching" }, { availability: Model.catalogAvailabilityOptions() })[2].text,
    "WATCHING")
  assert.deepEqual(Model.actionHints(true), [
    { key: "↵", text: "DETAILS", active: false },
    { key: "w", text: "WATCH", active: false },
    { key: "/", text: "SEARCH", active: false }])
})

test("the store writes the list through the host from shell.json as it is now", () => {
  const store = read("PluginStore.qml")
  assert.match(store, /readonly property var watchedIds: Model\.watchingIds\(selfEntry\)/)
  const body = store.slice(store.indexOf("function setWatching(entry, watch)"))
  assert.match(body, /^function setWatching\(entry, watch\) \{\s*if \(busy \|\| !entry\) return false/)
  assert.match(body, /openAsConfig\.reload\(\)\s*var raw = Model\.selfEntryFromShellConfig\(openAsConfig\.text\(\), selfId\)/)
  assert.match(body, /var next = Model\.withWatching\(current, entry\.id, watch\)/)
  assert.match(body, /shell\.updateEntryInline\(selfId, next\) !== true/)
  assert.match(body, /selfEntry = next/)
  assert.match(store, /function toggleWatching\(entry\) \{\s*return !!entry && setWatching\(entry, !Model\.isWatched\(entry, watchedIds\)\)/)
})

test("both windows filter, mark, key and offer the watch list", () => {
  for (const name of ["Panel.qml", "Expanded.qml"]) {
    const qml = read(name)
    assert.match(qml, /Model\.filterCatalog\(\s*sortedCatalog, categoryFilter, catalogKindFilter, availabilityFilter, searchQuery,[\s\S]*?availabilityFilter === "watching" \? store\.watchedIds : null\)/, name)
    assert.match(qml, /watched: Model\.isWatched\(modelData, store\.watchedIds\)/, name)
    assert.match(qml, /\(\w+ === "w" \|\| \w+ === "W"\) && root\.browsing\) (?:\{ )?store\.toggleWatching\(root\.selectedEntry\)/, name)
    assert.match(qml, /watched: Model\.isWatched\(root\.detailsEntry, store\.watchedIds\)/, name)
    assert.match(qml, /onWatchRequested: store\.toggleWatching\(root\.detailsEntry\)/, name)
  }
  const card = read("CatalogCard.qml")
  assert.match(card, /property bool watched: false/)
  const marker = card.slice(card.indexOf("id: watchedBadge"), card.indexOf("id: watchedBadge") + 900)
  assert.match(marker, /visible: root\.watched/)
  assert.match(marker, /textFormat: Text\.PlainText/)
  const pane = read("CatalogDetailsPane.qml")
  assert.match(pane, /signal watchRequested\(\)/)
  const button = pane.slice(pane.indexOf("id: watchButton"), pane.indexOf("id: watchButton") + 900)
  assert.match(button, /text: root\.watched \? "Watching" : "Watch"/)
  assert.match(button, /onClicked: root\.watchRequested\(\)/)
  const details = read("PluginDetails.qml")
  assert.match(details, /signal watchRequested\(\)/)
  assert.match(details, /values\.push\(\{ kind: "watch", label: watched \? "Stop watching" : "Watch" \}\)/)
  assert.match(details, /else if \(kind === "watch"\) watchRequested\(\)/)
})
