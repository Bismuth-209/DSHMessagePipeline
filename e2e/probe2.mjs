/** Probe: selectModel, commands/execute (correct args), session/inspect. */
import { randomUUID } from 'node:crypto'

const base = process.env.E2E_BASE_URL ?? 'http://127.0.0.1:3099'
const token = process.argv[2]
const sessionId = process.argv[3]
const provider = process.env.E2E_PROVIDER ?? 'deepseek-account'
const model = process.env.E2E_MODEL ?? 'deepseek-flash'

function cookies(response) {
  const list = typeof response.headers.getSetCookie === 'function'
    ? response.headers.getSetCookie()
    : [response.headers.get('set-cookie')].filter(Boolean)
  return list.map((value) => value.split(';', 1)[0]).join('; ')
}

const page = await fetch(`${base}/?token=${encodeURIComponent(token)}`, { redirect: 'manual' })
const cookie = cookies(page)

async function rpc(endpoint, args) {
  const response = await fetch(`${base}/api/${endpoint}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify({ type: 'client-request', rpcId: randomUUID(), method: endpoint, payload: { args } }),
  })
  const parsed = await response.json()
  if (parsed.result?.ok !== true) throw new Error(`${endpoint}: ${JSON.stringify(parsed.result?.error ?? parsed)}`)
  return parsed.result.value
}

const selection = await rpc('session/selectModel', { request: { sessionId, provider, model } })
console.log('selectModel:', JSON.stringify(selection))

const listed = await rpc('commands/execute', { agentId: sessionId, line: '/pipe list', submittedAttachments: [] })
console.log('commands/execute:', JSON.stringify(listed))

const inspect = await rpc('session/inspect', { sessionId })
console.log('inspect keys:', Object.keys(inspect), 'events:', inspect.events?.length)
console.log('inspect last types:', (inspect.events ?? []).slice(-4).map((event) => event.type).join(','))
