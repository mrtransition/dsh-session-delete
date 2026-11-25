/**
 * Host half of "Delete session".
 *
 * DSH deliberately ships no session-deletion seam (the persistence README
 * calls pruning "out-of-band backend maintenance"), so this plugin owns the
 * complete operation: it validates that the session is truly deletable, clears
 * the registries that reference it, then removes every stored log generation of
 * that one session directory. The browser half asks through the authenticated
 * `POST /api/session-delete` route and confirms before calling it.
 *
 * Refusals are explicit and non-destructive: a live/attached session, a running
 * turn, a subagent session, a parent that still has stored children, an active
 * scheduled task, or a session with nothing on disk are all reported instead of
 * being deleted.
 */
import { readdir, rm } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'

/** Route the browser half calls (document-relative form: `api/session-delete`). */
const ROUTE = '/api/session-delete'

/** Session ids are opaque strings; bound what a request may hand us. */
const MAX_ID_LENGTH = 200

/** Names this backend owns inside a session directory (all log generations and the lease file). */
const SESSION_OWNED_FILE = /^session(\.[^\\/]+)*$/

/** Services this plugin cannot work without. */
export const inject = ['connection', 'sessions', 'sessionPersistence', 'workspaceRegistry']

/**
 * Register the deletion route.
 * @param ctx - Host context carrying persistence, session store, and workspace registry.
 */
export function apply(ctx) {
  const warn = (message) => {
    try {
      ctx.logger?.warn?.(message)
    } catch {
      // Logging must never turn a successful deletion into a failed request.
    }
  }

  /**
   * Read one optional Host service without failing activation when a
   * composition leaves it out.
   * @param name - service key.
   * @returns the service, or undefined.
   */
  const service = (name) => {
    try {
      return ctx.get(name)
    } catch {
      return undefined
    }
  }

  /**
   * Answer with a JSON body that is never cached.
   * @param status - HTTP status code.
   * @param body - JSON-serializable payload.
   * @returns the response to hand back to the browser.
   */
  const answer = (status, body) => Response.json(body, {
    status,
    headers: { 'cache-control': 'no-store' },
  })

  /**
   * Build a non-destructive refusal.
   * @param status - HTTP status code.
   * @param code - stable machine code the Client maps to localized copy.
   * @param message - English fallback detail.
   * @returns the refusal response.
   */
  const refuse = (status, code, message) => answer(status, { ok: false, code, message })

  /**
   * Clear the durable registries that name one session.
   * Failures are logged and never abort the deletion: a stale id in the archive
   * or pin set is inert, and workspace membership filters unknown sessions on
   * read.
   * @param sessionId - session to forget.
   */
  const forgetSession = async (sessionId) => {
    const registry = ctx.workspaceRegistry
    try {
      if (registry.archivedSessionIds.includes(sessionId)) await registry.unarchiveSession(sessionId)
    } catch (error) {
      warn(`session-delete: could not unarchive ${sessionId}: ${String(error)}`)
    }
    try {
      if (registry.pinnedSessionIds.includes(sessionId)) await registry.unpinSession(sessionId)
    } catch (error) {
      warn(`session-delete: could not unpin ${sessionId}: ${String(error)}`)
    }
    for (const workspace of registry.list()) {
      try {
        if (workspace.sessionIds.includes(sessionId)) await workspace.detachSession(sessionId)
      } catch (error) {
        warn(`session-delete: could not detach ${sessionId} from ${workspace.id}: ${String(error)}`)
      }
    }
  }

  /**
   * Remove every stored artifact of one session directory.
   * Only names this backend owns are touched, and the directory itself is
   * removed only when nothing unexpected remains inside it.
   * @param directory - the session's own directory.
   * @returns names that were removed and unexpected leftovers, if any.
   */
  const removeSessionFiles = async (directory) => {
    let entries
    try {
      entries = await readdir(directory, { withFileTypes: true })
    } catch (error) {
      if (error?.code === 'ENOENT') return { removed: [], leftover: [] }
      throw error
    }
    const owned = entries.filter(entry => entry.isFile() && SESSION_OWNED_FILE.test(entry.name))
    for (const entry of owned) await rm(join(directory, entry.name), { force: true })
    const left = await readdir(directory)
    if (left.length === 0) await rm(directory, { recursive: true, force: true })
    return { removed: owned.map(entry => entry.name), leftover: left }
  }

  /**
   * Count active scheduled tasks that deliver into one session, paging through
   * the Host catalog so a large task list cannot hide a reference.
   * @param schedule - Host schedule service.
   * @param sessionId - session to look for.
   * @returns number of active tasks whose target is that session.
   */
  const scheduledTargets = async (schedule, sessionId) => {
    const pageSize = 200
    let offset = 0
    let count = 0
    for (;;) {
      const page = await schedule.list({ limit: pageSize, offset })
      const items = page?.items ?? []
      for (const task of items) {
        if (task.status === 'active' && task.target?.sessionId === sessionId) count += 1
      }
      offset += items.length
      const total = typeof page?.total === 'number' ? page.total : offset
      if (items.length === 0 || offset >= total) return count
    }
  }

  /**
   * Delete one stored session after every non-destructive precondition passes.
   * @param sessionId - session to delete.
   * @returns the HTTP response.
   */
  const deleteSession = async (sessionId) => {
    const agent = service('agents')?.get?.(sessionId)
    if (agent !== undefined && agent?.status === 'running') {
      return refuse(409, 'session_running', 'This conversation is running. Stop it before deleting it.')
    }
    if (ctx.sessions.get(sessionId) !== undefined) {
      return refuse(409, 'session_live', 'This conversation is loaded in the running Harness, so its log cannot be removed safely.')
    }

    const snapshot = await ctx.sessionPersistence.stat(sessionId)
    if (snapshot === undefined) {
      return refuse(404, 'session_not_stored', 'This conversation has no stored log yet, so there is nothing to delete.')
    }
    const { header } = snapshot
    if (header.parentSession !== undefined || header.origin === 'subagent') {
      return refuse(409, 'session_subagent', 'A subagent conversation cannot be deleted on its own.')
    }
    const stored = await ctx.sessionPersistence.list()
    if (stored.some(candidate => candidate.header.parentSession === sessionId)) {
      return refuse(409, 'session_has_children', 'This conversation still owns subagent conversations, so it cannot be deleted.')
    }

    const schedule = service('schedule')
    if (schedule !== undefined && typeof schedule.list === 'function') {
      const referencing = await scheduledTargets(schedule, sessionId)
      if (referencing > 0) {
        return refuse(409, 'session_scheduled', `${String(referencing)} active scheduled task(s) still deliver into this conversation.`)
      }
    }

    const logPath = snapshot.location?.path
    if (snapshot.location?.kind !== 'jsonl' || typeof logPath !== 'string' || logPath === '') {
      return refuse(409, 'session_path_unknown', 'The stored log path for this conversation is unavailable.')
    }
    // Layout: <root>/--<cwd>--/<encoded id>/session[.vN].jsonl[.zstd]. Refuse any
    // path that does not sit in a session directory the JSONL backend owns.
    const directory = dirname(logPath)
    const segment = basename(directory)
    const project = basename(dirname(directory))
    const projectLike = project.startsWith('--') || project === '_no-cwd'
    if (segment === '' || segment === '.' || segment === '..' || !projectLike) {
      return refuse(409, 'session_path_unknown', 'The stored log path is not a recognized session directory.')
    }

    await forgetSession(sessionId)
    try {
      const outcome = await removeSessionFiles(directory)
      return answer(200, { ok: true, deleted: true, removed: outcome.removed.length, leftover: outcome.leftover })
    } catch (error) {
      warn(`session-delete: could not remove ${directory}: ${String(error)}`)
      return refuse(500, 'session_delete_failed', `Could not remove the stored log: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  const handler = async (request) => {
    if (request.method !== 'POST') return refuse(405, 'method_not_allowed', 'POST is required.')
    let payload
    try {
      payload = await request.json()
    } catch {
      return refuse(400, 'invalid_request', 'Expected a JSON body with a sessionId.')
    }
    const sessionId = typeof payload?.sessionId === 'string' ? payload.sessionId.trim() : ''
    if (sessionId === '' || sessionId.length > MAX_ID_LENGTH) {
      return refuse(400, 'invalid_request', 'A sessionId string is required.')
    }
    try {
      return await deleteSession(sessionId)
    } catch (error) {
      warn(`session-delete: ${String(error)}`)
      return refuse(500, 'internal', error instanceof Error ? error.message : String(error))
    }
  }

  ctx.effect(() => ctx.connection.fetch.register({
    path: ROUTE,
    methods: ['POST'],
    requestBody: 'buffered',
    fetch: handler,
  }), 'session-delete: /api/session-delete')
}
