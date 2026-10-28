/**
 * Message Pipeline — browser half.
 *
 * Adds the sidebar pipeline manager (a `sidebar.panellist` entry plus a `main`
 * page), and a per-conversation chip that shows which workspaces the current
 * session can reach. All reads and writes go through the Host `/pipe` command,
 * so the Host remains the single source of truth.
 */
window.__ModuleLoader__.load({
  id: 'dsh-message-pipeline',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    const NS = 'message-pipeline'
    const PANEL_ID = 'message-pipeline'
    const CHANGE_EVENT = 'message-pipeline:changed'

    const zh = {
      'panel.label': '消息管道',
      'panel.title': '消息管道',
      'panel.subtitle': '把工作区连成命名管道，在管道内发送跨会话消息。',
      'panel.empty': '还没有管道。选择两个或更多工作区创建第一条管道。',
      'panel.needSelection': '请填写管道名称，并至少选择一个工作区。',
      'panel.noWorkspaces': '没有读取到工作区；请先刷新或确认本机已有工作区。',
      'settings.advanced': '高级设置（留空继承全局）',
      'settings.maxMessageBytes': '单条消息上限（字节）',
      'settings.maxQueuedPerTarget': '每个目标积压上限',
      'settings.maxSendsPerMinute': '每分钟发送上限',
      'settings.defaultWake': '默认唤醒目标',
      'settings.inherit': '继承全局',
      'settings.on': '是',
      'settings.off': '否',
      'settings.none': '全部继承全局',
      'settings.queued': '积压',
      'settings.global': '插件全局设置',
      'settings.globalHint': '留空使用 profile 配置默认；消息上限填 0 表示不限。',
      'settings.configDefault': '配置文件默认',
      'settings.saveGlobal': '保存全局设置',
      'settings.saved': '已保存',
      'settings.unlimited': '不限',
      'panel.create': '新建管道',
      'panel.titleField': '名称',
      'panel.titlePlaceholder': '例如：论文项目群',
      'panel.workspaces': '连接工作区',
      'panel.save': '创建',
      'panel.cancel': '取消',
      'panel.delete': '删除',
      'panel.enabled': '已启用',
      'panel.disabled': '已停用',
      'panel.enable': '启用',
      'panel.disable': '停用',
      'panel.members': '编辑成员',
      'panel.audit': '消息记录',
      'panel.pipelines': '管道',
      'panel.refresh': '刷新',
      'panel.noSession': '请先打开一个会话，再管理管道。',
      'panel.loading': '加载中…',
      'panel.error': '操作失败',
      'panel.queued': '待投递',
      'panel.never': '不按管道传递：只与同属一个管道的工作区直接通信。',
      'chip.loading': '可达工作区…',
      'chip.none': '未连接管道',
      'chip.reachable': '可通信 {n} 个工作区',
      'chip.title': '点击刷新可达工作区',
      'audit.empty': '暂无消息记录。',
      'audit.from': '来自',
      'audit.to': '发往',
      'audit.state': '状态',
    }

    const en = {
      'panel.label': 'Pipelines',
      'panel.title': 'Message pipelines',
      'panel.subtitle': 'Connect workspaces into named pipelines for scoped cross-session messaging.',
      'panel.empty': 'No pipeline yet. Pick two or more workspaces to create one.',
      'panel.needSelection': 'Enter a pipeline name and select at least one workspace.',
      'panel.noWorkspaces': 'No workspaces loaded; refresh or confirm a workspace exists.',
      'settings.advanced': 'Advanced (blank inherits global)',
      'settings.maxMessageBytes': 'Max message bytes',
      'settings.maxQueuedPerTarget': 'Queued per target',
      'settings.maxSendsPerMinute': 'Sends per minute',
      'settings.defaultWake': 'Wake target by default',
      'settings.inherit': 'Inherit',
      'settings.on': 'Yes',
      'settings.off': 'No',
      'settings.none': 'All settings inherit global defaults',
      'settings.queued': 'queued',
      'settings.global': 'Plugin global settings',
      'settings.globalHint': 'Blank uses the profile default; 0 bytes means unlimited.',
      'settings.configDefault': 'Profile default',
      'settings.saveGlobal': 'Save global settings',
      'settings.saved': 'Saved',
      'settings.unlimited': 'unlimited',
      'panel.create': 'New pipeline',
      'panel.titleField': 'Name',
      'panel.titlePlaceholder': 'e.g. paper project group',
      'panel.workspaces': 'Connected workspaces',
      'panel.save': 'Create',
      'panel.cancel': 'Cancel',
      'panel.delete': 'Delete',
      'panel.enabled': 'Enabled',
      'panel.disabled': 'Disabled',
      'panel.enable': 'Enable',
      'panel.disable': 'Disable',
      'panel.members': 'Edit members',
      'panel.audit': 'Message log',
      'panel.pipelines': 'Pipelines',
      'panel.refresh': 'Refresh',
      'panel.noSession': 'Open a session first to manage pipelines.',
      'panel.loading': 'Loading…',
      'panel.error': 'Operation failed',
      'panel.queued': 'queued',
      'panel.never': 'Not transitive: communication happens only inside one pipeline.',
      'chip.loading': 'Reachable workspaces…',
      'chip.none': 'No pipeline',
      'chip.reachable': '{n} workspaces reachable',
      'chip.title': 'Click to refresh reachable workspaces',
      'audit.empty': 'No message records yet.',
      'audit.from': 'From',
      'audit.to': 'To',
      'audit.state': 'State',
    }

    // Theme-aware colors: prefer the harness design tokens so the panel follows
    // light/dark themes, and fall back to neutral translucent values that work
    // on either background instead of assuming a dark surface.
    const TOKENS = {
      text: 'var(--dsw-alias-label-primary, inherit)',
      textSoft: 'var(--dsw-alias-label-tertiary, rgba(120,120,120,0.95))',
      border: 'var(--dsw-alias-border-l3, rgba(120,120,120,0.35))',
      surface: 'var(--dsw-alias-bg-layer-1, rgba(120,120,120,0.08))',
      input: 'var(--dsw-alias-bg-l1, rgba(120,120,120,0.12))',
      accent: 'var(--dsw-alias-button-primary-fill, #4c8dff)',
      accentHover: 'var(--dsw-alias-button-primary-hover, #6aa2ff)',
      accentText: 'var(--dsw-alias-label-primary-foreground, #fff)',
      danger: 'var(--dsw-alias-state-error-primary, #d4380d)',
      dangerSoft: 'var(--dsw-alias-interactive-bg-hover-danger, rgba(212,56,13,0.12))',
      hover: 'var(--dsw-alias-interactive-bg-hover, rgba(120,120,120,0.12))',
      selected: 'var(--dsw-alias-interactive-bg-hover-accent, rgba(76,141,255,0.16))',
    }

    const styles = {
      page: {
        flex: '1 1 auto', minHeight: 0, height: '100%', boxSizing: 'border-box',
        overflow: 'auto', padding: '20px 24px 32px',
        color: TOKENS.text,
        font: '13px/1.5 system-ui, -apple-system, "Segoe UI", sans-serif',
      },
      header: { display: 'flex', alignItems: 'baseline', gap: 12, marginBottom: 4 },
      title: { fontSize: 16, fontWeight: 600, margin: 0 },
      subtitle: { color: TOKENS.textSoft, margin: '0 0 16px' },
      toolbar: { display: 'flex', gap: 8, alignItems: 'center', marginBottom: 14, flexWrap: 'wrap' },
      button: {
        padding: '6px 12px', borderRadius: 8, cursor: 'pointer',
        border: `1px solid ${TOKENS.border}`,
        background: TOKENS.surface,
        color: TOKENS.text, font: 'inherit',
      },
      primary: { background: TOKENS.accent, borderColor: 'transparent', color: TOKENS.accentText },
      danger: { color: TOKENS.danger, borderColor: TOKENS.border },
      muted: { color: TOKENS.textSoft },
      card: {
        border: `1px solid ${TOKENS.border}`,
        borderRadius: 12, padding: 14, marginBottom: 12,
        background: TOKENS.surface,
      },
      row: { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' },
      chip: {
        display: 'inline-flex', alignItems: 'center', gap: 6,
        padding: '2px 8px', borderRadius: 999, marginRight: 6, marginBottom: 6,
        border: `1px solid ${TOKENS.border}`,
        background: TOKENS.surface, fontSize: 12,
      },
      input: {
        width: '100%', boxSizing: 'border-box', padding: '7px 10px', marginBottom: 10,
        borderRadius: 8, border: `1px solid ${TOKENS.border}`,
        background: TOKENS.input, color: TOKENS.text, font: 'inherit',
      },
      error: { color: TOKENS.danger, marginBottom: 12, whiteSpace: 'pre-wrap' },
      table: { width: '100%', borderCollapse: 'collapse', fontSize: 12 },
      th: { textAlign: 'left', color: TOKENS.textSoft, fontWeight: 500, padding: '6px 8px', borderBottom: `1px solid ${TOKENS.border}` },
      td: { padding: '6px 8px', borderBottom: `1px solid ${TOKENS.border}`, verticalAlign: 'top' },
      chipButton: {
        display: 'inline-flex', alignItems: 'center', gap: 6,
        padding: '2px 8px', borderRadius: 999, cursor: 'pointer',
        border: `1px solid ${TOKENS.border}`,
        background: 'transparent', color: TOKENS.text, fontSize: 12,
      },
    }

    /**
     * Extract the command result text.
     *
     * `commands.execute` reaches the client as either a `CommandExecution`
     * (`{commandId, result:{kind, text}}`) or, when a carrier wraps it, a
     * `RemoteResult` (`{ok, value|error}`). Both must be unwrapped before the
     * JSON payload the `/pipe` handler produced can be read.
     */
    function commandText(result) {
      if (result === null || result === undefined) return ''
      if (typeof result === 'string') return result
      if (typeof result.ok === 'boolean' && ('value' in result || 'error' in result)) {
        if (result.ok !== true) {
          throw new Error(result.error?.message ?? result.error?.code ?? 'command failed')
        }
        return commandText(result.value)
      }
      if (typeof result.text === 'string') return result.text
      const execution = result.result
      if (execution !== null && typeof execution === 'object' && typeof execution.text === 'string') return execution.text
      if (result.value !== null && typeof result.value === 'object' && typeof result.value.text === 'string') return result.value.text
      if (typeof result.message === 'string') return result.message
      return JSON.stringify(result)
    }

    function parseResult(result) {
      const text = commandText(result)
      try {
        const parsed = JSON.parse(text)
        if (parsed !== null && typeof parsed === 'object') return parsed
      } catch {
        /* fall through */
      }
      return { ok: false, code: 'PIPE_BAD_RESPONSE', message: text || 'empty command response' }
    }

    function currentSessionId(ctx) {
      try {
        return ctx.uiSession?.current?.getSnapshot?.()?.sessionId
      } catch {
        return undefined
      }
    }

    /**
     * The `/pipe` command needs an Agent context, but the global panel must work
     * while no conversation is open. Prefer the current session and otherwise
     * reuse the most recently updated session from the client session store.
     */
    function commandSessionId(ctx) {
      const current = currentSessionId(ctx)
      if (typeof current === 'string' && current.length > 0) return current
      try {
        const state = ctx.sessions?.list?.getSnapshot?.()
        const rows = Object.values(state?.byId ?? {})
        if (rows.length === 0) return undefined
        rows.sort((left, right) => (right.updatedAt ?? right.createdAt ?? 0) - (left.updatedAt ?? left.createdAt ?? 0))
        return rows[0]?.id ?? rows[0]?.sessionId
      } catch {
        return undefined
      }
    }

    async function runCommand(ctx, sessionId, line) {
      if (typeof sessionId !== 'string' || sessionId.length === 0) throw new Error('no active session')
      if (ctx.remote?.commands?.execute === undefined) throw new Error('this client does not expose remote.commands')
      const result = await ctx.remote.commands.execute(sessionId, line, [])
      const parsed = parseResult(result)
      if (parsed.ok === false) {
        const message = parsed.message || parsed.code || 'command failed'
        throw new Error(parsed.candidates ? `${message} (${JSON.stringify(parsed.candidates)})` : message)
      }
      return parsed
    }

    function notifyChanged() {
      try {
        window.dispatchEvent(new Event(CHANGE_EVENT))
      } catch {
        /* ignore */
      }
    }

    function PipelineIcon() {
      return h('svg', {
        viewBox: '0 0 24 24', width: 18, height: 18, fill: 'none',
        stroke: 'currentColor', strokeWidth: 1.8, strokeLinecap: 'round', strokeLinejoin: 'round',
        'aria-hidden': 'true',
      },
        h('rect', { x: 2.5, y: 4, width: 6, height: 6, rx: 1.3 }),
        h('rect', { x: 15.5, y: 4, width: 6, height: 6, rx: 1.3 }),
        h('rect', { x: 9, y: 14, width: 6, height: 6, rx: 1.3 }),
        h('path', { d: 'M8.5 7h7' }),
        h('path', { d: 'M5.5 10v3.2a1.8 1.8 0 0 0 1.8 1.8h1.2' }),
        h('path', { d: 'M18.5 10v3.2a1.8 1.8 0 0 1-1.8 1.8h-1.2' }),
      )
    }

    function PipelineIconButton() {
      return h('span', { style: { display: 'inline-flex', alignItems: 'center', justifyContent: 'center' } },
        h(PipelineIcon))
    }

    function pipelineWorkspaceIds(pipeline) {
      return (pipeline.workspaces || []).map((workspace) => workspace.id)
    }

    function WorkspacePicker({ workspaces, selected, onToggle, t }) {
      return h('div', { style: { display: 'grid', gap: 6, marginBottom: 12 } },
        ...workspaces.map((workspace) => h('label', {
          key: workspace.id,
          style: {
            display: 'flex', alignItems: 'center', gap: 8, padding: '4px 6px',
            borderRadius: 6, cursor: 'pointer',
            background: selected.includes(workspace.id) ? TOKENS.selected : 'transparent',
          },
        },
          h('input', {
            type: 'checkbox',
            checked: selected.includes(workspace.id),
            onChange: () => onToggle(workspace.id),
          }),
          h('span', null, workspace.title),
          h('span', { style: styles.muted }, workspace.path),
        )),
      )
    }

    function blankSettingsDraft() {
      return { maxMessageBytes: '', maxQueuedPerTarget: '', maxSendsPerMinute: '', defaultWake: 'inherit' }
    }

    function settingsDraftFrom(settings) {
      const value = settings ?? {}
      return {
        maxMessageBytes: value.maxMessageBytes === undefined ? '' : String(value.maxMessageBytes),
        maxQueuedPerTarget: value.maxQueuedPerTarget === undefined ? '' : String(value.maxQueuedPerTarget),
        maxSendsPerMinute: value.maxSendsPerMinute === undefined ? '' : String(value.maxSendsPerMinute),
        defaultWake: value.defaultWake === undefined ? 'inherit' : (value.defaultWake ? 'on' : 'off'),
      }
    }

    function settingsFromDraft(draft) {
      const settings = {}
      for (const key of ['maxMessageBytes', 'maxQueuedPerTarget', 'maxSendsPerMinute']) {
        const raw = String(draft?.[key] ?? '').trim()
        if (raw.length === 0) continue
        const value = Number(raw)
        if (Number.isFinite(value)) settings[key] = Math.trunc(value)
      }
      if (draft?.defaultWake === 'on') settings.defaultWake = true
      else if (draft?.defaultWake === 'off') settings.defaultWake = false
      return settings
    }

    function formatBytes(value, t) {
      return value === 0 ? t('settings.unlimited') : `${value} B`
    }

    function settingsSummary(settings, t) {
      const value = settings ?? {}
      const parts = []
      if (value.maxMessageBytes !== undefined) parts.push(`≤ ${formatBytes(value.maxMessageBytes, t)}`)
      if (value.maxQueuedPerTarget !== undefined) parts.push(`${t('settings.queued')} ≤ ${value.maxQueuedPerTarget}`)
      if (value.maxSendsPerMinute !== undefined) parts.push(`${value.maxSendsPerMinute}/min`)
      if (value.defaultWake !== undefined) {
        parts.push(`${t('settings.defaultWake')}: ${value.defaultWake ? t('settings.on') : t('settings.off')}`)
      }
      return parts.length === 0 ? t('settings.none') : parts.join(' · ')
    }

    function SettingsFields({ draft, defaults, t, onChange, inheritLabel, title }) {
      const shown = (fallback) => fallback === 0 ? t('settings.unlimited') : String(fallback)
      const field = (key, labelText, fallback) => h('label', { key, style: { display: 'block', marginBottom: 8 } },
        h('div', { style: { ...styles.muted, marginBottom: 2 } }, labelText),
        h('input', {
          style: { ...styles.input, marginBottom: 0 },
          value: draft[key],
          placeholder: `${inheritLabel ?? t('settings.inherit')} (${shown(fallback)})`,
          inputMode: 'numeric',
          onChange: (event) => onChange(key, event.target.value),
        }),
      )
      return h('div', { style: { marginTop: 4, marginBottom: 12 } },
        h('div', { style: { ...styles.muted, marginBottom: 8 } }, title ?? t('settings.advanced')),
        field('maxMessageBytes', t('settings.maxMessageBytes'), defaults.maxMessageBytes),
        field('maxQueuedPerTarget', t('settings.maxQueuedPerTarget'), defaults.maxQueuedPerTarget),
        field('maxSendsPerMinute', t('settings.maxSendsPerMinute'), defaults.maxSendsPerMinute),
        h('label', { style: { display: 'block' } },
          h('div', { style: { ...styles.muted, marginBottom: 2 } }, t('settings.defaultWake')),
          h('select', {
            style: { ...styles.input, marginBottom: 0 },
            value: draft.defaultWake,
            onChange: (event) => onChange('defaultWake', event.target.value),
          },
            h('option', { value: 'inherit' }, inheritLabel ?? t('settings.inherit')),
            h('option', { value: 'on' }, t('settings.on')),
            h('option', { value: 'off' }, t('settings.off')),
          ),
        ),
      )
    }

    function PipelineCard({ ctx, pipeline, workspaces, defaults, t, onChanged }) {
      const [editing, setEditing] = React.useState(false)
      const [selected, setSelected] = React.useState(pipelineWorkspaceIds(pipeline))
      const [settingsDraft, setSettingsDraft] = React.useState(settingsDraftFrom(pipeline.settings))
      const [busy, setBusy] = React.useState(false)
      const [error, setError] = React.useState('')

      function toggle(id) {
        setSelected((current) => current.includes(id) ? current.filter((item) => item !== id) : [...current, id])
      }

      function changeSetting(key, value) {
        setSettingsDraft((current) => ({ ...current, [key]: value }))
      }

      function openEditor() {
        setEditing((value) => !value)
        setSelected(pipelineWorkspaceIds(pipeline))
        setSettingsDraft(settingsDraftFrom(pipeline.settings))
      }

      async function run(action) {
        setBusy(true)
        setError('')
        try {
          await action()
          onChanged()
        } catch (cause) {
          setError(cause instanceof Error ? cause.message : String(cause))
        } finally {
          setBusy(false)
        }
      }

      const sessionId = commandSessionId(ctx)

      return h('div', { style: styles.card },
        h('div', { style: styles.row },
          h('strong', null, pipeline.title),
          h('span', { style: styles.muted }, pipeline.enabled ? t('panel.enabled') : t('panel.disabled')),
          pipeline.description ? h('span', { style: styles.muted }, pipeline.description) : null,
        ),
        h('div', { style: { margin: '8px 0' } },
          ...(pipeline.workspaces || []).map((workspace) => h('span', { key: workspace.id, style: styles.chip }, workspace.title)),
        ),
        h('div', { style: { ...styles.muted, marginBottom: 8 } }, settingsSummary(pipeline.settings, t)),
        h('div', { style: styles.row },
          h('button', {
            type: 'button',
            style: styles.button,
            disabled: busy,
            onClick: () => run(() => runCommand(ctx, sessionId, `/pipe setEnabled ${JSON.stringify({ id: pipeline.id, enabled: !pipeline.enabled })}`)),
          }, pipeline.enabled ? t('panel.disable') : t('panel.enable')),
          h('button', {
            type: 'button',
            style: styles.button,
            disabled: busy,
            onClick: openEditor,
          }, t('panel.members')),
          h('button', {
            type: 'button',
            style: { ...styles.button, ...styles.danger },
            disabled: busy,
            onClick: () => {
              if (!window.confirm(`${t('panel.delete')}: ${pipeline.title}?`)) return
              void run(() => runCommand(ctx, sessionId, `/pipe delete ${JSON.stringify({ id: pipeline.id })}`))
            },
          }, t('panel.delete')),
        ),
        editing ? h('div', { style: { marginTop: 12 } },
          h('div', { style: { ...styles.muted, marginBottom: 6 } }, t('panel.workspaces')),
          h(WorkspacePicker, {
            workspaces,
            selected,
            onToggle: toggle,
            t,
          }),
          h(SettingsFields, { draft: settingsDraft, defaults, t, onChange: changeSetting }),
          h('div', { style: styles.row },
            h('button', {
              type: 'button',
              style: { ...styles.button, ...styles.primary },
              disabled: busy,
              onClick: () => run(() => runCommand(ctx, sessionId, `/pipe update ${JSON.stringify({
                id: pipeline.id,
                workspaceIds: selected,
                settings: settingsFromDraft(settingsDraft),
              })}`)),
            }, t('panel.save')),
            h('button', { type: 'button', style: styles.button, onClick: () => setEditing(false) }, t('panel.cancel')),
          ),
        ) : null,
        error ? h('div', { style: { ...styles.error, marginTop: 8 } }, error) : null,
      )
    }

    function AuditView({ ctx, t, sessionId }) {
      const [rows, setRows] = React.useState([])
      const [error, setError] = React.useState('')
      const [loading, setLoading] = React.useState(true)

      React.useEffect(() => {
        let alive = true
        setLoading(true)
        runCommand(ctx, sessionId, '/pipe audit {"limit":50}')
          .then((result) => {
            if (alive) setRows(Array.isArray(result.messages) ? result.messages : [])
          })
          .catch((cause) => {
            if (alive) setError(cause instanceof Error ? cause.message : String(cause))
          })
          .finally(() => {
            if (alive) setLoading(false)
          })
        return () => { alive = false }
      }, [ctx, sessionId])

      if (loading) return h('div', { style: styles.muted }, t('panel.loading'))
      if (error) return h('div', { style: styles.error }, error)
      if (rows.length === 0) return h('div', { style: styles.muted }, t('audit.empty'))
      return h('table', { style: styles.table },
        h('thead', null,
          h('tr', null,
            h('th', { style: styles.th }, 'time'),
            h('th', { style: styles.th }, t('audit.from')),
            h('th', { style: styles.th }, t('audit.to')),
            h('th', { style: styles.th }, t('audit.state')),
            h('th', { style: styles.th }, 'bytes'),
          ),
        ),
        h('tbody', null,
          ...rows.map((row) => h('tr', { key: row.id },
            h('td', { style: styles.td }, new Date(row.createdAt).toLocaleString()),
            h('td', { style: styles.td }, `${row.from?.workspaceTitle || row.from?.workspaceId || ''} / ${row.from?.title || row.from?.sessionId || ''}`),
            h('td', { style: styles.td }, `${row.to?.workspaceId || ''} / ${row.to?.sessionId || ''}`),
            h('td', { style: styles.td }, row.reason ? `${row.state} (${row.reason})` : row.state),
            h('td', { style: styles.td }, String(row.bytes ?? '')),
          )),
        ),
      )
    }

    function PipelinePanel({ ctx, t }) {
      const [tab, setTab] = React.useState('pipelines')
      const [data, setData] = React.useState(null)
      const [error, setError] = React.useState('')
      const [loading, setLoading] = React.useState(false)
      const [creating, setCreating] = React.useState(false)
      const [draftTitle, setDraftTitle] = React.useState('')
      const [draftSelected, setDraftSelected] = React.useState([])
      const [draftSettings, setDraftSettings] = React.useState(blankSettingsDraft())
      const [globalDraft, setGlobalDraft] = React.useState(blankSettingsDraft())
      const [globalSaved, setGlobalSaved] = React.useState(false)
      const [savingGlobal, setSavingGlobal] = React.useState(false)
      const sessionId = commandSessionId(ctx)

      const refresh = React.useCallback(() => {
        if (typeof sessionId !== 'string') {
          setData(null)
          setLoading(false)
          return
        }
        setLoading(true)
        setError('')
        runCommand(ctx, sessionId, '/pipe list')
          .then((result) => setData(result))
          .catch((cause) => setError(cause instanceof Error ? cause.message : String(cause)))
          .finally(() => setLoading(false))
      }, [ctx, sessionId])

      React.useEffect(() => {
        refresh()
        const onChange = () => refresh()
        window.addEventListener(CHANGE_EVENT, onChange)
        return () => window.removeEventListener(CHANGE_EVENT, onChange)
      }, [refresh])

      React.useEffect(() => {
        if (data?.globalSettings === undefined) return
        setGlobalDraft(settingsDraftFrom(data.globalSettings))
      }, [data?.globalSettings])

      function toggleDraft(id) {
        setDraftSelected((current) => current.includes(id) ? current.filter((item) => item !== id) : [...current, id])
      }

      function changeDraftSetting(key, value) {
        setDraftSettings((current) => ({ ...current, [key]: value }))
      }

      function changeGlobalSetting(key, value) {
        setGlobalSaved(false)
        setGlobalDraft((current) => ({ ...current, [key]: value }))
      }

      async function saveGlobalSettings() {
        setSavingGlobal(true)
        setError('')
        try {
          await runCommand(ctx, sessionId, `/pipe setGlobal ${JSON.stringify({ settings: settingsFromDraft(globalDraft) })}`)
          setGlobalSaved(true)
          notifyChanged()
          refresh()
        } catch (cause) {
          setError(cause instanceof Error ? cause.message : String(cause))
        } finally {
          setSavingGlobal(false)
        }
      }

      async function createPipeline() {
        if (draftTitle.trim().length === 0 || draftSelected.length === 0) {
          setError(t('panel.needSelection'))
          return
        }
        setError('')
        try {
          await runCommand(ctx, sessionId, `/pipe create ${JSON.stringify({
            title: draftTitle.trim(),
            workspaceIds: draftSelected,
            settings: settingsFromDraft(draftSettings),
          })}`)
          setCreating(false)
          setDraftTitle('')
          setDraftSelected([])
          setDraftSettings(blankSettingsDraft())
          notifyChanged()
          refresh()
        } catch (cause) {
          setError(cause instanceof Error ? cause.message : String(cause))
        }
      }

      const defaults = data?.defaults ?? {
        maxMessageBytes: 32768,
        maxQueuedPerTarget: 32,
        maxSendsPerMinute: 20,
        defaultWake: false,
      }
      const configDefaults = data?.configDefaults ?? defaults
      const workspaces = data?.workspaces ?? []
      const pipelines = data?.pipelines ?? []

      if (typeof sessionId !== 'string') {
        return h('div', { style: styles.page }, h('p', { style: styles.muted }, t('panel.noSession')))
      }

      return h('div', { style: styles.page },
        h('div', { style: styles.header }, h('h1', { style: styles.title }, t('panel.title'))),
        h('p', { style: styles.subtitle }, t('panel.subtitle')),
        h('div', { style: styles.toolbar },
          h('button', { type: 'button', style: { ...styles.button, ...(tab === 'pipelines' ? styles.primary : {}) }, onClick: () => { setTab('pipelines'); refresh() } }, t('panel.pipelines')),
          h('button', { type: 'button', style: { ...styles.button, ...(tab === 'audit' ? styles.primary : {}) }, onClick: () => setTab('audit') }, t('panel.audit')),
          h('button', { type: 'button', style: styles.button, disabled: loading, onClick: refresh }, t('panel.refresh')),
          h('span', { style: { flex: 1 } }),
          h('button', { type: 'button', style: { ...styles.button, ...styles.primary }, onClick: () => { setCreating((value) => !value); setTab('pipelines') } }, t('panel.create')),
        ),
        h('p', { style: { ...styles.muted, margin: '0 0 14px' } }, t('panel.never')),
        tab === 'pipelines' ? h('details', { style: { marginBottom: 16 } },
          h('summary', { style: { cursor: 'pointer', marginBottom: 8 } }, t('settings.global')),
          h('div', { style: styles.card },
            h('div', { style: { ...styles.muted, marginBottom: 10 } }, t('settings.globalHint')),
            h(SettingsFields, {
              draft: globalDraft,
              defaults: configDefaults,
              t,
              onChange: changeGlobalSetting,
              inheritLabel: t('settings.configDefault'),
              title: t('settings.global'),
            }),
            h('div', { style: styles.row },
              h('button', {
                type: 'button',
                style: { ...styles.button, ...styles.primary },
                disabled: savingGlobal,
                onClick: () => void saveGlobalSettings(),
              }, t('settings.saveGlobal')),
              globalSaved ? h('span', { style: styles.muted }, t('settings.saved')) : null,
            ),
          ),
        ) : null,
        error ? h('div', { style: styles.error }, `${t('panel.error')}: ${error}`) : null,
        tab === 'audit'
          ? h(AuditView, { ctx, t, sessionId })
          : h('div', null,
            creating ? h('div', { style: styles.card },
              h('label', { style: { display: 'block', marginBottom: 4 } }, t('panel.titleField')),
              h('input', {
                style: styles.input,
                value: draftTitle,
                placeholder: t('panel.titlePlaceholder'),
                onChange: (event) => setDraftTitle(event.target.value),
              }),
              h('label', { style: { display: 'block', marginBottom: 4 } }, t('panel.workspaces')),
              workspaces.length === 0
                ? h('div', { style: { ...styles.muted, marginBottom: 10 } }, t('panel.noWorkspaces'))
                : h(WorkspacePicker, { workspaces, selected: draftSelected, onToggle: toggleDraft, t }),
              h(SettingsFields, { draft: draftSettings, defaults, t, onChange: changeDraftSetting }),
              h('div', { style: styles.row },
                h('button', { type: 'button', style: { ...styles.button, ...styles.primary }, onClick: () => void createPipeline() }, t('panel.save')),
                h('button', { type: 'button', style: styles.button, onClick: () => setCreating(false) }, t('panel.cancel')),
              ),
            ) : null,
            loading && data === null ? h('div', { style: styles.muted }, t('panel.loading')) : null,
            !loading && pipelines.length === 0 && !creating ? h('div', { style: styles.muted }, t('panel.empty')) : null,
            ...pipelines.map((pipeline) => h(PipelineCard, {
              key: pipeline.id,
              ctx,
              pipeline,
              workspaces,
              defaults,
              t,
              onChanged: () => { notifyChanged(); refresh() },
            })),
          ),
      )
    }

    function ReachabilityChip({ ctx, sessionId, t }) {
      const [info, setInfo] = React.useState(undefined)
      const [error, setError] = React.useState('')

      const load = React.useCallback(() => {
        if (typeof sessionId !== 'string' || sessionId.length === 0) return
        if (currentSessionId(ctx) !== sessionId) return
        runCommand(ctx, sessionId, '/pipe info')
          .then((result) => {
            setInfo(result)
            setError('')
          })
          .catch(() => {
            setInfo(undefined)
            setError('')
          })
      }, [ctx, sessionId])

      React.useEffect(() => {
        load()
        window.addEventListener(CHANGE_EVENT, load)
        return () => window.removeEventListener(CHANGE_EVENT, load)
      }, [load])

      if (info === undefined) {
        return error
          ? h('span', { style: styles.muted, title: error }, t('chip.loading'))
          : null
      }

      const reachable = Array.isArray(info.reachableWorkspaces) ? info.reachableWorkspaces : []
      const external = reachable.filter((workspace) => workspace.via !== 'self')
      if (external.length === 0) {
        return h('span', { style: { ...styles.chip, opacity: 0.6 }, title: t('chip.title') }, t('chip.none'))
      }
      const names = external.map((workspace) => workspace.title).join(', ')
      return h('button', {
        type: 'button',
        style: styles.chipButton,
        title: `${t('chip.title')}\n${names}`,
        onClick: load,
      },
        h('span', { 'aria-hidden': 'true' }, '⇄'),
        h('span', null, t('chip.reachable').replace('{n}', String(external.length))),
      )
    }

    return {
      inject: ['slots', 'locale', 'remote', 'remote.commands', 'uiSession', 'sessions'],
      apply(ctx) {
        ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'message-pipeline: dictionaries')
        const t = ctx.locale.bind(NS)

        ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
          name: 'sidebar.panellist',
          id: PANEL_ID,
          order: 20,
          locale: NS,
          label: () => t('panel.label'),
        }, PipelineIconButton))

        ctx.slots.inject('main', () => ctx.slots.register({
          name: 'main',
          key: PANEL_ID,
          locale: NS,
          inject: () => ({ ctx, t }),
        }, PipelinePanel))

        ctx.slots.inject('conversation.session.header.utilities', () => ctx.slots.register({
          name: 'conversation.session.header.utilities',
          id: 'message-pipeline-reachability',
          order: 6,
          locale: NS,
          inject: (sessionId) => ({ ctx, sessionId, t }),
        }, ReachabilityChip))
      },
    }
  },
})
