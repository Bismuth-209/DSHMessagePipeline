import assert from 'node:assert/strict'
import {
  PIPE_LIMITS,
  authorizeTarget,
  buildWorkspaceIndex,
  describeCode,
  normalizePipelineDraft,
  normalizePipelineSettings,
  pipelineLinking,
  reachableWorkspaceIds,
  resolveSessionRef,
  resolveWorkspaceRef,
} from '../lib/routing.js'

const workspaces = [
  { id: 'A', title: 'Alpha', path: 'C:/work/alpha', sessionIds: ['s-a1', 's-a2'] },
  { id: 'B', title: 'Beta', path: 'C:/work/beta', sessionIds: ['s-b1'] },
  { id: 'C', title: 'Gamma', path: 'C:/work/gamma', sessionIds: ['s-c1'] },
  { id: 'D', title: 'Delta', path: 'C:/work/delta', sessionIds: [] },
]
const index = buildWorkspaceIndex(workspaces)
const pipelines = [
  { id: 'p1', title: 'P1', enabled: true, workspaceIds: ['A', 'B'] },
  { id: 'p2', title: 'P2', enabled: true, workspaceIds: ['B', 'C'] },
]

function sorted(set) {
  return [...set].sort()
}

// --- index -----------------------------------------------------------------
assert.equal(index.list.length, 4)
assert.equal(index.byId.get('A').title, 'Alpha')
assert.equal(index.workspaceOfSession('s-b1').id, 'B')
assert.equal(index.workspaceOfSession('nope'), undefined)
assert.equal(buildWorkspaceIndex([{ id: '' }, null]).list.length, 0)

// --- reachability: hyperedge, never transitive ------------------------------
assert.deepEqual(sorted(reachableWorkspaceIds(index, pipelines, 'A')), ['A', 'B'])
assert.deepEqual(sorted(reachableWorkspaceIds(index, pipelines, 'B')), ['A', 'B', 'C'])
assert.deepEqual(sorted(reachableWorkspaceIds(index, pipelines, 'C')), ['B', 'C'])
assert.equal(reachableWorkspaceIds(index, pipelines, 'A').has('C'), false)
assert.equal(reachableWorkspaceIds(index, pipelines, 'C').has('A'), false)
assert.deepEqual(sorted(reachableWorkspaceIds(index, pipelines, 'D')), ['D'])
assert.deepEqual(sorted(reachableWorkspaceIds(index, pipelines, 'unknown')), [])
assert.equal(pipelineLinking(pipelines, 'A', 'C'), undefined)
assert.equal(pipelineLinking(pipelines, 'A', 'B').id, 'p1')
assert.equal(pipelineLinking(pipelines, 'B', 'C').id, 'p2')

// a disabled pipeline contributes nothing, even if it names both workspaces
const disabled = [
  { id: 'p1', title: 'P1', enabled: true, workspaceIds: ['A', 'B'] },
  { id: 'p2', title: 'P2', enabled: false, workspaceIds: ['B', 'C'] },
]
assert.deepEqual(sorted(reachableWorkspaceIds(index, disabled, 'B')), ['A', 'B'])
assert.equal(authorizeTarget(index, disabled, 'B', 'C').code, 'PIPE_NOT_REACHABLE')

// --- authorization ---------------------------------------------------------
assert.deepEqual(authorizeTarget(index, pipelines, 'A', 'B'), { ok: true, pipeline: pipelines[0] })
assert.deepEqual(authorizeTarget(index, pipelines, 'B', 'B'), { ok: true, pipeline: undefined })
assert.equal(authorizeTarget(index, pipelines, 'A', 'C').code, 'PIPE_NOT_REACHABLE')
assert.equal(authorizeTarget(index, pipelines, 'C', 'A').code, 'PIPE_NOT_REACHABLE')
assert.equal(authorizeTarget(index, pipelines, 'unknown', 'A').code, 'PIPE_SENDER_UNGROUPED')
assert.equal(authorizeTarget(index, pipelines, 'A', 'unknown').code, 'PIPE_TARGET_WORKSPACE_UNKNOWN')

// --- workspace refs --------------------------------------------------------
assert.equal(resolveWorkspaceRef(index, 'A').workspace.id, 'A')
assert.equal(resolveWorkspaceRef(index, 'alpha').workspace.id, 'A')
assert.equal(resolveWorkspaceRef(index, '  ALPHA ').workspace.id, 'A')
assert.equal(resolveWorkspaceRef(index, 'C:/work/beta').workspace.id, 'B')
assert.equal(resolveWorkspaceRef(index, 'nope').code, 'PIPE_TARGET_WORKSPACE_UNKNOWN')
assert.equal(resolveWorkspaceRef(index, '   ').code, 'PIPE_TARGET_WORKSPACE_REQUIRED')

const duplicated = buildWorkspaceIndex([
  { id: 'X', title: 'Same', path: 'C:/x', sessionIds: [] },
  { id: 'Y', title: 'same', path: 'C:/y', sessionIds: [] },
])
const ambiguous = resolveWorkspaceRef(duplicated, 'Same')
assert.equal(ambiguous.ok, false)
assert.equal(ambiguous.code, 'PIPE_TARGET_WORKSPACE_AMBIGUOUS')
assert.equal(ambiguous.candidates.length, 2)

// --- session refs ----------------------------------------------------------
const sessions = [
  { sessionId: 'session-1111', title: 'Design review' },
  { sessionId: 'session-2222', title: 'Build logs' },
]
assert.equal(resolveSessionRef(sessions, 'session-1111').session.title, 'Design review')
assert.equal(resolveSessionRef(sessions, 'design REVIEW').session.sessionId, 'session-1111')
assert.equal(resolveSessionRef(sessions, 'session-').code, 'PIPE_TARGET_AMBIGUOUS')
assert.equal(resolveSessionRef(sessions, 'missing').code, 'PIPE_TARGET_NOT_FOUND')
assert.equal(resolveSessionRef(sessions, '').code, 'PIPE_TARGET_SESSION_REQUIRED')

// --- pipeline drafts -------------------------------------------------------
const draft = normalizePipelineDraft({ title: '  Group  ', workspaceIds: ['A', 'A', 'B', ' '] })
assert.equal(draft.ok, true)
assert.equal(draft.draft.title, 'Group')
assert.deepEqual(draft.draft.workspaceIds, ['A', 'B'])
assert.equal(normalizePipelineDraft({ title: '', workspaceIds: ['A'] }).code, 'PIPE_TITLE_REQUIRED')
assert.equal(normalizePipelineDraft({ title: 'x'.repeat(PIPE_LIMITS.maxTitleLength + 1), workspaceIds: ['A'] }).code, 'PIPE_TITLE_TOO_LONG')
assert.equal(normalizePipelineDraft({ title: 'x', workspaceIds: [] }).code, 'PIPE_WORKSPACES_REQUIRED')
const tooMany = Array.from({ length: PIPE_LIMITS.maxWorkspacesPerPipeline + 1 }, (_, i) => `W${i}`)
assert.equal(normalizePipelineDraft({ title: 'x', workspaceIds: tooMany }).code, 'PIPE_WORKSPACES_TOO_MANY')
assert.equal(normalizePipelineDraft({ title: 'x', workspaceIds: ['A'], description: 'd'.repeat(PIPE_LIMITS.maxDescriptionLength + 1) }).code, 'PIPE_DESCRIPTION_TOO_LONG')

// --- per-pipeline settings -------------------------------------------------
const withSettings = normalizePipelineDraft({
  title: 'Limited',
  workspaceIds: ['A', 'B'],
  settings: { maxMessageBytes: 4096, maxQueuedPerTarget: 5, maxSendsPerMinute: 3, defaultWake: true },
})
assert.equal(withSettings.ok, true)
assert.deepEqual(withSettings.draft.settings, {
  maxMessageBytes: 4096,
  maxQueuedPerTarget: 5,
  maxSendsPerMinute: 3,
  defaultWake: true,
})
assert.deepEqual(normalizePipelineDraft({ title: 'x', workspaceIds: ['A'] }).draft.settings, {})
assert.equal(normalizePipelineSettings(undefined).settings.maxMessageBytes, undefined)
assert.equal(normalizePipelineSettings({ maxMessageBytes: 512 }).field, 'maxMessageBytes')
assert.equal(normalizePipelineSettings({ maxMessageBytes: 1024 * 1024 }).field, 'maxMessageBytes')
assert.equal(normalizePipelineSettings({ maxQueuedPerTarget: 0 }).field, 'maxQueuedPerTarget')
assert.equal(normalizePipelineSettings({ maxSendsPerMinute: 'fast' }).field, 'maxSendsPerMinute')
assert.equal(normalizePipelineSettings({ defaultWake: 'yes' }).field, 'defaultWake')
assert.equal(normalizePipelineSettings([]).code, 'PIPE_SETTINGS_INVALID')
assert.deepEqual(normalizePipelineSettings({ maxMessageBytes: 2048.9 }).settings, { maxMessageBytes: 2048 })
assert.equal(normalizePipelineDraft({ title: 'x', workspaceIds: ['A'], settings: { maxMessageBytes: 1 } }).field, 'maxMessageBytes')
// 0 bytes means unlimited; the 1..1023 gap stays invalid
assert.deepEqual(normalizePipelineSettings({ maxMessageBytes: 0 }).settings, { maxMessageBytes: 0 })
assert.equal(normalizePipelineSettings({ maxMessageBytes: 1023 }).field, 'maxMessageBytes')
const unlimitedDraft = normalizePipelineDraft({ title: 'Unlimited', workspaceIds: ['A'], settings: { maxMessageBytes: 0 } })
assert.deepEqual(unlimitedDraft.draft.settings, { maxMessageBytes: 0 })

// --- codes -----------------------------------------------------------------
for (const code of ['PIPE_NOT_REACHABLE', 'PIPE_TARGET_ARCHIVED', 'PIPE_RATE_LIMITED', 'PIPE_SETTINGS_INVALID']) {
  assert.notEqual(describeCode(code), code)
}

console.log('routing.test: ok')
