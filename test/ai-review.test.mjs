import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import assert from 'node:assert/strict'

const source = readFileSync(new URL('../Model.js', import.meta.url), 'utf8')
const M = new Function(source + '; return {enableAiReview, parseSelfSettings, withSelfSetting, installRequest, reviewKey, reviewResult, reviewBinding, reviewReport, REVIEW_AGENTS, findRow, plainText};')()
const sha = 'a'.repeat(40)
const request = {schemaVersion: 1, id: 'acme.plugin', repository: 'https://github.com/acme/plugin', branch: 'main', section: ''}

test('AI review defaults off and round-trips only persisted boolean true', () => {
  for (const value of [undefined, false, 'true', 1, null])
    assert.equal(M.enableAiReview(M.parseSelfSettings(JSON.stringify({enableAiReview: value}))), false)
  const saved = M.withSelfSetting({other: 'kept'}, 'enableAiReview', true)
  assert.equal(saved.other, 'kept')
  assert.equal(M.enableAiReview(M.parseSelfSettings(JSON.stringify(saved))), true)
  assert.equal(M.enableAiReview(M.withSelfSetting(saved, 'enableAiReview', false)), false)
})

test('prepared result binds exact request and full candidate; malformed and stale results refuse', () => {
  const result = {request, commit: sha, agent: 'pi', packet: 'Untrusted source', comparison: 'unavailable'}
  assert.equal(M.reviewResult(result, request).commit, sha)
  for (const changed of [{...request, branch: 'next'}, {...request, id: 'acme.other'}, {...request, repository: 'https://github.com/acme/other'}])
    assert.equal(M.reviewResult(result, changed), null)
  for (const changed of [{...result, commit: 'abc'}, {...result, agent: 'fallback'}, {...result, packet: 'x'.repeat(393217)}])
    assert.equal(M.reviewResult(changed, request), null)
  assert.notEqual(M.reviewKey({...request, expectedLocalHead: sha}), M.reviewKey(request))
})

// Execute the shipped store methods against inert process/clipboard/host ports.
const storeSource = readFileSync(new URL('../PluginStore.qml', import.meta.url), 'utf8')
function method(name) {
  const start = storeSource.indexOf('  function ' + name + '(')
  assert.ok(start >= 0, name)
  const open = storeSource.indexOf('{', start)
  const tokens = storeSource.slice(open).matchAll(/"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|\/\/[^\n]*|\/\*[\s\S]*?\*\/|[{}]/g)
  let depth = 0
  for (const token of tokens) {
    if (token[0] === '{') depth++
    if (token[0] === '}' && --depth === 0) return storeSource.slice(start, open + token.index + 1)
  }
  throw Error(name)
}
const methods = ['cancelAiReview', 'closeAiReview', 'currentReviewRequest', 'reviewStillCurrent',
  'askAiReview', 'startReviewProcess', 'prepareAiReview', 'finishAiReview', 'copyAiReview',
  'writeSelfSetting', 'setEnableAiReview', 'startAdd', 'cancelPending', 'runAiReview', 'copyAiReport', 'sendReviewInput']
function fixture() {
  const entry = {id: request.id, installAvailable: true, installUrl: request.repository,
    unverifiedSnapshot: {id: request.id, repository: request.repository, branch: 'main'}}
  const state = {enableAiReview: false, busy: false, reviewSettled: true, reviewGeneration: 0,
    reviewProcessGeneration: -1, reviewRequest: null, reviewPrepared: null, reviewPhase: '',
    reviewAgent: '', reviewError: '', reviewOutput: '', reviewOpened: false, reviewHelperPath: '/fixture/helper',
    reviewBinding: null, reviewReport: '', reviewManualReason: '', reviewInput: '', reviewSettings: '',
    allowUnverifiedInstalls: true, catalog: [entry], rows: [], selfEntryLoaded: true, selfEntry: {other: 'kept'},
    selfSettings: {}, selfId: 'manager', writes: [], statuses: [],
    shell: {updateEntryInline(id, next) { state.writes.push([id, next]); return true }},
    setStatus(...args) { state.statuses.push(args) },
    reviewProc: {running: false, command: [], input: [], signals: [], signal(n) { this.signals.push(n) }, write(s) { this.input.push(s) }},
    Quickshell: {clipboardText: ''}, launched: [], launchInstall(r) { state.launched.push(r) },
    pendingKind: '', pendingUnverifiedSha: '', pendingVerifiedCommit: '', pendingBranch: '',
    pendingSection: '', pendingId: '', pendingLabel: '', pendingUrl: '', pendingPlacementNeeded: false}
  const invoke = new Function('Model', 'state', 'name', 'args', `with(state) {
    ${methods.map(method).join('\n')}
    return eval(name).apply(null, args)
  }`)
  return {state, call: (name, ...args) => invoke(M, state, name, args)}
}

test('disabled store refuses every review boundary with no process or clipboard effects', () => {
  const {state, call} = fixture()
  for (const name of ['askAiReview', 'startReviewProcess', 'prepareAiReview', 'copyAiReview', 'runAiReview', 'copyAiReport'])
    assert.equal(call(name, request), false)
  assert.equal(state.reviewProc.running, false)
  assert.equal(state.Quickshell.clipboardText, '')
})

test('enabled preparation is disclosure then packet then explicit copy, never installation', () => {
  const {state, call} = fixture()
  state.enableAiReview = true
  assert.equal(call('askAiReview', request), true)
  assert.deepEqual(JSON.parse(state.reviewProc.command.at(-1)), {selection: true})
  assert.equal(call('prepareAiReview'), false, 'must wait for the selection/disclosure')
  state.reviewProc.running = false
  state.reviewOutput = JSON.stringify({agent: 'pi'})
  call('finishAiReview', 0)
  assert.equal(state.reviewPhase, 'disclosure')
  assert.equal(call('prepareAiReview'), true)
  assert.deepEqual(JSON.parse(state.reviewProc.command.at(-1)), {request, agent: 'pi'})
  state.reviewProc.running = false
  state.reviewOutput = JSON.stringify({request, commit: sha, agent: 'pi', packet: 'UNTRUSTED', comparison: 'unavailable'})
  call('finishAiReview', 0)
  assert.equal(state.reviewPhase, 'prepared')
  assert.equal(state.Quickshell.clipboardText, '')
  assert.equal(call('copyAiReview'), true)
  assert.equal(state.Quickshell.clipboardText, 'UNTRUSTED')
  assert.deepEqual(state.writes, [])
})

test('cancel invalidates generation and late completion; disabled persistence remains available while busy', () => {
  const {state, call} = fixture()
  state.enableAiReview = true
  call('askAiReview', request)
  call('cancelAiReview')
  assert.deepEqual(state.reviewProc.signals, [15])
  assert.equal(state.reviewRequest, null)
  assert.equal(state.reviewPrepared, null)
  state.reviewOutput = JSON.stringify({agent: 'claude'})
  call('finishAiReview', 0)
  assert.equal(state.reviewPhase, '')
  assert.equal(state.reviewAgent, '')
  state.busy = true
  assert.equal(call('setEnableAiReview', false), true)
  assert.deepEqual(state.writes, [['manager', {other: 'kept'}]])
})

test('cancel before the process starts still terminates the late owned start', () => {
  const {state, call} = fixture()
  state.enableAiReview = true
  call('askAiReview', request)
  state.reviewProc.running = false
  call('cancelAiReview')
  call('sendReviewInput')
  assert.deepEqual(state.reviewProc.signals, [15])
  assert.equal(state.reviewRequest, null)
})

test('selection replacement cannot receive a stale prepared packet', () => {
  const {state, call} = fixture()
  state.enableAiReview = true
  call('askAiReview', request)
  state.catalog[0].unverifiedSnapshot.branch = 'changed'
  state.reviewOutput = JSON.stringify({request, commit: sha, agent: 'pi', packet: 'old', comparison: 'unavailable'})
  call('finishAiReview', 0)
  assert.equal(state.reviewPrepared, null)
  assert.equal(call('copyAiReview'), false)
})

test('a separate explicit install retains preparation expectation and refuses a stale association', () => {
  for (const stale of [false, true]) {
    const {state, call} = fixture()
    state.enableAiReview = true
    state.reviewRequest = request
    state.reviewSettings = JSON.stringify(state.selfSettings)
    state.reviewPrepared = {commit: sha}
    state.pendingId = request.id
    state.pendingLabel = 'Fixture'
    state.pendingBranch = 'main'
    if (stale) state.catalog[0].unverifiedSnapshot.branch = 'other'
    call('startAdd', 'right')
    assert.deepEqual(state.launched, stale ? [] : [{...request, section: 'right', expectedBranchCommit: sha}])
    if (stale) assert.match(state.statuses[0][0], /prepare the current candidate/)
  }
})

const binding = {agent: 'claude', executable: '/fixture/claude', argv: ['/fixture/claude', '--tools', ''],
  version: '2.1.270 (Claude Code)', identity: ['1', '2', '3', '4', '5'], capability: 'b'.repeat(64)}

test('run is separate consent; source travels in one stdin frame and report cannot change packet/install', () => {
  const {state, call} = fixture()
  state.enableAiReview = true
  call('askAiReview', request)
  state.reviewProc.running = false
  state.reviewOutput = JSON.stringify({agent: 'claude', binding})
  call('finishAiReview', 0)
  assert.equal(call('runAiReview'), false)
  call('prepareAiReview')
  state.reviewProc.running = false
  const prepared = {request, commit: sha, agent: 'claude', packet: 'UNTRUSTED', comparison: 'unavailable'}
  state.reviewOutput = JSON.stringify(prepared)
  call('finishAiReview', 0)
  assert.equal(state.reviewProc.running, false, 'preparation never starts inference')
  assert.equal(call('copyAiReview'), true, 'supported agents retain manual handoff')
  assert.equal(call('runAiReview'), true)
  assert.equal(state.reviewProc.command.at(-1), '--run')
  assert.equal(state.reviewProc.command.includes('UNTRUSTED'), false)
  assert.equal(call('runAiReview'), false, 'single flight')
  call('sendReviewInput')
  assert.equal(state.reviewProc.input.length, 1)
  assert.deepEqual(JSON.parse(state.reviewProc.input[0]), {prepared, binding, generation: state.reviewGeneration})
  call('sendReviewInput')
  assert.equal(state.reviewProc.input.length, 1)
  state.reviewProc.running = false
  state.reviewOutput = JSON.stringify({request, commit: sha, agent: 'claude', binding,
    generation: state.reviewGeneration, report: 'Summary\n<img src="https://invalid">\n'})
  call('finishAiReview', 0)
  assert.equal(state.reviewPhase, 'completed')
  assert.deepEqual(state.reviewPrepared, prepared)
  assert.equal(state.Quickshell.clipboardText, 'UNTRUSTED', 'no automatic report copy')
  assert.equal(call('copyAiReport'), true)
  assert.match(state.Quickshell.clipboardText, /^Summary/)
  assert.deepEqual(state.launched, [])
})

test('report validation rejects stale generation, request, commit, capability and oversized/empty text', () => {
  const prepared = {request, commit: sha, agent: 'claude'}
  const result = {...prepared, binding, generation: 4, report: 'Summary\nAdvice'}
  assert.equal(M.reviewReport(result, prepared, binding, 4), result.report)
  for (const change of [{generation: 3}, {commit: 'b'.repeat(40)}, {agent: 'pi'},
    {request: {...request, branch: 'next'}}, {binding: {...binding, version: 'changed'}},
    {report: ''}, {report: 'x'.repeat(65537)}])
    assert.equal(M.reviewReport({...result, ...change}, prepared, binding, 4), '')
})

test('settings changes, failed start, old callback and cancellation cannot attach a report or leave stdin', () => {
  const {state, call} = fixture()
  state.enableAiReview = true
  call('askAiReview', request)
  const old = state.reviewProcessGeneration
  call('cancelAiReview')
  state.reviewProc.running = false
  call('finishAiReview', -1, old)
  assert.equal(state.reviewInput, '')
  call('askAiReview', request)
  call('finishAiReview', -1, old)
  assert.equal(state.reviewSettled, false, 'old exit cannot settle a new request')
  state.selfSettings = {tiledExpandedPanel: true}
  call('sendReviewInput')
  assert.equal(state.reviewProc.signals.at(-1), 15)
  assert.equal(call('runAiReview'), false)
  call('finishAiReview', 0)
  assert.equal(state.reviewPrepared, null)
  assert.equal(state.reviewReport, '')
})

test('both settings panes promise explicit consent, and report uses the scrollable PlainText dialog', () => {
  for (const file of ['Panel.qml', 'Expanded.qml']) {
    const text = readFileSync(new URL('../' + file, import.meta.url), 'utf8')
    assert.match(text, /only with explicit run consent/)
    assert.doesNotMatch(text, /no agent launches/)
  }
  const text = readFileSync(new URL('../ActionConfirmDialog.qml', import.meta.url), 'utf8')
  assert.match(text, /Flickable/)
  assert.match(text, /text: root.message\s+textFormat: Text.PlainText/)
  assert.doesNotMatch(method('prepareAiReview'), /runAiReview/)
})

test('install expectation is optional, full SHA, and never marketplace authority', () => {
  const entry = {id: request.id, installAvailable: true, installUrl: request.repository,
    unverifiedSnapshot: {id: request.id, repository: request.repository, branch: 'main'}}
  assert.deepEqual(M.installRequest(entry, '', true), request)
  assert.deepEqual(M.installRequest(entry, '', true, sha), {...request, expectedBranchCommit: sha})
  for (const bad of ['abc', true, {}, '']) assert.equal(M.installRequest(entry, '', true, bad), null)
  assert.equal(M.installRequest(entry, '', false, sha), null)
})
