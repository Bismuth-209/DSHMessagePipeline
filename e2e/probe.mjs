/**
 * Protocol probe for the DSH web gateway: exchange the launch token for a
 * browser-session cookie, then call unary Remote methods over POST /api/<ns>/<method>.
 *
 * usage: node probe.mjs <baseUrl> <launchToken>
 *
 * Creates one test workspace under E2E_WORKSPACE_ROOT (default: <tmp>/dsh-message-pipeline-e2e/workspaces).
 */
import { randomUUID } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

const base = process.argv[2] ?? 'http://127.0.0.1:3099'
const token = process.argv[3]
if (!token) {
  console.error('usage: node probe.mjs <baseUrl> <launchToken>')
  process.exit(2)
}

function cookieHeaderFrom(response) {
  const cookies = typeof response.headers.getSetCookie === 'function'
    ? response.headers.getSetCookie()
    : [response.headers.get('set-cookie')].filter(Boolean)
  return cookies.map((value) => value.split(';', 1)[0]).join('; ')
}

const page = await fetch(`${base}/?token=${encodeURIComponent(token)}`, { redirect: 'manual' })
const cookie = cookieHeaderFrom(page)
console.log('page', page.status, 'cookie?', cookie.length > 0)

async function rpc(endpoint, args) {
  const body = {
    type: 'client-request',
    rpcId: randomUUID(),
    method: endpoint,
    payload: { args },
  }
  const response = await fetch(`${base}/api/${endpoint}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(cookie.length > 0 ? { cookie } : {}) },
    body: JSON.stringify(body),
  })
  const text = await response.text()
  let parsed
  try {
    parsed = JSON.parse(text)
  } catch {
    throw new Error(`HTTP ${response.status} non-JSON: ${text.slice(0, 400)}`)
  }
  if (parsed.result?.ok !== true) throw new Error(`HTTP ${response.status} failed: ${JSON.stringify(parsed.result?.error ?? parsed).slice(0, 600)}`)
  return parsed.result.value
}

const catalog = await rpc('session/modelCatalog', {})
console.log('modelCatalog groups:', (catalog.groups ?? []).map((group) => `${group.id}:${(group.models ?? []).map((model) => model.id).join(',')}`).join(' | '))

const workspaceRoot = process.env.E2E_WORKSPACE_ROOT ?? path.join(tmpdir(), 'dsh-message-pipeline-e2e', 'workspaces')
const workspacePath = path.join(workspaceRoot, 'test1')
mkdirSync(workspacePath, { recursive: true })
const created = await rpc('workspace/create', { request: { path: workspacePath } })
console.log('workspace/create:', JSON.stringify(created))

const session = await rpc('session/create', { request: { workspaceId: created.workspace.workspaceId } })
console.log('session/create:', JSON.stringify(session))

const listed = await rpc('session/list', { _request: {} })
console.log('session/list items:', (listed.items ?? []).map((item) => `${item.sessionId}:${item.cwd}:running=${item.running}`).join(' | '))

const command = await rpc('commands/execute', { sessionId: session.sessionId, line: '/pipe list', args: [] })
console.log('commands/execute:', JSON.stringify(command).slice(0, 500))
