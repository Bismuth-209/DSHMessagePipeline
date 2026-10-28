/**
 * Durable store for the message-pipeline plugin.
 *
 * A plain JSON document keeps a `link:` bundle free of DSH package imports
 * (DSH packages are not in a profile's resolution path for linked bundles).
 * Writes are atomic (temp file + rename) and serialized by the caller's single
 * event loop; cross-process access is explicitly unsupported.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { normalizePipelineSettings } from './routing.js'

export const STORE_VERSION = 1
export const ACTIVE_STATES = new Set(['queued', 'delivering'])
export const TERMINAL_STATES = new Set(['delivered', 'dropped', 'failed'])
const MESSAGE_STATES = new Set(['queued', 'delivering', 'delivered', 'dropped', 'failed'])

function str(value) {
  return typeof value === 'string' ? value : ''
}

function num(value, fallback) {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

function trimmed(value) {
  return str(value).trim()
}

/** Fresh empty store document. */
export function emptyStore() {
  return { version: STORE_VERSION, settings: {}, pipelines: [], messages: [] }
}

/** Normalize arbitrary parsed JSON into a valid store, dropping unusable rows. */
export function normalizeStore(raw) {
  const store = emptyStore()
  if (raw === null || typeof raw !== 'object') return store
  const globalSettings = normalizePipelineSettings(raw.settings)
  store.settings = globalSettings.ok ? globalSettings.settings : {}

  for (const entry of Array.isArray(raw.pipelines) ? raw.pipelines : []) {
    if (entry === null || typeof entry !== 'object') continue
    const id = trimmed(entry.id)
    const title = trimmed(entry.title)
    if (id.length === 0 || title.length === 0) continue
    const workspaceIds = []
    for (const candidate of Array.isArray(entry.workspaceIds) ? entry.workspaceIds : []) {
      const workspaceId = trimmed(candidate)
      if (workspaceId.length > 0 && !workspaceIds.includes(workspaceId)) workspaceIds.push(workspaceId)
    }
    const createdAt = num(entry.createdAt, 0)
    const settings = normalizePipelineSettings(entry.settings)
    store.pipelines.push({
      id,
      title,
      description: str(entry.description),
      workspaceIds,
      enabled: entry.enabled !== false,
      settings: settings.ok ? settings.settings : {},
      createdAt,
      updatedAt: num(entry.updatedAt, createdAt),
    })
  }

  for (const entry of Array.isArray(raw.messages) ? raw.messages : []) {
    if (entry === null || typeof entry !== 'object') continue
    const id = trimmed(entry.id)
    const targetSessionId = trimmed(entry.targetSessionId)
    if (id.length === 0 || targetSessionId.length === 0) continue
    const createdAt = num(entry.createdAt, 0)
    const state = MESSAGE_STATES.has(entry.state) ? entry.state : 'queued'
    const body = typeof entry.body === 'string' ? entry.body : undefined
    store.messages.push({
      id,
      senderSessionId: str(entry.senderSessionId),
      senderTitle: str(entry.senderTitle),
      senderWorkspaceId: str(entry.senderWorkspaceId),
      senderWorkspaceTitle: str(entry.senderWorkspaceTitle),
      targetSessionId,
      targetWorkspaceId: str(entry.targetWorkspaceId),
      pipelineId: trimmed(entry.pipelineId) || undefined,
      pipelineTitle: trimmed(entry.pipelineTitle) || undefined,
      wake: entry.wake === true,
      state: state === 'delivering' ? 'queued' : state,
      attempts: Math.max(0, Math.trunc(num(entry.attempts, 0))),
      reason: trimmed(entry.reason) || undefined,
      bytes: Math.max(0, Math.trunc(num(entry.bytes, 0))),
      body: ACTIVE_STATES.has(state) ? body : undefined,
      createdAt,
      updatedAt: num(entry.updatedAt, createdAt),
      deliveredAt: typeof entry.deliveredAt === 'number' ? entry.deliveredAt : undefined,
    })
  }

  return store
}

/** Read the store file, returning an empty store on absence or corruption. */
export function readStore(file) {
  if (!existsSync(file)) return emptyStore()
  try {
    return normalizeStore(JSON.parse(readFileSync(file, 'utf8')))
  } catch {
    return emptyStore()
  }
}

/** Write the store atomically. */
export function writeStore(file, store) {
  mkdirSync(path.dirname(file), { recursive: true })
  const temp = `${file}.tmp-${process.pid}-${Date.now()}`
  writeFileSync(temp, `${JSON.stringify(store, null, 2)}\n`, 'utf8')
  renameSync(temp, file)
}

/** Replace the plugin-global settings overrides (validated by the caller). */
export function replaceGlobalSettings(store, settings) {
  store.settings = { ...(settings ?? {}) }
  return store.settings
}

/** Resolve a pipeline by id first, then by unique case-insensitive title. */
export function findPipeline(store, ref) {
  const value = trimmed(ref)
  if (value.length === 0) return undefined
  const byId = store.pipelines.find((pipeline) => pipeline.id === value)
  if (byId !== undefined) return byId
  const matches = store.pipelines.filter((pipeline) => pipeline.title.toLowerCase() === value.toLowerCase())
  return matches.length === 1 ? matches[0] : undefined
}

/** Whether another pipeline already uses the title. */
export function pipelineTitleTaken(store, title, exceptId) {
  const wanted = trimmed(title).toLowerCase()
  return store.pipelines.some((pipeline) => pipeline.id !== exceptId && pipeline.title.toLowerCase() === wanted)
}

/**
 * Create one pipeline record.
 * @returns the created record, or undefined when the pipeline limit is reached.
 */
export function createPipeline(store, draft, now, maxPipelines, id) {
  if (store.pipelines.length >= maxPipelines) return undefined
  const record = {
    id,
    title: draft.title,
    description: draft.description,
    workspaceIds: [...draft.workspaceIds],
    enabled: true,
    settings: { ...(draft.settings ?? {}) },
    createdAt: now,
    updatedAt: now,
  }
  store.pipelines.push(record)
  return record
}

/** Apply a validated patch to one pipeline. */
export function updatePipeline(pipeline, patch, now) {
  if (typeof patch.title === 'string') pipeline.title = patch.title
  if (typeof patch.description === 'string') pipeline.description = patch.description
  if (Array.isArray(patch.workspaceIds)) pipeline.workspaceIds = [...patch.workspaceIds]
  if (typeof patch.enabled === 'boolean') pipeline.enabled = patch.enabled
  if (patch.settings !== undefined && patch.settings !== null && typeof patch.settings === 'object') {
    pipeline.settings = { ...patch.settings }
  }
  pipeline.updatedAt = now
  return pipeline
}

/** Remove one pipeline and drop queued messages that depend on it (returns dropped count). */
export function removePipeline(store, pipelineId, now) {
  const index = store.pipelines.findIndex((pipeline) => pipeline.id === pipelineId)
  if (index < 0) return { removed: false, dropped: 0 }
  const [pipeline] = store.pipelines.splice(index, 1)
  let dropped = 0
  for (const message of store.messages) {
    if (message.state !== 'queued' && message.state !== 'delivering') continue
    if (message.pipelineId !== pipeline.id) continue
    if (message.senderWorkspaceId === message.targetWorkspaceId) continue
    message.state = 'dropped'
    message.reason = 'PIPE_NOT_REACHABLE'
    message.body = undefined
    message.updatedAt = now
    dropped += 1
  }
  return { removed: true, dropped }
}

/** Append one outbox record. */
export function addMessage(store, record) {
  store.messages.push(record)
  return record
}

/** Find one outbox record by id. */
export function findMessage(store, id) {
  return store.messages.find((message) => message.id === id)
}

/** Queued-or-delivering messages for one target, oldest first. */
export function pendingMessagesFor(store, sessionId) {
  return store.messages
    .filter((message) => message.targetSessionId === sessionId && (message.state === 'queued' || message.state === 'delivering'))
    .sort((a, b) => a.createdAt - b.createdAt)
}

/** Count of still-pending messages for one target. */
export function backlogFor(store, sessionId) {
  return pendingMessagesFor(store, sessionId).length
}

/** Distinct target session ids that still have pending messages. */
export function pendingTargets(store) {
  const targets = new Set()
  for (const message of store.messages) {
    if (message.state === 'queued' || message.state === 'delivering') targets.add(message.targetSessionId)
  }
  return [...targets]
}

/** Terminal-state message count used by the audit view. */
export function terminalMessages(store) {
  return store.messages.filter((message) => message.state !== 'queued' && message.state !== 'delivering')
}

/**
 * Drop terminal audit rows beyond the retention window or record cap.
 * Pending rows are never pruned.
 * @returns number of removed rows.
 */
export function pruneMessages(store, { now, retentionDays, maxRecords }) {
  const cutoff = now - Math.max(1, retentionDays) * 24 * 60 * 60 * 1000
  const before = store.messages.length
  store.messages = store.messages.filter((message) => {
    if (message.state === 'queued' || message.state === 'delivering') return true
    return message.updatedAt >= cutoff
  })
  const cap = Math.max(1, maxRecords)
  const terminal = store.messages.filter((message) => message.state !== 'queued' && message.state !== 'delivering')
  if (terminal.length > cap) {
    const removable = new Set(terminal.slice(0, terminal.length - cap).map((message) => message.id))
    store.messages = store.messages.filter((message) => !removable.has(message.id))
  }
  return before - store.messages.length
}

/**
 * Reconcile the store with the live workspace registry.
 *
 * Missing workspaces leave pipelines; archived or vanished targets drop queued
 * messages; reachability lost during queuing also drops them. Returns whether
 * anything changed so the caller only rewrites the file when needed.
 */
export function repairStore(store, { workspaceIds, sessionIds, archivedSessionIds, now }) {
  let changed = false
  for (const pipeline of store.pipelines) {
    const next = pipeline.workspaceIds.filter((id) => workspaceIds.has(id))
    if (next.length !== pipeline.workspaceIds.length) {
      pipeline.workspaceIds = next
      pipeline.updatedAt = now
      changed = true
    }
  }

  // A pipeline that lost every registered workspace is inert: creation already
  // requires at least one workspace, so an empty record can only be residue.
  const keptPipelines = store.pipelines.filter((pipeline) => pipeline.workspaceIds.length > 0)
  if (keptPipelines.length !== store.pipelines.length) {
    store.pipelines = keptPipelines
    changed = true
  }

  for (const message of store.messages) {
    if (message.state !== 'queued' && message.state !== 'delivering') continue
    if (!workspaceIds.has(message.targetWorkspaceId) || !sessionIds.has(message.targetSessionId)) {
      message.state = 'dropped'
      message.reason = 'PIPE_TARGET_GONE'
      message.body = undefined
      message.updatedAt = now
      changed = true
      continue
    }
    if (archivedSessionIds.has(message.targetSessionId)) {
      message.state = 'dropped'
      message.reason = 'PIPE_TARGET_ARCHIVED'
      message.body = undefined
      message.updatedAt = now
      changed = true
      continue
    }
    if (message.pipelineId !== undefined) {
      const pipeline = store.pipelines.find((candidate) => candidate.id === message.pipelineId)
      const linked = pipeline !== undefined
        && pipeline.enabled === true
        && pipeline.workspaceIds.includes(message.senderWorkspaceId)
        && pipeline.workspaceIds.includes(message.targetWorkspaceId)
      if (!linked) {
        message.state = 'dropped'
        message.reason = 'PIPE_NOT_REACHABLE'
        message.body = undefined
        message.updatedAt = now
        changed = true
      }
    }
  }

  return changed
}
