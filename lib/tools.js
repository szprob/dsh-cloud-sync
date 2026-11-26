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
  schedule: 'cloud_sync_schedule',
  plugins: 'cloud_sync_plugins',
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
  if (Array.isArray(value.linkedDeps) && value.linkedDeps.length > 0) {
    const list = value.linkedDeps.map((item) => `${item.package}（${item.profile}，期望在 ${item.target}）`).join('、')
    parts.push(`注意：以下插件在本机是 link 安装，恢复后路径不存在，需要重新安装或改成本机路径：${list}。`)
  }
  if (Array.isArray(value.droppedPlatformPlugins) && value.droppedPlatformPlugins.length > 0) {
    parts.push(`已按 ${value.platform ?? '当前'} 平台从配置里剔除 ${value.droppedPlatformPlugins.length} 个不适用插件：${value.droppedPlatformPlugins.join('、')}。`)
  }
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
          schedule: { type: 'object', additionalProperties: true, required: true },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: value.configured
          ? `仓库 ${value.repo}（分支 ${value.branch}，目录 ${value.path || '仓库根'}，传输 ${value.transport}）；` +
            `token ${value.tokenConfigured ? `已配置（${value.tokenSource}）` : '未配置'}；` +
            `同步范围 core=${value.include.core} state=${value.include.state} secrets=${value.include.secrets}` +
            (value.lastSync ? `；最近一次：${value.lastSync.action === 'push' ? '备份' : '恢复'}于 ${value.lastSync.at}` : '；还没有同步过') +
            `；定时备份：${value.schedule.description}` +
            (value.schedule.nextRunAt ? `（下次 ${value.schedule.nextRunAt}）` : '')
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
        schedule: status.schedule,
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

  disposers.push(ctx.tools.register({
    name: TOOL_NAMES.schedule,
    description:
      '查看或修改 DSH 云同步的定时备份周期。三种周期：off（关闭）、daily（每天 HH:MM）、interval（每隔 N 分钟）、weekly（每周几 HH:MM）。不传任何参数就是查询。定时只做备份，不会自动恢复。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        mode: { type: 'string', enum: ['off', 'daily', 'interval', 'weekly'], description: '周期类型；off 表示关闭' },
        time: { type: 'string', description: 'HH:MM，daily 与 weekly 用；不传则保持原值' },
        minutes: { type: 'number', description: '间隔分钟数，interval 用；1 到 10080' },
        weekday: { type: 'number', description: '1=周一 … 7=周日，weekly 用' },
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: true,
        properties: {
          ok: { type: 'boolean', required: true },
          message: { type: 'string', required: true },
          schedule: { type: 'object', additionalProperties: true, required: true },
        },
      },
      render: (_args, value) => [{ type: 'text', text: value.message }],
    },
    async execute(args) {
      const patch = {}
      for (const key of ['mode', 'time', 'minutes', 'weekday']) {
        if (args[key] !== undefined) patch[key] = args[key]
      }
      if (Object.keys(patch).length > 0) await service.save({ schedule: patch })
      const status = await service.status()
      const schedule = status.schedule
      const next = schedule.nextRunAt ? new Date(schedule.nextRunAt) : undefined
      const nextText = next === undefined
        ? ''
        : `；下次 ${next.toLocaleString('zh-CN', { hour12: false })}`
      return {
        ok: true,
        message: `定时备份：${schedule.description}${nextText}`,
        schedule,
      }
    },
  }))

  disposers.push(ctx.tools.register({
    name: TOOL_NAMES.plugins,
    description:
      '管理「其他插件」的清单：action=export 导出一份当前 profile 装了哪些插件的清单（随配置一起进仓库）；action=preview 看这份清单会装什么；action=install 按清单一键装回全部插件。装完必须重启 DSH 才生效。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        action: {
          type: 'string',
          enum: ['export', 'preview', 'install'],
          required: true,
          description: 'export 导出清单；preview 预览会装什么；install 装回',
        },
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: true,
        properties: {
          ok: { type: 'boolean', required: true },
          message: { type: 'string', required: true },
        },
      },
      render: (_args, value) => [{ type: 'text', text: value.message }],
    },
    async execute(args) {
      if (args.action === 'export') {
        const result = await service.exportPlugins()
        return {
          ok: true,
          message:
            `已导出插件清单（${result.profiles.join('、')}）：共 ${result.total} 个` +
            `（registry ${result.registry}、git ${result.git}、无法自动安装 ${result.unresolvable}）。` +
            `下次备份会一起进仓库。`,
          ...result,
          manifest: undefined,
        }
      }
      if (args.action === 'preview') {
        const preview = await service.previewPlugins()
        if (preview.available !== true) return { ok: false, message: preview.message }
        const manual = preview.manual.length > 0
          ? `；需要手工安装：${preview.manual.map((item) => item.name).join('、')}`
          : ''
        const skipped = (preview.skippedPlatform ?? []).length > 0
          ? `；${preview.platform} 平台跳过 ${preview.skippedPlatform.length} 个：${preview.skippedPlatform.map((item) => item.name).join('、')}（清单保留，换平台可装）`
          : ''
        return {
          ok: true,
          message: `清单（${preview.profile}，${preview.generatedAt}，目标 ${preview.platform}）里有 ${preview.add.length} 个可自动安装的插件${manual}${skipped}。${
            preview.depsReady === false ? '当前 profile 还没装任何依赖，建议直接装回。' : ''
          }`,
          ...preview,
        }
      }
      const result = await service.installPlugins()
      const parts = []
      if (result.installed.length > 0) parts.push(`安装成功 ${result.installed.length} 个：${result.installed.join('、')}`)
      if (result.failed.length > 0) {
        parts.push(`失败 ${result.failed.length} 个：${result.failed.map((item) => item.spec).join('、')}`)
      }
      if (result.manual.length > 0) parts.push(`需要手工安装：${result.manual.map((item) => item.name).join('、')}`)
      if ((result.skippedPlatform ?? []).length > 0) {
        parts.push(`${result.platform ?? '当前'} 平台跳过 ${result.skippedPlatform.length} 个：${result.skippedPlatform.map((item) => item.name).join('、')}`)
      }
      if (result.warning) parts.push(result.warning)
      if (result.restartRequired) parts.push('重启 DSH 后新插件才会加载')
      return { ok: result.failed.length === 0, message: parts.join('；') + '。', ...result }
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
