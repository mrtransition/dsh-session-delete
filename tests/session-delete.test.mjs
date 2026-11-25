/**
 * Deterministic checks for the @local/dsh-session-delete bundle.
 * Runs the real Host half against a stub Cordis context and a temporary
 * session directory, then runs the real browser half through a stub
 * module loader and React. No DSH instance, browser, or network is involved.
 */
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, readdir, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const bundle = join(here, '..')
let passed = 0
const check = (name, fn) => {
  try {
    fn()
    passed += 1
  } catch (error) {
    console.error(`FAIL: ${name}`)
    throw error
  }
}

// ---------------------------------------------------------------- host half
const hostModule = await import(pathToFileURL(join(bundle, 'index.js')).href)

/**
 * Build a stub Host context around one temp session directory.
 * @param options - overrides for liveness, schedule, registry, header, and path.
 */
async function makeHost(options = {}) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-session-delete-'))
  const project = join(root, '--E-workspace-demo--')
  const sessionId = options.sessionId ?? 'session-test-0001'
  const directory = join(project, sessionId)
  await mkdir(directory, { recursive: true })
  const logPath = join(directory, 'session.v4.jsonl.zstd')
  await writeFile(logPath, 'log-bytes')
  await writeFile(join(directory, 'session.lock'), '')
  if (options.extraFile === true) await writeFile(join(directory, 'notes.txt'), 'keep me')

  const calls = { unarchive: [], unpin: [], detach: [], registered: [] }
  const live = new Map(options.liveSessions ?? [])
  const header = {
    version: 4,
    id: sessionId,
    createdAt: 1,
    cwd: 'E:\\workspace\\demo',
    ...(options.parentSession === undefined ? {} : { parentSession: options.parentSession }),
    ...(options.origin === undefined ? {} : { origin: options.origin }),
  }
  const snapshot = options.stored === false ? undefined : {
    header,
    revision: 'r1',
    location: { kind: 'jsonl', path: options.logPath ?? logPath },
  }
  const workspace = {
    id: 'ws-1',
    sessionIds: options.member === false ? [] : [sessionId],
    detachSession: async (id) => { calls.detach.push(id) },
  }
  const registry = {
    archivedSessionIds: options.archived === true ? [sessionId] : [],
    pinnedSessionIds: options.pinned === true ? [sessionId] : [],
    list: () => [workspace],
    unarchiveSession: async (id) => { calls.unarchive.push(id) },
    unpinSession: async (id) => { calls.unpin.push(id) },
  }
  const schedule = options.scheduled === true
    ? { list: async () => ({ items: [{ status: 'active', target: { kind: 'session', sessionId } }], total: 1 }) }
    : undefined

  const ctx = {
    logger: { warn: () => {} },
    get: (name) => {
      if (name === 'schedule') return schedule
      if (name === 'agents') return { get: (id) => live.get(id) }
      return undefined
    },
    sessions: { get: (id) => live.get(id)?.session },
    sessionPersistence: {
      stat: async () => snapshot,
      list: async () => {
        if (options.children === true) return [{ header: { id: 'child-1', parentSession: sessionId } }]
        return snapshot === undefined ? [] : [snapshot]
      },
    },
    workspaceRegistry: registry,
    connection: {
      fetch: {
        register: (route) => {
          calls.registered.push(route)
          return async () => {}
        },
      },
    },
    effect: (factory) => { const dispose = factory(); return dispose },
  }

  hostModule.apply(ctx)
  const route = calls.registered[0]
  assert.equal(route.path, '/api/session-delete')
  assert.deepEqual(route.methods, ['POST'])

  const post = async (body, method = 'POST') => {
    const response = await route.fetch(new Request('http://127.0.0.1/api/session-delete', {
      method,
      headers: { 'content-type': 'application/json' },
      body: method === 'POST' ? JSON.stringify(body) : undefined,
    }))
    return { status: response.status, body: await response.json() }
  }

  return { root, directory, sessionId, logPath, calls, post, cleanup: () => rm(root, { recursive: true, force: true }) }
}

{
  const host = await makeHost()
  const result = await host.post({ sessionId: host.sessionId })
  check('host: deletes a stored session', () => {
    assert.equal(result.status, 200)
    assert.deepEqual(result.body.ok, true)
    assert.equal(result.body.removed, 2)
  })
  check('host: removes every owned file and the session directory', async () => {
    assert.equal(await stat(host.directory).then(() => true, () => false), false)
  })
  check('host: clears archive, pin, and workspace membership', () => {
    assert.deepEqual(host.calls.detach, [host.sessionId])
  })
  await host.cleanup()
}

{
  const host = await makeHost({ extraFile: true })
  const result = await host.post({ sessionId: host.sessionId })
  const entries = await readdir(host.directory)
  check('host: keeps unexpected files and reports them', () => {
    assert.equal(result.status, 200)
    assert.deepEqual(entries, ['notes.txt'])
    assert.deepEqual(result.body.leftover, ['notes.txt'])
  })
  await host.cleanup()
}

{
  const host = await makeHost({ stored: false })
  const result = await host.post({ sessionId: host.sessionId })
  check('host: refuses a session with no stored log', () => {
    assert.equal(result.status, 404)
    assert.equal(result.body.code, 'session_not_stored')
  })
  await host.cleanup()
}

{
  const host = await makeHost({ liveSessions: [['session-test-0001', { session: {}, status: 'idle' }]] })
  const result = await host.post({ sessionId: host.sessionId })
  check('host: refuses a live session', () => {
    assert.equal(result.status, 409)
    assert.equal(result.body.code, 'session_live')
  })
  await host.cleanup()
}

{
  const host = await makeHost({ liveSessions: [['session-test-0001', { session: {}, status: 'running' }]] })
  const result = await host.post({ sessionId: host.sessionId })
  check('host: refuses a running session before the live check', () => {
    assert.equal(result.status, 409)
    assert.equal(result.body.code, 'session_running')
  })
  await host.cleanup()
}

{
  const host = await makeHost({ origin: 'subagent', parentSession: 'session-parent' })
  const result = await host.post({ sessionId: host.sessionId })
  check('host: refuses a subagent session', () => {
    assert.equal(result.status, 409)
    assert.equal(result.body.code, 'session_subagent')
  })
  await host.cleanup()
}

{
  const host = await makeHost({ children: true })
  const result = await host.post({ sessionId: host.sessionId })
  check('host: refuses a parent that still has stored children', () => {
    assert.equal(result.status, 409)
    assert.equal(result.body.code, 'session_has_children')
  })
  await host.cleanup()
}

{
  const host = await makeHost({ scheduled: true })
  const result = await host.post({ sessionId: host.sessionId })
  check('host: refuses a session targeted by an active scheduled task', () => {
    assert.equal(result.status, 409)
    assert.equal(result.body.code, 'session_scheduled')
  })
  await host.cleanup()
}

{
  const host = await makeHost({ logPath: 'E:\\workspace\\demo\\loose.jsonl' })
  const result = await host.post({ sessionId: host.sessionId })
  check('host: refuses a path outside the session-directory layout', () => {
    assert.equal(result.status, 409)
    assert.equal(result.body.code, 'session_path_unknown')
  })
  await host.cleanup()
}

{
  const host = await makeHost()
  const bad = await host.post({})
  const method = await host.post({}, 'GET')
  check('host: rejects malformed requests', () => {
    assert.equal(bad.status, 400)
    assert.equal(bad.body.code, 'invalid_request')
    assert.equal(method.status, 405)
    assert.equal(method.body.code, 'method_not_allowed')
  })
  const archived = await makeHost({ archived: true, pinned: true })
  await archived.post({ sessionId: archived.sessionId })
  check('host: unarchives and unpins before deleting', () => {
    assert.deepEqual(archived.calls.unarchive, [archived.sessionId])
    assert.deepEqual(archived.calls.unpin, [archived.sessionId])
  })
  await host.cleanup()
  await archived.cleanup()
}

// -------------------------------------------------------------- client half
let captured = null
globalThis.window = {
  __ModuleLoader__: {
    load: (entry) => { captured = entry },
  },
}

/**
 * Minimal React stand-in: components are plain functions, elements are records.
 */
const makeReact = () => {
  const Fragment = Symbol('Fragment')
  const createElement = (type, props, ...children) => ({ type, props: props ?? {}, children })
  return {
    Fragment,
    createElement,
    useRef: (value) => ({ current: value }),
    useEffect: () => {},
    useSyncExternalStore: (subscribe, getSnapshot, selector = (value) => value) => selector(getSnapshot()),
  }
}

const clientSource = await import('node:fs/promises').then(fs => fs.readFile(join(bundle, 'client.js'), 'utf8'))
new Function('window', clientSource)(globalThis.window)
assert.equal(captured.id, '@local/dsh-session-delete')

const react = makeReact()
const requireStub = (specifier) => {
  if (specifier === 'react') return react
  throw new Error(`unexpected require: ${specifier}`)
}
const plugin = captured.factory(requireStub)

check('client: declares the services it needs', () => {
  assert.deepEqual(plugin.inject, ['slots', 'locale', 'contextMenus', 'sessions'])
})

const rows = {
  'session-a': { sessionId: 'session-a', displayTitle: 'Alpha', blank: false, running: false },
  'session-b': { sessionId: 'session-b', displayTitle: 'Bravo', blank: false, running: true },
  'session-c': { sessionId: 'session-c', displayTitle: 'Charlie', blank: true, running: false },
  'session-d': { sessionId: 'session-d', displayTitle: 'Delta', blank: false, running: false, origin: 'subagent' },
}

const client = {
  dictionaries: [],
  menus: [],
  slotEntries: [],
  notices: [],
  refresh: 0,
  locale: {
    register: (ns, dicts) => { client.dictionaries.push({ ns, dicts }); return () => {} },
    bind: (ns) => {
      const dict = () => undefined
      return (key, params) => {
        const table = client.dictionaries.find(entry => entry.ns === ns)?.dicts ?? {}
        const text = table.en?.[key] ?? key
        if (params === undefined) return text
        return Object.entries(params).reduce((acc, [name, value]) => acc.replaceAll(`{${name}}`, String(value)), text)
      }
    },
  },
  slots: {
    inject: (name, factory) => { factory() },
    register: (options, component) => { client.slotEntries.push({ name: options.name, options, component }); return () => {} },
  },
  contextMenus: {
    register: (contribution) => { client.menus.push(contribution); return () => {} },
    notify: (text, success) => { client.notices.push({ text, success }) },
  },
  sessions: {
    list: { getSnapshot: () => ({ byId: rows }) },
    refresh: async () => { client.refresh += 1 },
  },
  effect: (factory) => factory(),
}

plugin.apply(client)

check('client: registers en and zh dictionaries', () => {
  assert.equal(client.dictionaries.length, 1)
  assert.equal(client.dictionaries[0].ns, 'session-delete')
  const { en, zh } = client.dictionaries[0].dicts
  assert.ok(en)
  assert.ok(zh)
  assert.deepEqual(Object.keys(zh).sort(), Object.keys(en).sort())
  for (const [key, value] of Object.entries(en)) {
    assert.equal(typeof value, 'string')
    assert.ok(value.length > 0, `empty copy for ${key}`)
  }
})

check('client: registers one session menu contribution with the shipped presentation', () => {
  assert.equal(client.menus.length, 1)
  const menu = client.menus[0]
  assert.equal(menu.id, 'session-delete.delete')
  assert.equal(menu.target, 'session')
  assert.equal(menu.order, 700)
  const [item] = menu.resolve({ sessionId: 'session-a', displayTitle: 'Alpha' })
  assert.equal(item.id, 'delete')
  assert.equal(item.danger, true)
  assert.equal(item.separatorBefore, true)
  assert.equal(item.afterContent, true)
  assert.deepEqual(item.icon, { key: 'session-delete.trash' })
})

check('client: hides the entry for running, blank, and subagent rows', () => {
  const menu = client.menus[0]
  for (const id of ['session-b', 'session-c', 'session-d', 'missing']) {
    assert.deepEqual(menu.resolve({ sessionId: id, displayTitle: id }), [])
  }
})

const overlay = client.slotEntries.find(entry => entry.name === 'shell.overlay')
check('client: registers the confirmation overlay and the menu glyph', () => {
  assert.ok(overlay, 'overlay registration missing')
  assert.equal(overlay.options.id, 'session-delete.confirm')
  assert.equal(overlay.options.locale, 'session-delete')
  assert.ok(client.slotEntries.some(entry => entry.name === 'contextMenu.icon' && entry.options.key === 'session-delete.trash'))
})

const injected = overlay.options.inject()
check('client: the menu entry asks for confirmation instead of deleting immediately', () => {
  client.menus[0].resolve({ sessionId: 'session-a', displayTitle: 'Alpha' })[0].run()
  assert.equal(injected.hooks.confirm.getSnapshot().request.sessionId, 'session-a')
})

check('client: confirmation dialog renders the title and a danger action', () => {
  const element = overlay.component({ useConfirm: (selector) => selector(injected.hooks.confirm.getSnapshot()), ...injected, t: client.locale.bind('session-delete') })
  const html = JSON.stringify(element)
  assert.ok(html.includes('Delete conversation?'))
  assert.ok(html.includes('Alpha'))
  assert.ok(html.includes('sd-danger'))
  assert.ok(html.includes('aria-modal'))
})

const fetchCalls = []
let nextResponse = { ok: true, status: 200, payload: { ok: true, deleted: true } }
globalThis.fetch = async (url, init) => {
  fetchCalls.push({ url, init })
  return { ok: nextResponse.ok, status: nextResponse.status, json: async () => nextResponse.payload }
}

await injected.confirm({ sessionId: 'session-a', displayTitle: 'Alpha' })
check('client: posts JSON to the Host route and refreshes the list', () => {
  assert.equal(fetchCalls.length, 1)
  assert.equal(fetchCalls[0].url, 'api/session-delete')
  assert.equal(fetchCalls[0].init.method, 'POST')
  assert.deepEqual(JSON.parse(fetchCalls[0].init.body), { sessionId: 'session-a' })
  assert.equal(client.refresh, 1)
  assert.deepEqual(client.notices.at(-1), { text: 'Conversation deleted', success: true })
  assert.equal(injected.hooks.confirm.getSnapshot().request, null)
})

nextResponse = { ok: false, status: 409, payload: { ok: false, code: 'session_live', message: 'busy' } }
client.menus[0].resolve({ sessionId: 'session-a', displayTitle: 'Alpha' })[0].run()
await injected.confirm({ sessionId: 'session-a', displayTitle: 'Alpha' })
check('client: maps Host refusals to localized copy and keeps the dialog open', () => {
  const state = injected.hooks.confirm.getSnapshot()
  assert.equal(state.request.sessionId, 'session-a')
  assert.equal(state.error, 'This conversation is loaded in the running Harness, so its log cannot be removed safely. Restart DeepSeek Harness, then delete it from the session list.')
  assert.equal(client.refresh, 1)
  assert.equal(client.notices.length, 1)
})

console.log(`session-delete: ${passed} checks passed`)


