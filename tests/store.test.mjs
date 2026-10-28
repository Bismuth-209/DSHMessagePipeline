import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import {
  addMessage,
  backlogFor,
  createPipeline,
  emptyStore,
  findMessage,
  findPipeline,
  normalizeStore,
  pendingMessagesFor,
  pendingTargets,
  pipelineTitleTaken,
  pruneMessages,
  readStore,
  removePipeline,
  repairStore,
  replaceGlobalSettings,
  updatePipeline,
  writeStore,
} from '../lib/store.js'

const NOW = 1_700_000_000_000
const DAY = 24 * 60 * 60 * 1000

function message(id, overrides = {}) {
  return {
    id,
    senderSessionId: 's-a1',
    senderTitle: 'Alpha lead',
    senderWorkspaceId: 'A',
    senderWorkspaceTitle: 'Alpha',
    targetSessionId: 's-b1',
    targetWorkspaceId: 'B',
    pipelineId: 'p1',
    pipelineTitle: 'P1',
    wake: false,
    state: 'queued',
    attempts: 0,
    bytes: 100,
    body: 'hello',
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  }
}

// --- normalization ---------------------------------------------------------
const normalized = normalizeStore({
  settings: { maxMessageBytes: 0, maxSendsPerMinute: 4 },
  pipelines: [
    { id: 'p1', title: 'P1', workspaceIds: ['A', 'A', 'B'], enabled: true, createdAt: NOW, settings: { maxMessageBytes: 4096, defaultWake: true } },
    { id: '', title: 'bad' },
    { id: 'p2', title: '' },
    null,
  ],
  messages: [
    message('m1', { state: 'delivering', attempts: 2 }),
    message('m2', { state: 'delivered', body: 'kept?' }),
    { id: 'm3' },
    null,
  ],
})
assert.equal(normalized.pipelines.length, 1)
assert.deepEqual(normalized.pipelines[0].workspaceIds, ['A', 'B'])
assert.deepEqual(normalized.pipelines[0].settings, { maxMessageBytes: 4096, defaultWake: true })
assert.equal(normalized.messages.length, 2)
assert.equal(normalized.messages[0].state, 'queued') // delivering restarts as queued
assert.equal(normalized.messages[0].attempts, 2)
assert.equal(normalized.messages[0].body, 'hello')
assert.equal(normalized.messages[1].state, 'delivered')
assert.equal(normalized.messages[1].body, undefined) // terminal rows never keep the body
assert.deepEqual(normalized.settings, { maxMessageBytes: 0, maxSendsPerMinute: 4 })
assert.deepEqual(emptyStore().settings, {})

// global settings replace
replaceGlobalSettings(normalized, { maxMessageBytes: 0 })
assert.deepEqual(normalized.settings, { maxMessageBytes: 0 })
replaceGlobalSettings(normalized, {})
assert.deepEqual(normalized.settings, {})

// --- pipeline CRUD ---------------------------------------------------------
const store = emptyStore()
assert.equal(findPipeline(store, 'nope'), undefined)
const created = createPipeline(store, { title: 'P1', description: '', workspaceIds: ['A', 'B'] }, NOW, 2, 'p1')
assert.equal(created.id, 'p1')
assert.deepEqual(created.settings, {})
assert.equal(pipelineTitleTaken(store, 'p1'), true)
assert.equal(pipelineTitleTaken(store, 'P1', 'p1'), false)
assert.equal(findPipeline(store, 'p1').id, 'p1')
assert.equal(findPipeline(store, 'P1').id, 'p1')

updatePipeline(created, { title: 'Renamed', enabled: false, workspaceIds: ['A', 'B', 'C'] }, NOW + 1)
assert.equal(created.title, 'Renamed')
assert.equal(created.enabled, false)
assert.deepEqual(created.workspaceIds, ['A', 'B', 'C'])

// settings are created, replaced (not merged) and clearable
const settingsStore = emptyStore()
const settingsPipeline = createPipeline(settingsStore, {
  title: 'Limited',
  description: '',
  workspaceIds: ['A', 'B'],
  settings: { maxMessageBytes: 2048, defaultWake: true },
}, NOW, 3, 'p3')
assert.deepEqual(settingsPipeline.settings, { maxMessageBytes: 2048, defaultWake: true })
updatePipeline(settingsPipeline, { settings: { maxSendsPerMinute: 4 } }, NOW + 2)
assert.deepEqual(settingsPipeline.settings, { maxSendsPerMinute: 4 })
updatePipeline(settingsPipeline, { settings: {} }, NOW + 3)
assert.deepEqual(settingsPipeline.settings, {})

// second pipeline fits, third hits the cap
createPipeline(store, { title: 'P2', description: '', workspaceIds: ['B', 'C'] }, NOW, 2, 'p2')
assert.equal(createPipeline(store, { title: 'P3', description: '', workspaceIds: ['A', 'C'] }, NOW, 2, 'p3'), undefined)
assert.equal(store.pipelines.length, 2)

// --- outbox ----------------------------------------------------------------
addMessage(store, message('m1'))
addMessage(store, message('m2', { createdAt: NOW - 10 }))
addMessage(store, message('m3', { state: 'delivered', createdAt: NOW - 5 }))
assert.equal(backlogFor(store, 's-b1'), 2)
assert.deepEqual(pendingMessagesFor(store, 's-b1').map((row) => row.id), ['m2', 'm1']) // oldest first
assert.deepEqual(pendingTargets(store), ['s-b1'])
assert.equal(findMessage(store, 'm2').id, 'm2')

// removing a pipeline drops only its cross-workspace queued messages
const removal = removePipeline(store, 'p1', NOW + 2)
assert.equal(removal.removed, true)
assert.equal(removal.dropped, 2)
assert.equal(findMessage(store, 'm1').state, 'dropped')
assert.equal(findMessage(store, 'm1').reason, 'PIPE_NOT_REACHABLE')
assert.equal(findMessage(store, 'm1').body, undefined)
assert.equal(findMessage(store, 'm3').state, 'delivered') // terminal rows untouched
assert.equal(removePipeline(store, 'missing', NOW).removed, false)

// --- pruning ---------------------------------------------------------------
const pruneStore = emptyStore()
pruneStore.messages.push(
  message('old-delivered', { state: 'delivered', updatedAt: NOW - 40 * DAY }),
  message('fresh-delivered', { state: 'delivered', updatedAt: NOW - DAY }),
  message('old-queued', { state: 'queued', updatedAt: NOW - 400 * DAY }),
)
const removedRows = pruneMessages(pruneStore, { now: NOW, retentionDays: 30, maxRecords: 100 })
assert.equal(removedRows, 1)
assert.deepEqual(pruneStore.messages.map((row) => row.id), ['fresh-delivered', 'old-queued'])

const capped = emptyStore()
for (let i = 0; i < 10; i += 1) {
  capped.messages.push(message(`terminal-${i}`, { state: 'delivered', updatedAt: NOW - i }))
}
capped.messages.push(message('pending', { state: 'queued' }))
pruneMessages(capped, { now: NOW, retentionDays: 30, maxRecords: 3 })
assert.equal(capped.messages.filter((row) => row.state === 'delivered').length, 3)
assert.equal(capped.messages.some((row) => row.id === 'pending'), true)

// --- repair ----------------------------------------------------------------
const repairMe = emptyStore()
repairMe.pipelines.push({ id: 'p1', title: 'P1', description: '', workspaceIds: ['A', 'B', 'gone'], enabled: true, createdAt: NOW, updatedAt: NOW })
repairMe.messages.push(
  message('keep', { targetSessionId: 's-b1', targetWorkspaceId: 'B' }),
  message('archived', { targetSessionId: 's-b2', targetWorkspaceId: 'B' }),
  message('gone-target', { targetSessionId: 's-gone', targetWorkspaceId: 'B' }),
  message('same-ws', { targetSessionId: 's-a9', targetWorkspaceId: 'A', pipelineId: undefined }),
  message('disabled-pipeline', { targetSessionId: 's-b3', targetWorkspaceId: 'B', pipelineId: 'p2' }),
)
const changed = repairStore(repairMe, {
  workspaceIds: new Set(['A', 'B']),
  sessionIds: new Set(['s-a1', 's-a9', 's-b1', 's-b2', 's-b3']),
  archivedSessionIds: new Set(['s-b2']),
  now: NOW,
})
assert.equal(changed, true)
assert.deepEqual(repairMe.pipelines[0].workspaceIds, ['A', 'B'])
assert.equal(findMessage(repairMe, 'keep').state, 'queued')
assert.equal(findMessage(repairMe, 'archived').state, 'dropped')
assert.equal(findMessage(repairMe, 'archived').reason, 'PIPE_TARGET_ARCHIVED')
assert.equal(findMessage(repairMe, 'gone-target').state, 'dropped')
assert.equal(findMessage(repairMe, 'gone-target').reason, 'PIPE_TARGET_GONE')
assert.equal(findMessage(repairMe, 'same-ws').state, 'queued')
assert.equal(findMessage(repairMe, 'disabled-pipeline').reason, 'PIPE_NOT_REACHABLE')

// a second pass on already-clean state reports no change
assert.equal(repairStore(repairMe, {
  workspaceIds: new Set(['A', 'B']),
  sessionIds: new Set(['s-a1', 's-a9', 's-b1', 's-b2', 's-b3']),
  archivedSessionIds: new Set(['s-b2']),
  now: NOW + 1,
}), false)

// a pipeline whose every workspace vanished is pruned on reconciliation
const emptied = emptyStore()
emptied.pipelines.push(
  { id: 'gone-only', title: 'Gone', description: '', workspaceIds: ['gone'], enabled: true, createdAt: NOW, updatedAt: NOW },
  { id: 'partly', title: 'Partly', description: '', workspaceIds: ['A', 'gone'], enabled: true, createdAt: NOW, updatedAt: NOW },
)
assert.equal(repairStore(emptied, {
  workspaceIds: new Set(['A']),
  sessionIds: new Set(['s-a1']),
  archivedSessionIds: new Set(),
  now: NOW,
}), true)
assert.deepEqual(emptied.pipelines.map((pipeline) => pipeline.id), ['partly'])
assert.deepEqual(emptied.pipelines[0].workspaceIds, ['A'])

// --- file round trip -------------------------------------------------------
const directory = mkdtempSync(path.join(tmpdir(), 'message-pipeline-'))
const file = path.join(directory, 'store.json')
assert.deepEqual(readStore(file), emptyStore())
writeStore(file, repairMe)
assert.equal(existsSync(file), true)
const reread = readStore(file)
assert.equal(reread.messages.some((row) => row.id === 'keep'), true)
writeFileSync(file, '{ not json', 'utf8')
assert.deepEqual(readStore(file), emptyStore())
assert.equal(readFileSync(file, 'utf8').includes('not json'), true)

console.log('store.test: ok')
