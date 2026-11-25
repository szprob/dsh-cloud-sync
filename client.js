/**
 * 云同步 · 浏览器半边。
 *
 * 一个「设置 → 云同步」页：填仓库 / 分支 / 目录 / token，看状态，一键备份或恢复。
 *
 * 所有数据操作都走宿主进程的 HTTP 路由 `/plugins/dsh-cloud-sync/*`（见 lib/api.js）；
 * 这里只负责表单、按钮和结果展示，不含任何同步逻辑 —— 所以界面上的「备份」和
 * 模型调 `cloud_sync_backup` 做的是同一件事。
 */

window.__ModuleLoader__.load({
  id: 'dsh-cloud-sync',
  factory(require) {
    /** 设置页的文案命名空间。 */
    const NS = 'settings.cloudSync'

    /** 路由前缀，和 lib/api.js 里的 API_ROOT 必须一致。 */
    const API = '/plugins/dsh-cloud-sync'

    /** 页面标题与说明。 */
    const ZH = {
      nav: '云同步',
      title: '云同步',
      intro: '把 DSH 的配置备份到你自己的 GitHub 仓库，换机器时一键拉回。',
      transportLabel: '传输方式',
      transportApi: 'GitHub API（填 token）',
      transportApiDesc: '不需要本机装 git；填一个 PAT，权限够就能用',
      transportGit: 'git 命令（用本机 SSH key）',
      transportGitDesc: '复用你已经在用的 SSH key / git 凭据，不用再单独发 token',
      remoteUrlLabel: 'git 远程地址（可选）',
      remoteUrlHint: '留空则用 git@github.com:owner/repo.git；填完整地址可指向自建 Git 服务',
      repoLabel: '仓库',
      repoHint: 'owner/repo，例如 szprob/dsh-config',
      branchLabel: '分支',
      branchHint: '默认 main',
      pathLabel: '仓库内目录',
      pathHint: '留空表示仓库根目录；填 dsh 就只读写仓库里的 dsh/ 子目录，不会碰别的文件',
      tokenLabel: 'GitHub token',
      tokenHint: '需要 Contents: Read and write 权限（fine-grained）或 repo 权限（classic）',
      tokenSaved: '已保存',
      tokenNotSaved: '未配置',
      tokenPlaceholderSaved: '已保存，留空表示不修改',
      tokenPlaceholderEmpty: '粘贴 token',
      scopeLabel: '同步范围',
      scopeCore: '配置',
      scopeCoreDesc: '主补丁、各 profile 的补丁与依赖清单',
      scopeState: '应用状态',
      scopeStateDesc: '定时任务、工作区列表、脚本',
      scopeSecrets: '密钥',
      scopeSecretsDesc: '.env、.credentials.yaml、各插件登录态 —— 推到公开仓库会泄露，确认仓库是私有的再开',
      extraLabel: '额外路径',
      extraHint: '要一起同步的其它文件，一行一个，相对 ~/.dsh（只支持这个目录里的文件）',
      save: '保存',
      saving: '保存中…',
      saved: '已保存',
      test: '测试连接',
      testing: '测试中…',
      preview: '预览差异',
      previewing: '对比中…',
      push: '备份到仓库',
      pushing: '备份中…',
      pull: '从仓库恢复',
      pulling: '恢复中…',
      restoreHint: '换机器时：填好上面几项 → 保存 → 从仓库恢复。恢复会覆盖本机同名文件，覆盖前自动备份。',
      lastSync: '上次同步',
      never: '还没有同步过',
      skipTitle: '未同步的项',
      scopeTitle: '会同步什么',
      confirmPull: '从仓库恢复会覆盖本机同名的配置文件。继续吗？（覆盖前会自动备份到 ~/.dsh/cloud-sync/backups）',
      busy: '已有一个同步任务在跑，请等它完成',
      needConfig: '先填仓库和 token',
    }

    const EN = {
      nav: 'Cloud sync',
      title: 'Cloud sync',
      intro: 'Back up your DSH configuration to your own GitHub repository, then restore it on a new machine.',
      transportLabel: 'Transport',
      transportApi: 'GitHub API (token)',
      transportApiDesc: 'No local git needed; a PAT with the right scopes is enough',
      transportGit: 'git command (your SSH key)',
      transportGitDesc: 'Reuses the SSH key or git credentials you already have, no separate token',
      remoteUrlLabel: 'Git remote URL (optional)',
      remoteUrlHint: 'Empty means git@github.com:owner/repo.git; set a full URL for a self-hosted Git service',
      repoLabel: 'Repository',
      repoHint: 'owner/repo, for example szprob/dsh-config',
      branchLabel: 'Branch',
      branchHint: 'Defaults to main',
      pathLabel: 'Folder in repository',
      pathHint: 'Leave empty for the repository root; "dsh" reads and writes only the dsh/ subfolder',
      tokenLabel: 'GitHub token',
      tokenHint: 'Needs Contents: Read and write (fine-grained) or repo scope (classic)',
      tokenSaved: 'Saved',
      tokenNotSaved: 'Not configured',
      tokenPlaceholderSaved: 'Saved — leave empty to keep it',
      tokenPlaceholderEmpty: 'Paste a token',
      scopeLabel: 'What to sync',
      scopeCore: 'Configuration',
      scopeCoreDesc: 'Main patch plus each profile’s patch and dependency list',
      scopeState: 'Application state',
      scopeStateDesc: 'Scheduled tasks, workspace list, scripts',
      scopeSecrets: 'Secrets',
      scopeSecretsDesc: '.env, .credentials.yaml and plugin sign-ins — leaks if the repository is public. Only enable for a private repository',
      extraLabel: 'Extra paths',
      extraHint: 'Other files to sync, one per line, relative to ~/.dsh (only files inside it)',
      save: 'Save',
      saving: 'Saving…',
      saved: 'Saved',
      test: 'Test connection',
      testing: 'Testing…',
      preview: 'Preview changes',
      previewing: 'Comparing…',
      push: 'Back up now',
      pushing: 'Backing up…',
      pull: 'Restore from repository',
      pulling: 'Restoring…',
      restoreHint: 'On a new machine: fill the fields above → Save → Restore. Restoring overwrites local files and backs them up first.',
      lastSync: 'Last sync',
      never: 'Never synced',
      skipTitle: 'Skipped',
      scopeTitle: 'What gets synced',
      confirmPull: 'Restoring overwrites matching local configuration files. Continue? (They are backed up to ~/.dsh/cloud-sync/backups first.)',
      busy: 'A sync is already running; wait for it to finish',
      needConfig: 'Fill in the repository and token first',
    }

    /** 页面样式：全部消费宿主 token，跟随浅色 / 深色主题。 */
    const CSS = `
.dsync-page { display: flex; flex-direction: column; gap: 18px; color: var(--dsw-alias-label-primary); }
.dsync-head { display: grid; grid-template-columns: minmax(0, 1fr); row-gap: 4px; }
.dsync-title { margin: 0; font-size: 15px; font-weight: 600; line-height: 22px; }
.dsync-intro { margin: 0; font-size: 12px; line-height: 18px; color: var(--dsw-alias-label-tertiary); }
.dsync-card {
  display: flex; flex-direction: column; gap: 14px;
  padding: 16px; border: 1px solid var(--dsw-alias-border-l2);
  background: var(--dsw-alias-bg-layer-2); border-radius: 12px;
}
.dsync-field { display: flex; flex-direction: column; gap: 6px; }
.dsync-label { font-size: 13px; font-weight: 500; line-height: 20px; }
.dsync-hint { font-size: 12px; line-height: 18px; color: var(--dsw-alias-label-tertiary); }
.dsync-input {
  box-sizing: border-box; width: 100%; height: 32px; padding: 0 10px;
  font: inherit; font-size: 13px; color: var(--dsw-alias-label-primary);
  background: var(--dsw-alias-bg-layer-1);
  border: 1px solid var(--dsw-alias-border-l2); border-radius: 8px;
}
.dsync-input:focus-visible {
  outline: var(--dsw-focus-ring-width, 2px) solid var(--dsw-focus-ring-color, var(--dsw-alias-brand-primary));
  outline-offset: 1px; border-color: var(--dsw-alias-border-l3);
}
.dsync-textarea { min-height: 68px; padding: 8px 10px; resize: vertical; font-size: 13px; line-height: 20px; }
.dsync-row { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); gap: 12px; }
@media (max-width: 640px) { .dsync-row { grid-template-columns: minmax(0, 1fr); } }
.dsync-check { display: flex; align-items: flex-start; gap: 10px; padding: 8px 0; }
.dsync-check input { margin: 3px 0 0; width: 16px; height: 16px; accent-color: var(--dsw-alias-brand-primary); flex: none; }
.dsync-check-text { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
.dsync-check-title { font-size: 13px; line-height: 20px; }
.dsync-check-desc { font-size: 12px; line-height: 18px; color: var(--dsw-alias-label-tertiary); }
.dsync-warn { color: var(--dsw-alias-state-warn-label); }
.dsync-seg { display: flex; gap: 6px; flex-wrap: wrap; }
.dsync-seg-btn {
  appearance: none; font: inherit; font-size: 12px; line-height: 18px;
  padding: 5px 12px; border-radius: 8px; cursor: pointer;
  color: var(--dsw-alias-label-secondary);
  background: var(--dsw-alias-bg-layer-1);
  border: 1px solid var(--dsw-alias-border-l2);
}
.dsync-seg-btn[aria-pressed='true'] {
  color: var(--dsw-alias-label-primary);
  border-color: var(--dsw-alias-brand-primary);
  background: var(--dsw-alias-bg-layer-3);
}
.dsync-seg-btn:disabled { opacity: 0.55; cursor: default; }
.dsync-seg-btn:focus-visible {
  outline: var(--dsw-focus-ring-width, 2px) solid var(--dsw-focus-ring-color, var(--dsw-alias-brand-primary));
  outline-offset: 1px;
}
.dsync-actions { display: flex; flex-wrap: wrap; gap: 8px; }
.dsync-btn {
  appearance: none; font: inherit; font-size: 13px; line-height: 20px;
  padding: 5px 14px; border-radius: 8px; cursor: pointer;
  color: var(--dsw-alias-label-primary);
  background: var(--dsw-alias-button-elevated-fill);
  border: 1px solid var(--dsw-alias-border-l2);
}
.dsync-btn:hover:not(:disabled) { background: var(--dsw-alias-interactive-bg-hover); }
.dsync-btn:disabled { opacity: 0.55; cursor: default; }
.dsync-btn:focus-visible {
  outline: var(--dsw-focus-ring-width, 2px) solid var(--dsw-focus-ring-color, var(--dsw-alias-brand-primary));
  outline-offset: 1px;
}
.dsync-btn-primary {
  color: var(--dsw-alias-label-on-color, #fff);
  background: var(--dsw-alias-brand-primary);
  border-color: transparent;
}
.dsync-btn-primary:hover:not(:disabled) { background: var(--dsw-alias-button-primary-hover, var(--dsw-alias-brand-primary)); }
.dsync-btn-danger { color: var(--dsw-alias-state-error-label, #d33); border-color: var(--dsw-alias-border-l3); }
.dsync-status { font-size: 12px; line-height: 18px; display: flex; flex-direction: column; gap: 6px; }
.dsync-line { display: flex; gap: 6px; flex-wrap: wrap; }
.dsync-ok { color: var(--dsw-alias-state-success-label, #2a8); }
.dsync-err { color: var(--dsw-alias-state-error-label, #d33); white-space: pre-wrap; word-break: break-word; }
.dsync-list { margin: 4px 0 0; padding-left: 18px; font-size: 12px; line-height: 18px; color: var(--dsw-alias-label-secondary); }
.dsync-mono { font-family: var(--dsw-font-mono, ui-monospace, monospace); font-size: 12px; }
.dsync-sep { height: 1px; background: var(--dsw-alias-border-l1); }
.dsync-pill {
  display: inline-flex; align-items: center; gap: 4px; padding: 1px 8px;
  border-radius: 999px; font-size: 11px; line-height: 18px;
  border: 1px solid var(--dsw-alias-border-l2); color: var(--dsw-alias-label-secondary);
}
`

    /** 把样式表挂进文档，返回移除函数。 */
    function installStyles() {
      const selector = 'style[data-plugin-css="dsh-cloud-sync/page.css"]'
      if (document.querySelector(selector) !== null) return () => {}
      const tag = document.createElement('style')
      tag.dataset.plugin = 'dsh-cloud-sync'
      tag.dataset.pluginCss = 'dsh-cloud-sync/page.css'
      tag.textContent = CSS
      document.head.appendChild(tag)
      return () => tag.remove()
    }

    const React = require('react')
    const h = React.createElement

    /** 所有请求都带同源头和自定义头；失败时把服务端的中文错误原样抛出来。 */
    async function call(path, options = {}) {
      const response = await fetch(`${API}${path}`, {
        method: options.method ?? 'GET',
        credentials: 'same-origin',
        headers: {
          'content-type': 'application/json',
          'x-dsh-cloud-sync': '1',
        },
        body: options.body === undefined ? undefined : JSON.stringify(options.body),
      })
      const text = await response.text()
      let payload
      try {
        payload = text === '' ? {} : JSON.parse(text)
      } catch {
        payload = { error: text }
      }
      if (!response.ok) {
        const error = new Error(payload.error ?? `HTTP ${response.status}`)
        error.code = payload.code
        throw error
      }
      return payload
    }

    /** 一个字段：标签 + 输入框 + 提示。 */
    function Field({ label, hint, children }) {
      return h('div', { className: 'dsync-field' },
        h('label', { className: 'dsync-label' }, label),
        children,
        hint === undefined ? null : h('div', { className: 'dsync-hint' }, hint))
    }

    /** 一个开关行。 */
    function Check({ checked, onChange, title, desc, warn, disabled }) {
      return h('label', { className: 'dsync-check' },
        h('input', {
          type: 'checkbox',
          checked: checked === true,
          disabled: disabled === true,
          onChange: (event) => onChange(event.target.checked),
        }),
        h('span', { className: 'dsync-check-text' },
          h('span', { className: `dsync-check-title${warn ? ' dsync-warn' : ''}` }, title),
          h('span', { className: 'dsync-check-desc' }, desc)))
    }

    /** 上次同步摘要。 */
    function LastSync({ t, lastSync }) {
      if (lastSync === null || lastSync === undefined) {
        return h('div', { className: 'dsync-status' }, h('div', { className: 'dsync-hint' }, `${t('lastSync')}：${t('never')}`))
      }
      const when = typeof lastSync.at === 'string' ? lastSync.at.replace('T', ' ').slice(0, 16) : ''
      const isPush = lastSync.action === 'push'
      const main = isPush
        ? `${lastSync.uploaded} 个更新 / ${lastSync.removed} 个删除 / ${lastSync.unchanged} 个未变`
        : `${lastSync.written} 个写入 / ${lastSync.backedUp ?? 0} 个已备份`
      return h('div', { className: 'dsync-status' },
        h('div', { className: 'dsync-line' },
          h('span', { className: 'dsync-pill' }, isPush ? '备份' : '恢复'),
          h('span', null, when),
          h('span', { className: 'dsync-hint' }, main)),
        typeof lastSync.commit === 'string' && lastSync.commit !== ''
          ? h('div', { className: 'dsync-hint dsync-mono' }, `commit ${lastSync.commit.slice(0, 7)}`)
          : null)
    }

    /** 完整页面。 */
    function CloudSyncPage({ t }) {
      const [status, setStatus] = React.useState(null)
      const [loading, setLoading] = React.useState(true)
      const [loadError, setLoadError] = React.useState('')
      const [busy, setBusy] = React.useState('')
      const [message, setMessage] = React.useState(null)
      const [details, setDetails] = React.useState(null)

      const [transport, setTransport] = React.useState('api')
      const [remoteUrl, setRemoteUrl] = React.useState('')
      const [repo, setRepo] = React.useState('')
      const [branch, setBranch] = React.useState('main')
      const [path, setPath] = React.useState('dsh')
      const [token, setToken] = React.useState('')
      const [include, setInclude] = React.useState({ core: true, state: true, secrets: false })
      const [extra, setExtra] = React.useState('')

      /** 把服务端状态灌进表单；正在编辑时不覆盖用户输入（只灌一次）。 */
      const applyStatus = (next) => {
        setStatus(next)
        setTransport(next.config.transport === 'git' ? 'git' : 'api')
        setRemoteUrl(next.config.remoteUrl ?? '')
        setRepo(next.config.repo)
        setBranch(next.config.branch)
        setPath(next.config.path)
        setInclude({ core: true, state: true, secrets: false, ...next.config.include })
        setExtra((next.config.extraPaths ?? []).join('\n'))
      }

      React.useEffect(() => {
        let alive = true
        call('/status')
          .then((next) => {
            if (!alive) return
            applyStatus(next)
            setLoadError('')
          })
          .catch((error) => { if (alive) setLoadError(error.message) })
          .finally(() => { if (alive) setLoading(false) })
        return () => { alive = false }
      }, [])

      /** 统一处理一次操作：置忙、清消息、跑、报告。 */
      const run = async (key, fn) => {
        if (busy !== '') return
        setBusy(key)
        setMessage(null)
        setDetails(null)
        try {
          const result = await fn()
          setMessage({ ok: true, text: result })
        } catch (error) {
          setMessage({ ok: false, text: error.message })
        } finally {
          setBusy('')
        }
      }

      const save = () => run('save', async () => {
        const config = await call('/config', {
          method: 'POST',
          body: {
            transport,
            remoteUrl,
            repo,
            branch,
            path,
            include,
            extraPaths: extra.split('\n').map((line) => line.trim()).filter((line) => line !== ''),
          },
        })
        if (token.trim() !== '') {
          await call('/token', { method: 'POST', body: { token: token.trim() } })
          setToken('')
        }
        const next = await call('/status')
        applyStatus(next)
        return t('saved')
      })

      const test = () => run('test', async () => {
        const info = await call('/test', { method: 'POST', body: {} })
        setDetails({ kind: 'test', info })
        return `仓库 ${info.repo} 可用（${info.transport === 'git' ? 'git 传输' : info.private ? '私有' : '公开'}）；` +
          `分支 ${info.branch} ${info.branchExists ? '存在' : '还不存在'}；同步目录里现有 ${info.filesInScope} 个文件`
      })

      const preview = () => run('preview', async () => {
        const plan = await call('/preview', { method: 'POST', body: {} })
        setDetails({ kind: 'preview', plan })
        return `本机 ${plan.localCount} 个文件；需要上传 ${plan.upload.length} 个、删除 ${plan.remove.length} 个、未变 ${plan.unchangedCount} 个`
      })

      const push = () => run('push', async () => {
        const summary = await call('/push', { method: 'POST', body: {} })
        const next = await call('/status')
        applyStatus(next)
        setDetails({ kind: 'push', summary })
        return summary.commit === null
          ? '仓库已经是最新的，没有产生新提交'
          : `已备份：更新 ${summary.uploaded} 个、删除 ${summary.removed} 个、未变 ${summary.unchanged} 个（commit ${String(summary.commit).slice(0, 7)}）`
      })

      const pull = () => {
        if (!window.confirm(t('confirmPull'))) return
        return run('pull', async () => {
          const summary = await call('/pull', { method: 'POST', body: {} })
          const next = await call('/status')
          applyStatus(next)
          setDetails({ kind: 'pull', summary })
          return `已恢复 ${summary.written} 个文件（覆盖前备份 ${summary.backedUp} 个）`
        })
      }

      const disabled = busy !== '' || (status !== null && status.busy !== undefined && status.busy !== null)
      const tokenSaved = status?.token?.configured === true

      if (loading) {
        return h('div', { className: 'dsync-page' }, h('div', { className: 'dsync-hint' }, '读取配置…'))
      }

      return h('div', { className: 'dsync-page' },
        h('div', { className: 'dsync-head' },
          h('h2', { className: 'dsync-title' }, t('title')),
          h('p', { className: 'dsync-intro' }, t('intro'))),

        loadError !== ''
          ? h('div', { className: 'dsync-err' }, loadError)
          : null,

        h('div', { className: 'dsync-card' },
          h(Field, { label: t('transportLabel') },
            h('div', { className: 'dsync-seg' },
              h('button', {
                type: 'button',
                className: 'dsync-seg-btn',
                'aria-pressed': transport === 'api',
                disabled,
                onClick: () => setTransport('api'),
                title: t('transportApiDesc'),
              }, t('transportApi')),
              h('button', {
                type: 'button',
                className: 'dsync-seg-btn',
                'aria-pressed': transport === 'git',
                disabled,
                onClick: () => setTransport('git'),
                title: t('transportGitDesc'),
              }, t('transportGit')))),
          h(Field, { label: t('repoLabel'), hint: t('repoHint') },
            h('input', {
              className: 'dsync-input',
              value: repo,
              placeholder: 'owner/repo',
              spellCheck: false,
              onChange: (event) => setRepo(event.target.value),
            })),
          h('div', { className: 'dsync-row' },
            h(Field, { label: t('branchLabel'), hint: t('branchHint') },
              h('input', {
                className: 'dsync-input',
                value: branch,
                spellCheck: false,
                onChange: (event) => setBranch(event.target.value),
              })),
            h(Field, { label: t('pathLabel'), hint: t('pathHint') },
              h('input', {
                className: 'dsync-input',
                value: path,
                placeholder: 'dsh',
                spellCheck: false,
                onChange: (event) => setPath(event.target.value),
              }))),
          transport === 'api'
            ? h(Field, {
                label: t('tokenLabel'),
                hint: `${tokenSaved ? t('tokenSaved') : t('tokenNotSaved')} · ${t('tokenHint')}`,
              },
                h('input', {
                  className: 'dsync-input',
                  type: 'password',
                  autoComplete: 'off',
                  value: token,
                  placeholder: tokenSaved ? t('tokenPlaceholderSaved') : t('tokenPlaceholderEmpty'),
                  onChange: (event) => setToken(event.target.value),
                }))
            : h(Field, { label: t('remoteUrlLabel'), hint: t('remoteUrlHint') },
                h('input', {
                  className: 'dsync-input',
                  value: remoteUrl,
                  placeholder: 'git@github.com:owner/repo.git',
                  spellCheck: false,
                  onChange: (event) => setRemoteUrl(event.target.value),
                }))),

        h('div', { className: 'dsync-card' },
          h('div', { className: 'dsync-label' }, t('scopeLabel')),
          h(Check, {
            checked: include.core, disabled,
            onChange: (value) => setInclude((prev) => ({ ...prev, core: value })),
            title: t('scopeCore'), desc: t('scopeCoreDesc'),
          }),
          h(Check, {
            checked: include.state, disabled,
            onChange: (value) => setInclude((prev) => ({ ...prev, state: value })),
            title: t('scopeState'), desc: t('scopeStateDesc'),
          }),
          h(Check, {
            checked: include.secrets, disabled, warn: true,
            onChange: (value) => setInclude((prev) => ({ ...prev, secrets: value })),
            title: t('scopeSecrets'), desc: t('scopeSecretsDesc'),
          }),
          h('div', { className: 'dsync-sep' }),
          h(Field, { label: t('extraLabel'), hint: t('extraHint') },
            h('textarea', {
              className: 'dsync-input dsync-textarea',
              value: extra,
              spellCheck: false,
              placeholder: 'profiles/desktop/.plugin-manager',
              onChange: (event) => setExtra(event.target.value),
            }))),

        h('div', { className: 'dsync-actions' },
          h('button', { className: 'dsync-btn dsync-btn-primary', disabled, onClick: save }, busy === 'save' ? t('saving') : t('save')),
          h('button', { className: 'dsync-btn', disabled, onClick: test }, busy === 'test' ? t('testing') : t('test')),
          h('button', { className: 'dsync-btn', disabled, onClick: preview }, busy === 'preview' ? t('previewing') : t('preview')),
          h('button', { className: 'dsync-btn', disabled, onClick: push }, busy === 'push' ? t('pushing') : t('push')),
          h('button', { className: 'dsync-btn dsync-btn-danger', disabled, onClick: pull }, busy === 'pull' ? t('pulling') : t('pull'))),

        message === null
          ? null
          : h('div', { className: message.ok ? 'dsync-status dsync-ok' : 'dsync-status dsync-err' }, message.text),

        details === null ? null : h(Details, { t, details }),

        h('div', { className: 'dsync-sep' }),
        h(LastSync, { t, lastSync: status?.config?.lastSync ?? null }),
        h('div', { className: 'dsync-hint' }, t('restoreHint')))
    }

    /** 操作的详细信息：测试结果、差异列表、跳过项。 */
    function Details({ t, details }) {
      if (details.kind === 'preview') {
        const plan = details.plan
        return h('div', { className: 'dsync-card' },
          plan.upload.length > 0
            ? h('div', null,
                h('div', { className: 'dsync-label' }, `要上传（${plan.upload.length}）`),
                h('ul', { className: 'dsync-list' },
                  plan.upload.slice(0, 20).map((file) => h('li', { key: file.path, className: 'dsync-mono' }, file.path)),
                  plan.upload.length > 20 ? h('li', { key: '__more' }, `…还有 ${plan.upload.length - 20} 个`) : null))
            : h('div', { className: 'dsync-hint' }, '没有要上传的文件'),
          plan.remove.length > 0
            ? h('div', null,
                h('div', { className: 'dsync-label' }, `仓库里会被删除（${plan.remove.length}）`),
                h('ul', { className: 'dsync-list' },
                  plan.remove.slice(0, 20).map((file) => h('li', { key: file, className: 'dsync-mono' }, file)),
                  plan.remove.length > 20 ? h('li', { key: '__rmore' }, `…还有 ${plan.remove.length - 20} 个`) : null))
            : null,
          Array.isArray(plan.skipped) && plan.skipped.length > 0
            ? h('div', null,
                h('div', { className: 'dsync-label' }, `${t('skipTitle')}（${plan.skipped.length}）`),
                h('ul', { className: 'dsync-list' },
                  plan.skipped.slice(0, 10).map((item) => h('li', { key: item.path }, `${item.path} — ${item.reason}`)),
                  plan.skipped.length > 10 ? h('li', { key: '__smore' }, `…还有 ${plan.skipped.length - 10} 个`) : null))
            : null)
      }
      if (details.kind === 'test') {
        const info = details.info
        return h('div', { className: 'dsync-card dsync-status' },
          h('div', { className: 'dsync-mono' }, info.htmlUrl ?? info.remoteUrl ?? ''),
          h('div', null, `传输 ${info.transport} · 分支 ${info.branch} · 同步目录 ${info.path || '（仓库根）'} · 目录里 ${info.filesInScope} 个文件`),
          info.canPush === false ? h('div', { className: 'dsync-err' }, 'token 对这个仓库没有写权限') : null)
      }
      const summary = details.summary
      if (summary === undefined) return null
      return h('div', { className: 'dsync-card dsync-status' },
        h('div', { className: 'dsync-mono' }, summary.commit ? `commit ${String(summary.commit).slice(0, 7)}` : '（无新提交）'),
        summary.backupDir ? h('div', null, `备份目录 ${summary.backupDir}`) : null,
        Array.isArray(summary.skipped) && summary.skipped.length > 0
          ? h('ul', { className: 'dsync-list' },
              summary.skipped.slice(0, 10).map((item) => h('li', { key: item.path }, `${item.path} — ${item.reason}`)))
          : null)
    }

    return {
      inject: ['slots', 'locale'],
      apply(ctx) {
        ctx.effect(() => ctx.locale.register(NS, { zh: ZH, en: EN }), 'cloud-sync: dictionaries')
        ctx.effect(() => installStyles(), 'cloud-sync: page styles')

        // 文案函数从 locale 服务取；`t` 同时给页面和导航标签用。
        const t = ctx.locale.bind(NS)
        ctx.slots.inject('settings.section', () => ctx.slots.register({
          name: 'settings.section',
          id: 'dsh-cloud-sync',
          order: 40,
          label: () => t('nav'),
          locale: NS,
          inject: () => ({ t }),
        }, CloudSyncPage))
      },
    }
  },
})
