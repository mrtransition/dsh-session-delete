/**
 * Browser half of "Delete session": one session-row menu entry, one
 * confirmation dialog, and the authenticated call into the Host route that
 * removes the stored log.
 */
window.__ModuleLoader__.load({
  id: '@local/dsh-session-delete',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    const NS = 'session-delete'
    const ROUTE = 'api/session-delete'
    const ICON_KEY = 'session-delete.trash'

    const en = {
      'menu.delete': 'Delete conversation…',
      'confirm.title': 'Delete conversation?',
      'confirm.body': '“{title}” is permanently removed from this device, together with its stored log. This cannot be undone.',
      'confirm.untitled': 'This conversation',
      'confirm.cancel': 'Cancel',
      'confirm.action': 'Delete',
      'confirm.busy': 'Deleting…',
      'notice.deleted': 'Conversation deleted',
      'error.session_running': 'This conversation is still running. Stop it first.',
      'error.session_live': 'This conversation is loaded in the running Harness, so its log cannot be removed safely. Restart DeepSeek Harness, then delete it from the session list.',
      'error.session_subagent': 'A subagent conversation cannot be deleted on its own.',
      'error.session_has_children': 'This conversation still owns subagent conversations, so it cannot be deleted.',
      'error.session_scheduled': 'Active scheduled tasks still deliver into this conversation. Remove them under Settings → Scheduled tasks first.',
      'error.session_not_stored': 'This conversation has no stored log yet, so there is nothing to delete.',
      'error.session_path_unknown': 'The stored log for this conversation could not be located.',
      'error.session_delete_failed': 'The stored log could not be removed.',
      'error.invalid_request': 'The delete request was rejected.',
      'error.network': 'The Harness could not be reached.',
      'error.generic': 'Delete failed: {message}',
    }

    const zh = {
      'menu.delete': '删除会话…',
      'confirm.title': '删除会话？',
      'confirm.body': '“{title}”将从本机永久删除，其存储日志一并移除。此操作无法撤销。',
      'confirm.untitled': '该会话',
      'confirm.cancel': '取消',
      'confirm.action': '删除',
      'confirm.busy': '删除中…',
      'notice.deleted': '会话已删除',
      'error.session_running': '该会话仍在执行，请先停止。',
      'error.session_live': '该会话已加载在当前运行的 Harness 中，无法安全删除其日志。请重启 DeepSeek Harness，再到会话列表中删除。',
      'error.session_subagent': '子代理会话不能单独删除。',
      'error.session_has_children': '该会话仍包含子代理会话，无法删除。',
      'error.session_scheduled': '仍有启用的定时任务向该会话投递。请先在「设置 → 定时任务」中删除这些任务。',
      'error.session_not_stored': '该会话尚未写入磁盘日志，没有可删除的内容。',
      'error.session_path_unknown': '找不到该会话的存储日志位置。',
      'error.session_delete_failed': '存储日志移除失败。',
      'error.invalid_request': '删除请求被拒绝。',
      'error.network': '无法连接 Harness。',
      'error.generic': '删除失败：{message}',
    }

    /** Minimal observable store: one confirmation request at a time. */
    function createConfirmStore() {
      let state = { request: null, busy: false, error: null }
      const listeners = new Set()
      const publish = (next) => {
        state = next
        for (const listener of listeners) listener()
      }
      return {
        getSnapshot: () => state,
        subscribe: (listener) => {
          listeners.add(listener)
          return () => { listeners.delete(listener) }
        },
        open: (request) => { publish({ request, busy: false, error: null }) },
        busy: (busy) => { publish({ ...state, busy }) },
        fail: (error) => { publish({ ...state, busy: false, error }) },
        close: () => { publish({ request: null, busy: false, error: null }) },
      }
    }

    const STYLE = `
.sd-backdrop{position:fixed;inset:0;z-index:60;display:flex;align-items:center;justify-content:center;padding:24px;background:var(--dsw-alias-bg-mask-3);pointer-events:auto}
.sd-panel{box-sizing:border-box;width:100%;max-width:420px;padding:20px;border:0.5px solid var(--dsw-alias-border-l4);border-radius:var(--dsw-radius-lg,12px);background:var(--dsw-alias-bg-overlay);box-shadow:0 16px 48px rgba(0,0,0,.28);color:var(--dsw-alias-label-primary)}
.sd-title{margin:0 0 8px;font-size:16px;font-weight:600;line-height:24px;color:var(--dsw-alias-label-primary)}
.sd-body{margin:0;font-size:13px;line-height:20px;color:var(--dsw-alias-label-secondary);overflow-wrap:anywhere}
.sd-error{margin:12px 0 0;font-size:12px;line-height:18px;color:var(--dsw-alias-state-error-primary)}
.sd-actions{display:flex;justify-content:flex-end;gap:8px;margin-top:20px}
.sd-button{box-sizing:border-box;height:32px;padding:0 14px;border:0.5px solid var(--dsw-alias-border-l4);border-radius:999px;background:transparent;cursor:pointer;font:inherit;font-size:13px;line-height:30px;color:var(--dsw-alias-label-primary)}
.sd-button:hover:not(:disabled){background:var(--dsw-alias-bg-layer-2)}
.sd-button:focus-visible{outline:2px solid var(--dsw-alias-border-selected);outline-offset:1px}
.sd-button:disabled{opacity:.55;cursor:default}
.sd-danger{color:var(--dsw-alias-state-error-primary);border-color:var(--dsw-alias-state-error-primary)}
`

    /** Trash glyph for the context-menu icon slot. */
    function TrashIcon() {
      return h('svg', {
        width: 16, height: 16, viewBox: '0 0 16 16', fill: 'none',
        'aria-hidden': true, style: { display: 'block' },
      },
      h('path', {
        d: 'M2.5 4.5h11M6 4.5V3.2c0-.4.3-.7.7-.7h2.6c.4 0 .7.3.7.7v1.3M4.2 4.5l.5 8.1c0 .8.6 1.4 1.4 1.4h3.8c.8 0 1.4-.6 1.4-1.4l.5-8.1',
        stroke: 'currentColor', strokeWidth: 1.2, strokeLinecap: 'round', strokeLinejoin: 'round',
      }),
      h('path', { d: 'M6.7 7v4.4M9.3 7v4.4', stroke: 'currentColor', strokeWidth: 1.2, strokeLinecap: 'round' }))
    }

    /**
     * Confirmation dialog rendered into the frame overlay while a request is pending.
     * @param props - injected store access, settlement callbacks, and localized copy.
     * @returns the dialog, or null when nothing is pending.
     */
    function ConfirmDialog({ useConfirm, settle, confirm, t }) {
      const request = useConfirm(state => state.request)
      const busy = useConfirm(state => state.busy)
      const error = useConfirm(state => state.error)
      const cancelRef = React.useRef(null)

      React.useEffect(() => {
        if (request === null) return undefined
        const node = cancelRef.current
        if (node !== null) node.focus()
        const onKeyDown = (event) => {
          if (event.key === 'Escape' && !busy) {
            event.stopPropagation()
            settle()
          }
        }
        document.addEventListener('keydown', onKeyDown, true)
        return () => { document.removeEventListener('keydown', onKeyDown, true) }
      }, [request, busy, settle])

      if (request === null) return null
      const title = request.displayTitle === '' ? t('confirm.untitled') : request.displayTitle
      return h(React.Fragment, null,
        h('style', null, STYLE),
        h('div', {
          className: 'sd-backdrop',
          onMouseDown: (event) => { if (event.target === event.currentTarget && !busy) settle() },
        },
        h('div', {
          className: 'sd-panel', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'sd-title', 'aria-describedby': 'sd-body',
        },
        h('h2', { className: 'sd-title', id: 'sd-title' }, t('confirm.title')),
        h('p', { className: 'sd-body', id: 'sd-body' }, t('confirm.body', { title })),
        error === null ? null : h('p', { className: 'sd-error', role: 'alert' }, error),
        h('div', { className: 'sd-actions' },
          h('button', {
            type: 'button', className: 'sd-button', ref: cancelRef, disabled: busy,
            onClick: () => { settle() },
          }, t('confirm.cancel')),
          h('button', {
            type: 'button', className: 'sd-button sd-danger', disabled: busy,
            onClick: () => { confirm(request) },
          }, busy ? t('confirm.busy') : t('confirm.action'))))),
      )
    }

    return {
      inject: ['slots', 'locale', 'contextMenus', 'sessions'],
      /**
       * Register the dictionary, the menu entry, its glyph, and the confirmation dialog.
       * @param ctx - Client context carrying slots, locale, context menus, and sessions.
       */
      apply(ctx) {
        const t = ctx.locale.bind(NS)
        const store = createConfirmStore()
        ctx.effect(() => ctx.locale.register(NS, { en, zh }), 'session-delete: dictionaries')

        /**
         * Map one Host refusal to localized copy, keeping the Host detail as a fallback.
         * @param failure - thrown deletion failure.
         * @returns human-readable message.
         */
        const knownCodes = new Set(Object.keys(en)
          .filter(key => key.startsWith('error.'))
          .map(key => key.slice('error.'.length)))

        const describe = (failure) => {
          const code = String(failure?.code ?? '')
          if (knownCodes.has(code)) return t(`error.${code}`)
          return t('error.generic', { message: failure?.message ?? String(failure) })
        }

        /**
         * Ask the Host to delete one session, then refresh the authoritative list.
         * @param request - the confirmed row.
         * @returns nothing; failures are published into the dialog.
         */
        const run = async (request) => {
          store.busy(true)
          let response
          try {
            response = await fetch(ROUTE, {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ sessionId: request.sessionId }),
            })
          } catch {
            store.fail(t('error.network'))
            return
          }
          let payload = null
          try {
            payload = await response.json()
          } catch {
            payload = null
          }
          if (!response.ok || payload?.ok !== true) {
            const failure = {
              code: payload?.code ?? (response.status === 404 ? 'session_not_stored' : 'internal'),
              message: payload?.message ?? `HTTP ${response.status}`,
            }
            store.fail(describe(failure))
            return
          }
          store.close()
          ctx.contextMenus.notify(t('notice.deleted'), true)
          try {
            await ctx.sessions.refresh()
          } catch {
            // The deletion is already durable; a failed refresh only delays the row disappearing.
          }
        }

        ctx.slots.inject('contextMenu.icon', () => ctx.slots.register({ name: 'contextMenu.icon', key: ICON_KEY }, TrashIcon))

        ctx.effect(() => ctx.contextMenus.register({
          id: 'session-delete.delete',
          target: 'session',
          order: 700,
          observe: () => [ctx.sessions.list, ctx.locale],
          resolve: ({ sessionId, displayTitle }) => {
            const row = ctx.sessions.list.getSnapshot().byId[sessionId]
            if (row === undefined || row.blank === true || row.running === true || row.origin === 'subagent') return []
            return [{
              id: 'delete',
              label: t('menu.delete'),
              icon: { key: ICON_KEY },
              danger: true,
              separatorBefore: true,
              afterContent: true,
              run: () => { store.open({ sessionId, displayTitle }) },
            }]
          },
        }), 'session-delete: session menu entry')

        ctx.slots.inject('shell.overlay', () => ctx.slots.register({
          name: 'shell.overlay',
          id: 'session-delete.confirm',
          order: 400,
          locale: NS,
          inject: () => ({
            hooks: { confirm: store },
            settle: () => { store.close() },
            confirm: (request) => run(request),
          }),
        }, ConfirmDialog))
      },
    }
  },
})
