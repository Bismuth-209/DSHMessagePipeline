/**
 * Integration test for the host plugin against a fake host context.
 *
 * Exercises the reachability rule, the scoped tool installation, the system
 * prompt policy, the queued/delivered/wake delivery paths, archived targets,
 * and the `/pipe` management command without booting the harness.
 */
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

process.env.DSH_HOME = mkdtempSync(path.join(tmpdir(), 'message-pipeline-int-'))

const { apply, normalizeConfig } = await import('../lib/index.js')

// --- plugin config coercion -------------------------------------------------
assert.equal(normalizeConfig({ maxMessageBytes: 0 }).maxMessageBytes, 0)
assert.equal(normalizeConfig({ maxMessageBytes: 12 }).maxMessageBytes, 1024)
assert.equal(normalizeConfig({ maxMessageBytes: 1e9 }).maxMessageBytes, 262144)
assert.equal(normalizeConfig({ maxMessageBytes: 'big' }).maxMessageBytes, 32768)


// ----------------------------------------------------------------- fixtures
const workspaces = [
  { id: 'A', title: 'Alpha', path: 'C:/a', sessionIds: ['s-a1'] },
  { id: 'B', title: 'Beta', path: 'C:/b', sessionIds: ['s-b1', 's-b2'] },
  { id: 'C', title: 'Gamma', path: 'C:/c', sessionIds: ['s-c1'] },
]
const headers = new Map([
  ['s-a1', { id: 's-a1', cwd: 'C:/a' }],
  ['s-b1', { id: 's-b1', cwd: 'C:/b' }],
  ['s-b2', { id: 's-b2', cwd: 'C:/b' }],
  ['s-c1', { id: 's-c1', cwd: 'C:/c' }],
])
const titles = {
  's-a1': 'Alpha lead',
  's-b1': 'Beta main',
  's-b2': 'Beta secondary',
  's-c1': 'Gamma main',
}

let archived = []

function createAgent(sessionId, { parentSession, origin, status = 'idle' } = {}) {
  const followups = []
  const steers = []
  const scopeTools = []
  const sections = []
  return {
    id: sessionId,
    status,
    session: {
      id: sessionId,
      header: { id: sessionId, cwd: headers.get(sessionId)?.cwd, parentSession, origin },
    },
    ctx: {
      tools: {
        register(tool) {
          scopeTools.push(tool)
          return () => {
            const index = scopeTools.indexOf(tool)
            if (index >= 0) scopeTools.splice(index, 1)
          }
        },
      },
      systemPrompt: {
        section(entry) {
          sections.push(entry)
          return () => {
            const index = sections.indexOf(entry)
            if (index >= 0) sections.splice(index, 1)
          }
        },
      },
    },
    followup(message) { followups.push(message) },
    steer(message) { steers.push(message) },
    followups,
    steers,
    scopeTools,
    sections,
  }
}

function createHost() {
  const agents = new Map()
  const listeners = new Map()
  const commands = []
  const flushes = []
  const surfaces = new Map()

  const host = {
    logger: { info() {}, warn() {} },
    agents: {
      get(id) { return agents.get(id) },
      list() { return [...agents.values()] },
    },
    sessions: {
      async flush(session) { flushes.push(session.id); return true },
    },
    sessionQuery: {
      async listSessions() {
        return [...headers.values()].map((header) => ({ header, live: agents.has(header.id) }))
      },
      async readTitleSnapshots(ids) {
        return ids.map((id) => ({ status: 'fulfilled', value: { session: headers.get(id), title: titles[id] } }))
      },
      async readSurface(id) { return { events: surfaces.get(id) ?? [] } },
    },
    workspaceRegistry: {
      list() {
        return workspaces.map((workspace) => ({
          id: workspace.id,
          title: workspace.title,
          path: workspace.path,
          sessionIds: [...workspace.sessionIds],
        }))
      },
      get archivedSessionIds() { return [...archived] },
    },
    on(event, fn) {
      const list = listeners.get(event) ?? []
      list.push(fn)
      listeners.set(event, list)
      return () => {
        const current = listeners.get(event) ?? []
        const index = current.indexOf(fn)
        if (index >= 0) current.splice(index, 1)
      }
    },
    get(name) {
      if (name === 'commands') return { register(command) { commands.push(command); return () => {} } }
      return undefined
    },
    emit(event, payload) {
      for (const fn of [...(listeners.get(event) ?? [])]) fn(payload)
    },
  }

  // A session controller mock: cold-resume by materializing a live agent.
  host.provider = {
    async resolveAgent(sessionId) {
      const existing = agents.get(sessionId)
      if (existing !== undefined) return { agent: existing }
      if (!headers.has(sessionId)) return { error: { message: 'not found' } }
      const agent = createAgent(sessionId)
      agents.set(sessionId, agent)
      return { agent }
    },
  }
  host.get = ((original) => (name) => name === 'sessionController' ? host.provider : original(name))(host.get)

  host.addAgent = (agent) => {
    agents.set(agent.id, agent)
    host.emit('agent/created', { agent })
    return agent
  }
  host.commands = commands
  host.flushes = flushes
  host.surfaces = surfaces
  host.agentsMap = agents
  return host
}

function parseCommandResult(result) {
  assert.equal(typeof result.text, 'string')
  return JSON.parse(result.text)
}

function findTool(agent, name) {
  return agent.scopeTools.find((tool) => tool.name === name)
}

async function waitFor(check, timeoutMs = 1500) {
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    if (check()) return true
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  return check()
}

/** The harness rejects tool outputs that are not lossless JSON (undefined, NaN, -0, sparse arrays). */
function assertLossless(value, label) {
  assert.deepEqual(JSON.parse(JSON.stringify(value)), value, `${label} must be lossless JSON`)
}

// -------------------------------------------------------------------- setup
const host = createHost()
const dispose = apply(host, {})

const agentA = host.addAgent(createAgent('s-a1'))
const agentB = host.addAgent(createAgent('s-b1'))
const agentC = host.addAgent(createAgent('s-c1'))
const subagent = host.addAgent(createAgent('s-sub', { parentSession: 's-a1', origin: 'subagent' }))

// --- scoped installation ---------------------------------------------------
assert.deepEqual(agentA.scopeTools.map((tool) => tool.name).sort(), ['pipe_list', 'pipe_send'])
assert.equal(subagent.scopeTools.length, 0, 'subagent sessions must not receive the tools')

// --- required system-prompt policy ----------------------------------------
assert.equal(agentA.sections.length, 1)
const policy = agentA.sections[0].text
assert.match(policy, /STRICTLY LOWER than the user's direct instructions/)
assert.match(policy, /Never perform high-risk/)
assert.match(policy, /低于用户直接指令/)
assert.match(policy, /高风险操作/)

// --- management command ----------------------------------------------------
const pipeCommand = host.commands[0]
assert.equal(pipeCommand.name, 'pipe')
const created = parseCommandResult(pipeCommand.handler({ agent: agentA, rawInput: 'create {"title":"P1","workspaceIds":["A","B"],"settings":{"maxMessageBytes":1024}}' }))
assert.equal(created.ok, true)
assert.equal(created.pipeline.enabled, true)
assert.deepEqual(created.pipeline.settings, { maxMessageBytes: 1024 })
const created2 = parseCommandResult(pipeCommand.handler({ agent: agentA, rawInput: 'create {"title":"P2","workspaceIds":["B","C"],"settings":{"defaultWake":true}}' }))
assert.equal(created2.ok, true)
assert.deepEqual(created2.pipeline.settings, { defaultWake: true })
// deployment defaults and per-pipeline overrides are exposed to the panel
const commandList = parseCommandResult(pipeCommand.handler({ agent: agentA, rawInput: 'list' }))
assert.equal(commandList.defaults.maxMessageBytes, 32768)
assert.equal(commandList.pipelines.find((pipeline) => pipeline.title === 'P1').settings.maxMessageBytes, 1024)
// invalid settings are rejected with the field named
const badSettings = parseCommandResult(pipeCommand.handler({ agent: agentA, rawInput: 'create {"title":"P3","workspaceIds":["A"],"settings":{"maxMessageBytes":10}}' }))
assert.equal(badSettings.code, 'PIPE_SETTINGS_INVALID')
assert.equal(badSettings.field, 'maxMessageBytes')
// duplicate titles are rejected
const duplicate = parseCommandResult(pipeCommand.handler({ agent: agentA, rawInput: 'create {"title":"P1","workspaceIds":["A"]}' }))
assert.equal(duplicate.code, 'PIPE_PIPELINE_TITLE_TAKEN')
// unknown workspace is rejected
const unknown = parseCommandResult(pipeCommand.handler({ agent: agentA, rawInput: 'create {"title":"P3","workspaceIds":["A","NOPE"]}' }))
assert.equal(unknown.code, 'PIPE_WORKSPACE_UNKNOWN')

// --- pipe_list -------------------------------------------------------------
const listTool = findTool(agentA, 'pipe_list')
const listed = await listTool.execute({}, { agent: agentA })
assertLossless(listed, 'pipe_list output')
assert.equal(listed.ok, true)
assert.deepEqual(listed.reachableWorkspaces.map((workspace) => workspace.id).sort(), ['A', 'B'])
assert.deepEqual(listed.targets.map((target) => target.sessionId).sort(), ['s-b1', 's-b2'])

// --- A -> C is not reachable (pipelines never compose) --------------------
const sendTool = findTool(agentA, 'pipe_send')
const notReachable = await sendTool.execute({ target: { workspace: 'Gamma', session: 's-c1' }, message: 'hi' }, { agent: agentA })
assert.equal(notReachable.code, 'PIPE_NOT_REACHABLE')

// --- A -> B: live target, delivered immediately ---------------------------
const delivered = await sendTool.execute({ target: { workspace: 'Beta', session: 's-b1' }, message: 'hello beta' }, { agent: agentA })
assertLossless(delivered, 'pipe_send delivered output')
assert.equal(delivered.ok, true)
assert.equal(delivered.state, 'delivered')
assert.equal(agentB.followups.length, 1)
assert.equal(agentB.followups[0].role, 'user')
assert.deepEqual(agentB.followups[0].source, { kind: 'agent-message', form: 'relay', senderSessionId: 's-a1' })
assert.match(agentB.followups[0].content[0].text, new RegExp(`id ${delivered.messageId}`))
assert.match(agentB.followups[0].content[1].text, /hello beta/)
assert.deepEqual(host.flushes, ['s-b1'])

// --- per-pipeline size limit -------------------------------------------------
const tooLarge = await sendTool.execute({ target: { workspace: 'Beta', session: 's-b1' }, message: 'x'.repeat(2000) }, { agent: agentA })
assert.equal(tooLarge.code, 'PIPE_MESSAGE_TOO_LARGE')
// the same body is allowed on the same-workspace path, which has no pipeline
headers.set('s-a2', { id: 's-a2', cwd: 'C:/a' })
titles['s-a2'] = 'Alpha second'
workspaces[0].sessionIds.push('s-a2')
const sameWorkspaceLong = await sendTool.execute({ target: { workspace: 'Alpha', session: 's-a2' }, message: 'y'.repeat(2000) }, { agent: agentA })
assert.equal(sameWorkspaceLong.ok, true)
assert.equal(sameWorkspaceLong.state, 'queued')

// --- A -> B: inactive target queues, then delivers when it wakes ----------
const queued = await sendTool.execute({ target: { workspace: 'Beta', session: 's-b2' }, message: 'wake later' }, { agent: agentA })
assert.equal(queued.ok, true)
assert.equal(queued.state, 'queued')
const agentB2 = host.addAgent(createAgent('s-b2'))
assert.equal(await waitFor(() => agentB2.followups.length === 1), true)
assert.match(agentB2.followups[0].content[1].text, /wake later/)

// --- B -> C works (B sits in both pipelines) ------------------------------
const sendToolB = findTool(agentB, 'pipe_send')
const bToC = await sendToolB.execute({ target: { workspace: 'C', session: 's-c1' }, message: 'hello gamma' }, { agent: agentB })
assert.equal(bToC.ok, true)
assert.equal(bToC.state, 'delivered')
assert.equal(agentC.followups.length, 1)

// --- A -> B with wake=true cold-resumes an inactive target ---------------
workspaces[1].sessionIds.push('s-b3')
headers.set('s-b3', { id: 's-b3', cwd: 'C:/b' })
titles['s-b3'] = 'Beta tertiary'
const woke = await sendTool.execute({ target: { workspace: 'Beta', session: 's-b3' }, message: 'wake now', wake: true }, { agent: agentA })
assert.equal(woke.ok, true)
assert.equal(woke.wake, true)
assert.equal(woke.state, 'delivered')
const agentB3 = host.agentsMap.get('s-b3')
assert.notEqual(agentB3, undefined)
assert.equal(agentB3.followups.length, 1)
assert.match(agentB3.followups[0].content[1].text, /wake now/)

// --- P2 defaultWake=true cold-resumes without an explicit wake flag -------
workspaces[2].sessionIds.push('s-c2')
headers.set('s-c2', { id: 's-c2', cwd: 'C:/c' })
titles['s-c2'] = 'Gamma second'
const autoWake = await sendToolB.execute({ target: { workspace: 'C', session: 's-c2' }, message: 'auto wake' }, { agent: agentB })
assert.equal(autoWake.ok, true)
assert.equal(autoWake.wake, true)
assert.equal(autoWake.state, 'delivered')
const agentC2 = host.agentsMap.get('s-c2')
assert.notEqual(agentC2, undefined)
assert.equal(agentC2.followups.length, 1)

// --- archived target ------------------------------------------------------
archived = ['s-c1']
const archivedAttempt = await sendToolB.execute({ target: { workspace: 'C', session: 's-c1' }, message: 'nope' }, { agent: agentB })
assert.equal(archivedAttempt.code, 'PIPE_TARGET_ARCHIVED')
archived = []

// --- subagent sender has no tools; direct invocation is refused ----------
const refused = await sendTool.execute({ target: { workspace: 'Beta', session: 's-b1' }, message: 'x' }, { agent: subagent })
assert.equal(refused.code, 'PIPE_SENDER_NOT_ROOT')

// --- self message ---------------------------------------------------------
const selfSend = await sendTool.execute({ target: { workspace: 'Alpha', session: 's-a1' }, message: 'x' }, { agent: agentA })
assert.equal(selfSend.code, 'PIPE_SELF_MESSAGE')

// --- settings update replaces overrides -----------------------------------
const settingsUpdate = parseCommandResult(pipeCommand.handler({ agent: agentA, rawInput: `update ${JSON.stringify({ id: created.pipeline.id, settings: { maxSendsPerMinute: 5 } })}` }))
assert.equal(settingsUpdate.ok, true)
assert.deepEqual(settingsUpdate.pipeline.settings, { maxSendsPerMinute: 5 })

// --- plugin-global settings: 0 bytes means unlimited ----------------------
const cleared = parseCommandResult(pipeCommand.handler({ agent: agentA, rawInput: `update ${JSON.stringify({ id: created.pipeline.id, settings: {} })}` }))
assert.equal(cleared.ok, true)
const globalSettings = parseCommandResult(pipeCommand.handler({ agent: agentA, rawInput: `setGlobal ${JSON.stringify({ settings: { maxMessageBytes: 0, maxSendsPerMinute: 100 } })}` }))
assert.equal(globalSettings.ok, true)
assert.equal(globalSettings.defaults.maxMessageBytes, 0)
assert.equal(globalSettings.configDefaults.maxMessageBytes, 32768)
const listedAfterGlobal = parseCommandResult(pipeCommand.handler({ agent: agentA, rawInput: 'list' }))
assert.equal(listedAfterGlobal.defaults.maxMessageBytes, 0)
assert.deepEqual(listedAfterGlobal.globalSettings, { maxMessageBytes: 0, maxSendsPerMinute: 100 })
const unlimitedSend = await sendTool.execute({ target: { workspace: 'Beta', session: 's-b1' }, message: 'z'.repeat(5000) }, { agent: agentA })
assert.equal(unlimitedSend.ok, true)
assert.equal(unlimitedSend.state, 'delivered')

// --- audit ---------------------------------------------------------------
const audit = parseCommandResult(pipeCommand.handler({ agent: agentA, rawInput: 'audit {"limit":10}' }))
assert.equal(audit.ok, true)
assert.equal(audit.total >= 3, true)
assert.equal(audit.messages.some((row) => row.state === 'delivered'), true)
assert.equal(audit.messages.some((row) => row.state === 'queued'), true) // same-workspace cold target stays queued

// --- store persisted -----------------------------------------------------
const storePath = path.join(process.env.DSH_HOME, 'message-pipeline.json')
assert.equal(existsSync(storePath), true)
const persisted = JSON.parse(readFileSync(storePath, 'utf8'))
assert.equal(persisted.pipelines.length, 2)
assert.deepEqual(persisted.settings, { maxMessageBytes: 0, maxSendsPerMinute: 100 })
assert.equal(persisted.messages.every((row) => row.body === undefined || row.state === 'queued'), true)

// --- dispose unwinds scoped registrations --------------------------------
dispose()
assert.equal(agentA.scopeTools.length, 0)
assert.equal(agentA.sections.length, 0)

console.log('plugin.test: ok')
