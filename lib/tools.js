/**
 * 给 model 的三个工具：看状态、备份、恢复。
 *
 * 用**原始 JSON Schema** 注册（不走 `defineTool`）：这个插件是 `link:` 装进
 * profile 的独立包，静态 import DSH 安装目录里的 `@deepseek-ai/*` 会多一个解析
 * 依赖；参数校验手写，报错也更直白。
 */

/** 工具名统一带前缀，避免和宿主或别的插件重名。 */
export const TOOL_NAMES = {
  status: 'cloud_sync_status',
  backup: 'cloud_sync_backup',
  restore: 'cloud_sync_restore',
}

/** 同步结果的文字摘要。 */
function summarizePush(value) {
  if (value.uploaded === 0 && value.removed === 0) {
    return `仓库已经是最新的（${value.total} 个文件都一致），没有产生新提交。`
  }
  const parts = [
    `已备份到 ${value.repo}（分支 ${value.branch}，目录 ${value.path || '仓库根'}），传输方式 ${
      value.transport === 'git' ? 'git 命令' : 'GitHub API'
    }。`,
    `新提交 ${value.commit ? String(value.commit).slice(0, 7) : '（无）'}：更新 ${value.uploaded} 个、删除 ${value.removed} 个、未变 ${value.unchanged} 个。`,
  ]
  if (Array.isArray(value.skipped) && value.skipped.length > 0) {
    const shown = value.skipped.slice(0, 5).map((item) => `${item.path}（${item.reason}）`).join('、')
    parts.push(`跳过 ${value.skipped.length} 项：${shown}${value.skipped.length > 5 ? ' 等' : ''}`)
  }
  return parts.join('')
}

function summarizePull(value) {
  if (value.written === 0) {
    return `本机已经和仓库一致（${value.total} 个文件），没有写入任何文件。`
  }
  const parts = [`已从 ${value.repo}（分支 ${value.branch}）恢复 ${value.written} 个文件。`]
  if (value.backedUp > 0) parts.push(`覆盖前把 ${value.backedUp} 个旧文件备份到了 ${value.backupDir}。`)
  parts.push('重启 DSH（或刷新页面）让新配置生效。')
  return parts.join('')
}

const RESULT_SCHEMA = {
  type: 'object',
  additionalProperties: true,
  properties: {
    ok: { type: 'boolean', required: true },
    message: { type: 'string', required: true },
  },
}

/**
 * 注册三个工具，返回卸载函数。
 *
 * 工具只做参数校验 + 调业务方法，和网页按钮走同一份实现。
 */
export function registerTools(ctx, service) {
  const disposers = []

  disposers.push(ctx.tools.register({
    name: TOOL_NAMES.status,
    description:
      '查看 DSH 云同步的当前状态：配置的 GitHub 仓库、分支、仓库内目录、传输方式、token 是否已配置、同步范围开关，以及最近一次同步的时间与结果。只读，不访问网络。',
    parameters: { type: 'object', additionalProperties: false, properties: {} },
    output: {
      schema: {
        type: 'object',
        additionalProperties: true,
        properties: {
          transport: { type: 'string', required: true },
          repo: { type: 'string', required: true },
          branch: { type: 'string', required: true },
          path: { type: 'string', required: true },
          tokenConfigured: { type: 'boolean', required: true },
          tokenSource: { type: 'string', required: true },
          include: { type: 'object', additionalProperties: true, required: true },
          extraPaths: { type: 'array', items: { type: 'string' }, required: true },
          lastSync: { oneOf: [{ type: 'object', additionalProperties: true }, { type: 'null' }], required: true },
          configured: { type: 'boolean', required: true },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: value.configured
          ? `仓库 ${value.repo}（分支 ${value.branch}，目录 ${value.path || '仓库根'}，传输 ${value.transport}）；` +
            `token ${value.tokenConfigured ? `已配置（${value.tokenSource}）` : '未配置'}；` +
            `同步范围 core=${value.include.core} state=${value.include.state} secrets=${value.include.secrets}` +
            (value.lastSync ? `；最近一次：${value.lastSync.action === 'push' ? '备份' : '恢复'}于 ${value.lastSync.at}` : '；还没有同步过')
          : '还没有配置完成：先在「设置 → 云同步」里填仓库，再填 token 或改用 git 传输。',
      }],
    },
    async execute() {
      const status = await service.status()
      const transport = status.config.transport
      return {
        transport,
        repo: status.config.repo,
        branch: status.config.branch,
        path: status.config.path,
        tokenConfigured: status.token.configured,
        tokenSource: status.token.source,
        include: status.config.include,
        extraPaths: status.config.extraPaths,
        lastSync: status.config.lastSync,
        configured: status.config.repo !== '' && (transport === 'git' || status.token.configured),
      }
    },
  }))

  disposers.push(ctx.tools.register({
    name: TOOL_NAMES.backup,
    description:
      '把本机 DSH 配置备份（推送）到已配置的 GitHub 仓库：只写仓库里配置的同步目录，内容有变化才产生提交。返回提交 sha 与更新/删除/未变的文件数。需要先在「设置 → 云同步」里配好仓库（以及 token 或 git 传输）。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        message: { type: 'string', description: '可选：自定义提交信息；不填则自动生成' },
      },
    },
    output: {
      schema: RESULT_SCHEMA,
      render: (_args, value) => [{ type: 'text', text: value.message }],
    },
    async execute(args) {
      const summary = await service.push({ message: args.message })
      return { ok: true, message: summarizePush(summary), ...summary }
    },
  }))

  disposers.push(ctx.tools.register({
    name: TOOL_NAMES.restore,
    description:
      '从已配置的 GitHub 仓库恢复（拉取）DSH 配置到本机：覆盖同名文件，覆盖前把旧文件备份到 ~/.dsh/cloud-sync/backups/。新机器装好插件、配好仓库后用它一键恢复。恢复完成后需要重启 DSH 才生效。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        check: { type: 'boolean', description: '只校验仓库可达性（true），不做任何写入' },
      },
    },
    output: {
      schema: RESULT_SCHEMA,
      render: (_args, value) => [{ type: 'text', text: value.message }],
    },
    async execute(args) {
      if (args.check === true) {
        const info = await service.test()
        return {
          ok: true,
          message:
            `仓库 ${info.repo} 可访问（传输 ${info.transport}）；分支 ${info.branch} ${info.branchExists ? '存在' : '还不存在'}；` +
            `同步目录 ${info.path || '（仓库根）'} 里现有 ${info.filesInScope} 个文件。`,
        }
      }
      const summary = await service.restore()
      return { ok: true, message: summarizePull(summary), ...summary }
    },
  }))

  return () => {
    for (const dispose of disposers) {
      try {
        dispose()
      } catch {
        // 卸载时单个工具失败不影响其它工具。
      }
    }
  }
}
