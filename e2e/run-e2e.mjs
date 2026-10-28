/**
 * Real end-to-end test for dsh-message-pipeline.
 *
 * Drives a live `pipeline-test` web instance through its unary Remote HTTP API:
 * creates three workspaces (test1..test3) and sessions, builds two pipelines
 * (P1={test1,test2}, P2={test2,test3}), then asks real model turns to call
 * pipe_send and verifies the resulting session logs on disk.
 *
 * usage: node run-e2e.mjs <baseUrl> <launchToken>
 *
 * env:
 *   DSH_HOME            session log root (default: ~/.dsh)
 *   E2E_WORKSPACE_ROOT  workspace base dir (default: <tmp>/dsh-message-pipeline-e2e/workspaces)
 *   E2E_PROVIDER        model provider for test sessions (default: deepseek-account)
 *   E2E_MODEL           model id for test sessions (default: deepseek-flash)
 */
import { randomUUID } from 'node:crypto'
import { mkdirSync, readdirSync, readFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import path from 'node:path'
import zlib from 'node:zlib'

const base = process.argv[2] ?? 'http://127.0.0.1:3099'
const token = process.argv[3]
if (!token) {
  console.error('usage: node run-e2e.mjs <baseUrl> <launchToken>')
  process.exit(2)
}

const WORKSPACE_ROOT = process.env.E2E_WORKSPACE_ROOT ?? path.join(tmpdir(), 'dsh-message-pipeline-e2e', 'workspaces')
const E2E_PROVIDER = process.env.E2E_PROVIDER ?? 'deepseek-account'
const E2E_MODEL = process.env.E2E_MODEL ?? 'deepseek-flash'
const SESSIONS_ROOT = path.join(process.env.DSH_HOME || path.join(homedir(), '.dsh'), 'sessions')
const failures = []
const notes = []

function check(condition, message) {
  if (condition) console.log(`PASS ${message}`)
  else {
    console.log(`FAIL ${message}`)
    failures.push(message)
  }
}

// ------------------------------------------------------------------ gateway
function cookieHeader(response) {
  const list = typeof response.headers.getSetCookie === 'function'
    ? response.headers.getSetCookie()
    : [response.headers.get('set-cookie')].filter(Boolean)
  return list.map((value) => value.split(';', 1)[0]).join('; ')
}

const page = await fetch(`${base}/?token=${encodeURIComponent(token)}`, { redirect: 'manual' })
const cookie = cookieHeader(page)
check(cookie.length > 0, 'launch token exchanged for a browser-session cookie')

async function rpc(endpoint, args) {
  const response = await fetch(`${base}/api/${endpoint}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify({ type: 'client-request', rpcId: randomUUID(), method: endpoint, payload: { args } }),
  })
  const text = await response.text()
  let parsed
  try {
    parsed = JSON.parse(text)
  } catch {
    throw new Error(`${endpoint}: HTTP ${response.status} ${text.slice(0, 300)}`)
  }
  if (parsed.result?.ok !== true) throw new Error(`${endpoint}: ${JSON.stringify(parsed.result?.error ?? parsed).slice(0, 800)}`)
  return parsed.result.value
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

async function listSessions() {
  const value = await rpc('session/list', { _request: {} })
  return value.items ?? []
}

async function findSession(sessionId) {
  return (await listSessions()).find((item) => item.sessionId === sessionId)
}

async function waitIdle(sessionId, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs
  // Give the driver a moment to flip the status before sampling.
  await sleep(1500)
  while (Date.now() < deadline) {
    const row = await findSession(sessionId)
    if (row === undefined) throw new Error(`${label}: session ${sessionId} vanished`)
    if (row.running !== true) {
      await sleep(2000) // let persistence settle after the turn
      return
    }
    await sleep(2000)
  }
  throw new Error(`${label}: timed out after ${timeoutMs}ms waiting for idle`)
}

async function prompt(sessionId, text, label) {
  console.log(`prompt ${label} (${sessionId})`)
  await rpc('session/prompt', {
    request: {
      sessionId,
      requestId: `e2e-${label}-${Date.now()}`,
      mode: 'queue',
      content: [{ type: 'text', text }],
    },
  })
}

async function runPipeCommand(agentId, line) {
  const value = await rpc('commands/execute', { agentId, line, submittedAttachments: [] })
  const result = value?.result
  if (result === undefined) return { ok: false, kind: 'undefined', text: '' }
  return { ok: result.kind === 'success', kind: result.kind, text: result.text ?? '' }
}

// ---------------------------------------------------------------- workspaces
async function ensureWorkspace(name) {
  const workspacePath = path.join(WORKSPACE_ROOT, name)
  mkdirSync(workspacePath, { recursive: true })
  const created = await rpc('workspace/create', { request: { path: workspacePath } })
  const workspace = created.workspace
  console.log(`workspace ${name}: ${workspace.workspaceId} created=${created.created}`)
  return workspace
}

async function createSession(workspaceId) {
  const value = await rpc('session/create', { request: { workspaceId } })
  await rpc('session/selectModel', {
    request: { sessionId: value.sessionId, provider: E2E_PROVIDER, model: E2E_MODEL },
  })
  return value.sessionId
}

// --------------------------------------------------------------------- logs
function logFileFor(sessionId) {
  let entries
  try {
    entries = readdirSync(SESSIONS_ROOT, { withFileTypes: true })
  } catch {
    return undefined
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const candidate = path.join(SESSIONS_ROOT, entry.name, sessionId, 'session.v4.jsonl.zstd')
    try {
      readFileSync(candidate)
      return candidate
    } catch {
      /* keep looking */
    }
  }
  return undefined
}

function readSessionLog(sessionId) {
  const file = logFileFor(sessionId)
  if (file === undefined) throw new Error(`no session log for ${sessionId}`)
  const text = zlib.zstdDecompressSync(readFileSync(file)).toString('utf8')
  return text.split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line) => {
      try { return JSON.parse(line) } catch { return undefined }
    })
    .filter(Boolean)
}

function relayedMessages(events) {
  const rows = []
  for (const event of events) {
    if (event.type !== 'user/message') continue
    const data = event.data ?? {}
    if (data.source?.kind !== 'agent-message') continue
    rows.push({
      senderSessionId: data.source.senderSessionId,
      text: (data.content ?? []).map((block) => block?.text ?? '').join('\n'),
    })
  }
  return rows
}

function eventText(events) {
  return events.map((event) => JSON.stringify(event.data ?? '')).join('\n')
}

/** Pair tool results with their call names; result text is the rendered JSON the model saw. */
function toolResults(events) {
  const names = new Map()
  for (const event of events) {
    if (event.type === 'tool/call') names.set(event.data?.callId, event.data?.name)
  }
  const rows = []
  for (const event of events) {
    if (event.type !== 'tool/result') continue
    const message = event.data?.message ?? {}
    const text = (message.content ?? []).map((block) => block?.text ?? '').join('\n')
    rows.push({ name: names.get(message.toolCallId) ?? '?', isError: message.isError === true, text })
  }
  return rows
}

// --------------------------------------------------------------------- run
console.log('--- setup ---')
const workspace1 = await ensureWorkspace('test1')
const workspace2 = await ensureWorkspace('test2')
const workspace3 = await ensureWorkspace('test3')

const s1 = await createSession(workspace1.workspaceId)
const s2 = await createSession(workspace2.workspaceId)
const s3 = await createSession(workspace3.workspaceId)
const s1b = await createSession(workspace1.workspaceId) // same-workspace target, stays cold
console.log(`sessions: s1=${s1} s2=${s2} s3=${s3} s1b=${s1b}`)

const stamp = Date.now().toString(36)
const p1 = await runPipeCommand(s1, `/pipe create ${JSON.stringify({ title: `P1-${stamp}`, workspaceIds: [workspace1.workspaceId, workspace2.workspaceId] })}`)
const p2 = await runPipeCommand(s1, `/pipe create ${JSON.stringify({ title: `P2-${stamp}`, workspaceIds: [workspace2.workspaceId, workspace3.workspaceId] })}`)
check(p1.ok, `pipeline P1 created (${p1.text.slice(0, 120)})`)
check(p2.ok, `pipeline P2 created (${p2.text.slice(0, 120)})`)

console.log('--- turn 1: session in test1 ---')
await prompt(s1, [
  'You are an end-to-end test driver. Follow these steps exactly and do nothing else.',
  '1) Call pipe_list once with no arguments.',
  `2) Call pipe_send with target {"workspace":"test2","session":"${s2}"}, message "E2E-A2B direct", wake true.`,
  `3) Call pipe_send with target {"workspace":"test3","session":"${s3}"}, message "E2E-A2C must fail", wake true.`,
  `4) Call pipe_send with target {"workspace":"test1","session":"${s1b}"}, message "E2E-A2A same workspace", wake true.`,
  '5) Reply with exactly one line of the form: A2B=<state> A2C=<code> A2A=<state>.',
  'Do not call any other tool and do not read or write files.',
].join('\n'), 's1')
await waitIdle(s1, 300_000, 's1')

console.log('--- turn 2: session in test2 ---')
await prompt(s2, [
  'You are an end-to-end test driver. Follow these steps exactly and do nothing else.',
  '1) Call pipe_list once with no arguments.',
  `2) Call pipe_send with target {"workspace":"test3","session":"${s3}"}, message "E2E-B2C direct", wake true.`,
  '3) Reply with exactly one line of the form: B2C=<state>.',
  'Do not call any other tool and do not read or write files.',
].join('\n'), 's2')
await waitIdle(s2, 300_000, 's2')

// Targets were woken by delivery; let their turns settle.
await waitIdle(s3, 300_000, 's3')
await waitIdle(s1b, 300_000, 's1b')

console.log('--- verify logs ---')
const events1 = readSessionLog(s1)
const events2 = readSessionLog(s2)
const events3 = readSessionLog(s3)
const events1b = readSessionLog(s1b)

const s2Relayed = relayedMessages(events2)
const s3Relayed = relayedMessages(events3)
const s1bRelayed = relayedMessages(events1b)
const s1Tools = toolResults(events1)
const s2Tools = toolResults(events2)
const s3Text = eventText(events3)

const s1PipeTools = s1Tools.filter((row) => row.name === 'pipe_list' || row.name === 'pipe_send')
const s2PipeTools = s2Tools.filter((row) => row.name === 'pipe_list' || row.name === 'pipe_send')

check(s1PipeTools.length >= 4, `test1 model called pipe_list and pipe_send (${s1PipeTools.length} calls)`)
check(
  s1PipeTools.every((row) => !row.isError),
  'every test1 pipeline tool call returned lossless, accepted output',
)
check(
  s1PipeTools.some((row) => row.text.includes('"reachableWorkspaces"')),
  'pipe_list returned the reachable workspace view',
)
check(
  s1PipeTools.some((row) => row.text.includes('"state": "delivered"')),
  'test1 saw a delivered pipe_send receipt',
)
check(
  s1PipeTools.some((row) => row.text.includes('PIPE_NOT_REACHABLE')),
  'test1 saw PIPE_NOT_REACHABLE for the test3 target',
)
check(
  s2PipeTools.some((row) => !row.isError && row.text.includes('"state": "delivered"')),
  'test2 saw a delivered pipe_send receipt for test3',
)

check(
  s2Relayed.some((row) => row.senderSessionId === s1 && row.text.includes('E2E-A2B direct')),
  'test2 session received "E2E-A2B direct" from test1 (P1, cross-workspace)',
)
check(
  s2Relayed.some((row) => row.text.includes('lower priority') && row.text.includes('high-risk')),
  'relayed message carries the peer-priority reminder',
)
check(
  s3Relayed.some((row) => row.senderSessionId === s2 && row.text.includes('E2E-B2C direct')),
  'test3 session received "E2E-B2C direct" from test2 (P2, cross-workspace)',
)
check(
  s1bRelayed.some((row) => row.senderSessionId === s1 && row.text.includes('E2E-A2A same workspace')),
  'same-workspace session s1b received "E2E-A2A same workspace" without a pipeline',
)
check(!s3Text.includes('E2E-A2C must fail'), 'test3 never received the A->C message (pipelines do not compose)')

const storePath = path.join(process.env.DSH_HOME || path.join(homedir(), '.dsh'), 'message-pipeline.json')
let store
try {
  store = JSON.parse(readFileSync(storePath, 'utf8'))
} catch (error) {
  failures.push(`cannot read plugin store: ${String(error)}`)
}
if (store !== undefined) {
  const delivered = (store.messages ?? []).filter((row) => row.state === 'delivered')
  console.log(`store: pipelines=${(store.pipelines ?? []).length} delivered=${delivered.length}`)
  check((store.pipelines ?? []).length >= 2, 'plugin store records both pipelines')
  check(delivered.length >= 3, 'plugin store records at least three delivered messages')
  check(delivered.every((row) => row.body === undefined), 'terminal store rows never keep the message body')
}

notes.push(`s1=${s1}`)
notes.push(`s2=${s2}`)
notes.push(`s3=${s3}`)
notes.push(`s1b=${s1b}`)
notes.push(`workspaces=${[workspace1.workspaceId, workspace2.workspaceId, workspace3.workspaceId].join(',')}`)
console.log('--- summary ---')
console.log(notes.join('\n'))
if (failures.length > 0) {
  console.error(`E2E FAILED: ${failures.length} check(s)`)
  for (const failure of failures) console.error(` - ${failure}`)
  process.exit(1)
}
console.log('E2E PASSED')
