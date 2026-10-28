/**
 * Pure workspace / pipeline reachability helpers.
 *
 * A pipeline is a hyperedge: a named set of workspaces whose members may all
 * exchange messages with one another. Different pipelines never compose, so
 * reachability is a one-hop set membership test and is never transitive.
 */

/** Hard bounds shared by validation, the command bridge, and the tools. */
export const PIPE_LIMITS = Object.freeze({
  maxTitleLength: 64,
  maxDescriptionLength: 200,
  maxWorkspacesPerPipeline: 32,
  maxPipelines: 64,
})

function text(value) {
  return typeof value === 'string' ? value : ''
}

function sameTitle(a, b) {
  return text(a).trim().toLowerCase() === text(b).trim().toLowerCase()
}

/**
 * Build the read-only workspace index the routing functions consume.
 * @param workspaces - workspace records shaped `{id, title, path, sessionIds}`.
 * @returns index with lookup helpers.
 */
export function buildWorkspaceIndex(workspaces) {
  const byId = new Map()
  for (const workspace of workspaces ?? []) {
    if (workspace == null) continue
    const id = text(workspace.id)
    if (id.length === 0) continue
    byId.set(id, {
      id,
      title: text(workspace.title) || id,
      path: text(workspace.path),
      sessionIds: Array.isArray(workspace.sessionIds) ? workspace.sessionIds.map(String) : [],
    })
  }
  return {
    byId,
    list: [...byId.values()],
    /** Resolve the workspace that accounts for one session, if any. */
    workspaceOfSession(sessionId) {
      for (const workspace of byId.values()) {
        if (workspace.sessionIds.includes(sessionId)) return workspace
      }
      return undefined
    },
  }
}

/**
 * Workspaces reachable from one workspace: itself plus every workspace sharing
 * an enabled pipeline. Disabled pipelines contribute nothing.
 * @param index - result of {@link buildWorkspaceIndex}.
 * @param pipelines - pipeline records `{enabled, workspaceIds}`.
 * @param workspaceId - sender workspace.
 * @returns set of reachable workspace ids, always including the input when known.
 */
export function reachableWorkspaceIds(index, pipelines, workspaceId) {
  const allowed = new Set()
  if (!index.byId.has(workspaceId)) return allowed
  allowed.add(workspaceId)
  for (const pipeline of pipelines ?? []) {
    if (pipeline?.enabled !== true) continue
    const ids = Array.isArray(pipeline.workspaceIds) ? pipeline.workspaceIds.map(String) : []
    if (!ids.includes(workspaceId)) continue
    for (const id of ids) {
      if (index.byId.has(id)) allowed.add(id)
    }
  }
  return allowed
}

/**
 * Find the enabled pipeline directly linking two distinct workspaces.
 * @returns the pipeline record or undefined when no single hyperedge joins them.
 */
export function pipelineLinking(pipelines, a, b) {
  if (a === b) return undefined
  for (const pipeline of pipelines ?? []) {
    if (pipeline?.enabled !== true) continue
    const ids = Array.isArray(pipeline.workspaceIds) ? pipeline.workspaceIds.map(String) : []
    if (ids.includes(a) && ids.includes(b)) return pipeline
  }
  return undefined
}

/**
 * The single authorization predicate for cross-session delivery.
 * @returns `{ok:true, pipeline?}` when the target workspace is reachable from the
 *   sender workspace, or `{ok:false, code}` with a stable error code.
 */
export function authorizeTarget(index, pipelines, senderWorkspaceId, targetWorkspaceId) {
  if (!index.byId.has(senderWorkspaceId)) return { ok: false, code: 'PIPE_SENDER_UNGROUPED' }
  if (!index.byId.has(targetWorkspaceId)) return { ok: false, code: 'PIPE_TARGET_WORKSPACE_UNKNOWN' }
  if (senderWorkspaceId === targetWorkspaceId) return { ok: true, pipeline: undefined }
  const pipeline = pipelineLinking(pipelines, senderWorkspaceId, targetWorkspaceId)
  if (pipeline === undefined) return { ok: false, code: 'PIPE_NOT_REACHABLE' }
  return { ok: true, pipeline }
}

/**
 * Resolve one workspace reference the model supplied: exact id, exact path, or
 * case-insensitive title. Ambiguous titles return candidates instead of guessing.
 */
export function resolveWorkspaceRef(index, ref) {
  const value = text(ref).trim()
  if (value.length === 0) return { ok: false, code: 'PIPE_TARGET_WORKSPACE_REQUIRED' }
  const direct = index.byId.get(value)
  if (direct !== undefined) return { ok: true, workspace: direct }
  const matches = index.list.filter((workspace) => sameTitle(workspace.title, value) || workspace.path === value)
  if (matches.length === 1) return { ok: true, workspace: matches[0] }
  if (matches.length === 0) return { ok: false, code: 'PIPE_TARGET_WORKSPACE_UNKNOWN' }
  return {
    ok: false,
    code: 'PIPE_TARGET_WORKSPACE_AMBIGUOUS',
    candidates: matches.map((workspace) => ({ id: workspace.id, title: workspace.title, path: workspace.path })),
  }
}

/**
 * Resolve one session reference inside a workspace: exact SessionId, exact
 * case-insensitive title, or a unique SessionId prefix.
 */
export function resolveSessionRef(sessions, ref) {
  const value = text(ref).trim()
  if (value.length === 0) return { ok: false, code: 'PIPE_TARGET_SESSION_REQUIRED' }
  const direct = sessions.find((row) => row.sessionId === value)
  if (direct !== undefined) return { ok: true, session: direct }
  const matches = sessions.filter((row) => sameTitle(row.title, value) || row.sessionId.startsWith(value))
  if (matches.length === 1) return { ok: true, session: matches[0] }
  if (matches.length === 0) return { ok: false, code: 'PIPE_TARGET_NOT_FOUND' }
  return {
    ok: false,
    code: 'PIPE_TARGET_AMBIGUOUS',
    candidates: matches.slice(0, 10).map((row) => ({ sessionId: row.sessionId, title: row.title })),
  }
}

/**
 * Validate and normalize a pipeline create/update payload.
 * @returns `{ok:true, draft}` or `{ok:false, code}`.
 */
/**
 * Per-pipeline override bounds. A pipeline may override these four deployment
 * settings; omitted fields inherit the plugin-level configuration.
 */
export const PIPE_SETTING_BOUNDS = Object.freeze({
  maxMessageBytes: { min: 1024, max: 262144, unlimitedAt: 0 },
  maxQueuedPerTarget: { min: 1, max: 512 },
  maxSendsPerMinute: { min: 1, max: 600 },
})

/**
 * Validate per-pipeline / global settings overrides. `maxMessageBytes: 0`
 * means unlimited; any other positive value must fall inside the byte bounds.
 * @returns `{ok:true, settings}` with only the fields that were supplied, or
 *   `{ok:false, code:'PIPE_SETTINGS_INVALID', field}`.
 */
export function normalizePipelineSettings(input) {
  if (input === undefined || input === null) return { ok: true, settings: {} }
  if (typeof input !== 'object' || Array.isArray(input)) return { ok: false, code: 'PIPE_SETTINGS_INVALID' }
  const settings = {}
  for (const key of ['maxMessageBytes', 'maxQueuedPerTarget', 'maxSendsPerMinute']) {
    const value = input[key]
    if (value === undefined || value === null) continue
    if (typeof value !== 'number' || !Number.isFinite(value)) return { ok: false, code: 'PIPE_SETTINGS_INVALID', field: key }
    const bounds = PIPE_SETTING_BOUNDS[key]
    const normalized = Math.trunc(value)
    if (key === 'maxMessageBytes' && normalized === 0) {
      settings[key] = 0
      continue
    }
    if (normalized < bounds.min || normalized > bounds.max) return { ok: false, code: 'PIPE_SETTINGS_INVALID', field: key }
    settings[key] = normalized
  }
  if (input.defaultWake !== undefined && input.defaultWake !== null) {
    if (typeof input.defaultWake !== 'boolean') return { ok: false, code: 'PIPE_SETTINGS_INVALID', field: 'defaultWake' }
    settings.defaultWake = input.defaultWake
  }
  return { ok: true, settings }
}

/**
 * Validate and normalize a pipeline create/update payload.
 * @returns `{ok:true, draft}` or `{ok:false, code}`.
 */
export function normalizePipelineDraft(input) {
  const title = text(input?.title).trim()
  if (title.length === 0) return { ok: false, code: 'PIPE_TITLE_REQUIRED' }
  if (title.length > PIPE_LIMITS.maxTitleLength) return { ok: false, code: 'PIPE_TITLE_TOO_LONG' }
  const description = text(input?.description).trim()
  if (description.length > PIPE_LIMITS.maxDescriptionLength) return { ok: false, code: 'PIPE_DESCRIPTION_TOO_LONG' }
  const workspaceIds = []
  for (const raw of Array.isArray(input?.workspaceIds) ? input.workspaceIds : []) {
    const id = text(raw).trim()
    if (id.length === 0 || workspaceIds.includes(id)) continue
    workspaceIds.push(id)
  }
  if (workspaceIds.length === 0) return { ok: false, code: 'PIPE_WORKSPACES_REQUIRED' }
  if (workspaceIds.length > PIPE_LIMITS.maxWorkspacesPerPipeline) return { ok: false, code: 'PIPE_WORKSPACES_TOO_MANY' }
  const settings = normalizePipelineSettings(input?.settings)
  if (!settings.ok) return settings
  return { ok: true, draft: { title, description, workspaceIds, settings: settings.settings } }
}

/**
 * Human-readable reason for every error code this plugin can return.
 * @param code - stable error code.
 */
export function describeCode(code) {
  const table = {
    PIPE_SENDER_UNGROUPED: 'the calling session is not accounted by any workspace',
    PIPE_SENDER_NOT_ROOT: 'only an ordinary root session can send cross-session messages',
    PIPE_SENDER_ARCHIVED: 'the calling session is archived',
    PIPE_TARGET_WORKSPACE_REQUIRED: 'target.workspace is required',
    PIPE_TARGET_WORKSPACE_UNKNOWN: 'the target workspace is not registered',
    PIPE_TARGET_WORKSPACE_AMBIGUOUS: 'the target workspace title matches more than one workspace; pass the workspace id',
    PIPE_TARGET_SESSION_REQUIRED: 'target.session is required',
    PIPE_TARGET_NOT_FOUND: 'the target session does not belong to that workspace',
    PIPE_TARGET_AMBIGUOUS: 'the target session title matches more than one session; pass the session id',
    PIPE_NOT_REACHABLE: 'the target workspace is not connected to the sender workspace by an enabled pipeline',
    PIPE_TARGET_ARCHIVED: 'the target session is archived',
    PIPE_TARGET_SUBAGENT: 'the target session is owned by subagent routing',
    PIPE_TARGET_GONE: 'the target session no longer belongs to that workspace',
    PIPE_TARGET_NO_CWD: 'the target session has no recorded working directory, so it cannot be resumed',
    PIPE_SELF_MESSAGE: 'a session cannot send a message to itself',
    PIPE_MESSAGE_EMPTY: 'message text must not be empty',
    PIPE_MESSAGE_TOO_LARGE: 'message text exceeds the configured byte limit',
    PIPE_TARGET_BACKLOG: 'the target already has too many queued messages',
    PIPE_RATE_LIMITED: 'the sender exceeded the configured message rate',
    PIPE_TITLE_REQUIRED: 'title is required',
    PIPE_TITLE_TOO_LONG: 'title is too long',
    PIPE_DESCRIPTION_TOO_LONG: 'description is too long',
    PIPE_WORKSPACES_REQUIRED: 'at least one workspace is required',
    PIPE_WORKSPACES_TOO_MANY: 'too many workspaces in one pipeline',
    PIPE_SETTINGS_INVALID: 'a pipeline setting is out of range or has the wrong type',
    PIPE_PIPELINE_LIMIT: 'too many pipelines',
    PIPE_PIPELINE_NOT_FOUND: 'the pipeline does not exist',
    PIPE_PIPELINE_TITLE_TAKEN: 'another pipeline already uses that title',
    PIPE_WORKSPACE_UNKNOWN: 'a listed workspace is not registered',
    PIPE_USER_SESSION_REQUIRED: 'pipeline management requires an ordinary user session',
    PIPE_DISPOSED: 'the message pipeline service is shutting down',
    PIPE_RESUME_UNAVAILABLE: 'the host cannot resume sessions in this composition',
    PIPE_RESUME_TIMEOUT: 'resuming the target session timed out; the message stays queued',
    PIPE_TARGET_NOT_LIVE: 'the target session did not become live; the message stays queued',
    PIPE_INJECT_FAILED: 'the target session rejected the injected message; it stays queued',
  }
  return table[code] ?? code
}
