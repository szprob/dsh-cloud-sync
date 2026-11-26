/**
 * 云同步服务：插件对外的唯一实现。
 *
 * UI 和 agent 工具都调这里的方法，所以「点按钮」和「让模型做」走同一份代码。
 *
 * 传输有两条，接口一致（`listScoped` / `commitFiles` / `readScoped`）：
 *  - `api`：GitHub REST + token，无需本机装 git；
 *  - `git`：本机 git 命令，用已有的 SSH key 或 git 凭据。
 * 仓库里的目录结构两者完全相同，可以随时切换。
 */

import { join } from 'node:path'
import { ConfigStore, normalizeRepoPath } from './config.js'
import { GitHubClient, GitHubError } from './github.js'
import { GitTransport } from './gitcli.js'
import { mkdir, readFile, readdir } from 'node:fs/promises'
import { resolveDshHome, pluginDataDir, writeJsonFile } from './paths.js'
import { CATEGORIES, collectLocal, planSync, pullPlan, makeBackupDir, pruneBackups } from './sync.js'
import { ScheduleRunner, defaultSchedule, describeSchedule, normalizeSchedule } from './schedule.js'
import { collectManifest, summarizeManifest, planInstall, MANIFEST_NAME } from './plugins-manifest.js'
import { hasInstalledDeps, installProfilePlugins, locatePnpm, PluginInstallError } from './pnpm.js'
import { currentPlatform, readOverrides, normalizePlatform } from './platform.js'
import { rewriteFilesForPlatform } from './config-rewrite.js'

/**
 * 凭据记录的地址：`<scope>/<id>`，两段都必须是「小写字母开头的连字符标识符」。
 *
 * 用字符串字面量而不是 `credentialKey()`：那个函数在 `@deepseek-ai/dsh-credentials`
 * 包里，第三方插件解析不到 DSH 安装目录的包（loader 的 `import.meta.resolve`
 * 锚在 profile 目录）。`brandString` 在运行时是恒等函数，字符串就是合法值。
 */
const CREDENTIAL_KEY = 'dsh-cloud-sync/github'

/** 备份保留份数。 */
const BACKUP_KEEP = 10

export class CloudSyncService {
  constructor(ctx) {
    this.ctx = ctx
    this.home = resolveDshHome()
    this.store = new ConfigStore(this.home)
    this.config = undefined
    this.running = undefined
    /** 定时备份的定时器；`apply` 之后由插件启动，卸载时停掉。 */
    this.scheduler = undefined
    /** 最近一次定时（非手动）备份的结果，只放在内存里够界面显示即可。 */
    this.lastAutoResult = null
  }

  get logger() {
    return this.ctx.logger
  }

  // ---------------- 配置 ----------------

  async load() {
    if (this.config === undefined) this.config = await this.store.read()
    return this.config
  }

  async save(patch) {
    const current = await this.load()
    const next = { ...current }
    if (patch.transport !== undefined) next.transport = patch.transport === 'git' ? 'git' : 'api'
    if (patch.repo !== undefined) next.repo = String(patch.repo).trim()
    if (patch.remoteUrl !== undefined) next.remoteUrl = String(patch.remoteUrl).trim()
    if (patch.branch !== undefined) next.branch = String(patch.branch).trim() || 'main'
    if (patch.path !== undefined) next.path = normalizeRepoPath(patch.path)
    if (patch.include !== undefined) next.include = { ...current.include, ...patch.include }
    if (patch.extraPaths !== undefined) next.extraPaths = patch.extraPaths
    if (patch.schedule !== undefined) next.schedule = normalizeSchedule({ ...current.schedule, ...patch.schedule })
    this.config = await this.store.write(next)
    // 调度配置一变就重排下一次：用户改完不该等到旧周期才生效。
    if (this.scheduler !== undefined) this.scheduler.arm()
    this.emitChanged()
    return this.config
  }

  // ---------------- token ----------------

  get credentials() {
    try {
      return this.ctx.get('credentials')
    } catch {
      return undefined
    }
  }

  /** 读 token：优先凭据记录，其次退回文件。 */
  async readToken() {
    const credentials = this.credentials
    if (credentials !== undefined) {
      try {
        const record = await credentials.readRecord(CREDENTIAL_KEY)
        const token = record?.kind === 'grant' ? record.payload?.token : record?.key
        if (typeof token === 'string' && token !== '') return { token, source: 'credentials' }
      } catch (error) {
        this.logger?.warn?.('cloud-sync: 读取凭据记录失败，退回文件', error)
      }
    }
    const fallback = await this.store.readFallbackToken()
    return fallback === undefined ? { token: undefined, source: 'none' } : { token: fallback, source: 'file' }
  }

  /** 存 token；返回落在哪里（`credentials` 或 `file`）。 */
  async saveToken(token) {
    const credentials = this.credentials
    if (credentials !== undefined) {
      try {
        await credentials.modifyRecord(CREDENTIAL_KEY, async () => ({ kind: 'grant', payload: { token } }))
        await this.store.clearFallbackToken()
        return 'credentials'
      } catch (error) {
        this.logger?.warn?.('cloud-sync: 写入凭据记录失败，退回文件存储', error)
      }
    }
    await this.store.writeFallbackToken(token)
    return 'file'
  }

  async clearToken() {
    const credentials = this.credentials
    if (credentials !== undefined) {
      try {
        await credentials.deleteRecord(CREDENTIAL_KEY)
      } catch {
        // 没有记录时删不掉不算错。
      }
    }
    await this.store.clearFallbackToken()
  }

  // ---------------- 传输 ----------------

  /**
   * 按配置挑一条传输。
   *
   * 缺少仓库 / token 时抛出带 `code` 的错误 —— 浏览器半边会把它原样显示在页面上。
   */
  async transport() {
    const config = await this.load()
    if (config.repo === '' && config.remoteUrl === '') {
      throw new GitHubError('还没填仓库，请先在「设置 → 云同步」里填 owner/repo', { code: 'NO_REPO' })
    }
    if (config.transport === 'git') {
      return new GitTransport({
        repo: config.repo,
        branch: config.branch,
        workDir: join(pluginDataDir(this.home), 'work'),
        remoteUrl: config.remoteUrl,
        log: (line) => this.logger?.info?.(`cloud-sync: ${line}`),
      })
    }
    const { token } = await this.readToken()
    if (token === undefined) {
      throw new GitHubError(
        '还没填 GitHub token。想用本机已有的 SSH key 同步，把「传输方式」改成 git',
        { code: 'NO_TOKEN' },
      )
    }
    return new GitHubClient({ token, repo: config.repo, branch: config.branch })
  }

  // ---------------- 状态 ----------------

  async status() {
    const config = await this.load()
    const { token, source } = await this.readToken()
    return {
      config: publicConfig(config, await this.store.readLastSync()),
      token: { configured: token !== undefined, source },
      home: this.home,
      categories: Object.keys(CATEGORIES),
      busy: this.running,
      schedule: {
        ...config.schedule,
        description: describeSchedule(config.schedule),
        nextRunAt: this.nextRunAt()?.toISOString() ?? null,
        lastAuto: this.lastAutoResult,
      },
    }
  }

  /** 验证仓库可达、分支状态；只读。 */
  async test() {
    const config = await this.load()
    const transport = await this.transport()
    if (transport instanceof GitTransport) {
      const { branchExists } = await transport.prepare()
      const scoped = await transport.listScoped(config.path)
      let remote = null
      try {
        const url = await transport.remoteUrl
        remote = url
      } catch {
        remote = null
      }
      return {
        transport: 'git',
        repo: config.repo,
        remoteUrl: transport.remoteUrl,
        branch: config.branch,
        branchExists,
        empty: !branchExists,
        filesInScope: scoped.size,
        path: config.path,
        private: null,
        canPush: true,
      }
    }
    const info = await transport.inspect()
    const scoped = await transport.listScoped(config.path)
    return {
      transport: 'api',
      repo: info.full,
      private: info.private,
      defaultBranch: info.defaultBranch,
      branch: config.branch,
      branchExists: scoped.commit !== undefined,
      empty: scoped.commit === undefined,
      filesInScope: scoped.files.size,
      path: config.path,
      htmlUrl: info.htmlUrl,
      canPush: info.permissions.push === true,
    }
  }

  /** 只看差异，不写任何东西。 */
  async preview() {
    const config = await this.load()
    const transport = await this.transport()
    const local = await collectLocal({
      home: this.home,
      include: config.include,
      extraPaths: config.extraPaths,
      log: (line) => this.logger?.info?.(`cloud-sync: ${line}`),
    })
    if (typeof transport.prepare === 'function') await transport.prepare()
    const remote = await transport.listScoped(config.path)
    // `remote.files` 的 key 已经是同步目录内的相对路径（传输层剥过前缀），
    // 这里再传 `configPath` 会剥第二次、结果一条都对不上 —— 每次都全量重传。
    const plan = planSync({
      files: local.files,
      remote: { files: remote.files },
      configPath: '',
    })
    return {
      transport: config.transport,
      repoPath: config.path,
      upload: plan.upload.map((file) => ({ path: file.rel, size: file.size })),
      unchangedCount: plan.unchanged.length,
      remove: plan.remove,
      skipped: local.skipped,
      totalBytes: local.totalBytes,
      localCount: local.files.length,
      remoteCount: plan.remoteCount,
      branchExists: remote.commit !== undefined,
    }
  }

  /** 备份：把本机推到仓库。 */
  /**
   * 备份到仓库。
   *
   * `auto` 为真表示这次由定时器触发：结果会额外记进 `lastAutoResult`，
   * 界面据此区分「我点的」和「它自己跑的」。
   */
  async push({ message, auto = false } = {}) {
    return this.exclusive('push', async () => {
      const config = await this.load()
      // 先确认配置可用（仓库 / token），再扫本机文件：配置没填好时，
      // 「没有可同步的文件」会把真正的问题藏起来。
      const transport = await this.transport()
      /**
       * 每次备份前刷新插件清单。
       *
       * 清单是「这台机器装了什么」的快照，跟配置一起进仓库；忘了手动导出也不会
       * 让新机器拿到一份过期清单 —— 只要清单生成本身失败（比如 profile 目录
       * 结构异常），就带着旧清单继续备份，不因此让整个 push 失败。
       */
      try {
        await this.exportPlugins()
      } catch (error) {
        this.logger?.warn?.('cloud-sync: 生成插件清单失败，本次沿用旧清单', error)
      }
      const local = await collectLocal({
        home: this.home,
        include: config.include,
        extraPaths: config.extraPaths,
        log: (line) => this.logger?.info?.(`cloud-sync: ${line}`),
      })
      if (local.files.length === 0) {
        throw new Error('没有找到可同步的文件；检查「同步范围」里的开关，或把要同步的文件放进 ~/.dsh')
      }
      // git 传输靠镜像工作区：先 fetch 才能看到远端真实状态。
      if (typeof transport.prepare === 'function') await transport.prepare()
      const remote = await transport.listScoped(config.path)
      // key 已是同步目录内的相对路径，`configPath` 传空串（见 preview 的注释）。
      const plan = planSync({
        files: local.files,
        remote: { files: remote.files },
        configPath: '',
      })
      const commit = await transport.commitFiles({
        configPath: config.path,
        files: plan.upload,
        remove: plan.remove,
        message: typeof message === 'string' && message.trim() !== '' ? message : defaultMessage('push', plan.upload.length),
        author: this.author(),
      })
      const summary = {
        action: 'push',
        transport: config.transport,
        commit: commit ?? null,
        uploaded: plan.upload.length,
        removed: plan.remove.length,
        unchanged: plan.unchanged.length,
        total: local.files.length,
        bytes: local.totalBytes,
        repo: config.repo,
        branch: config.branch,
        path: config.path,
        skipped: local.skipped,
        at: new Date().toISOString(),
        auto: auto === true,
      }
      this.config = await this.store.write(config)
      await this.store.writeLastSync(summary)
      if (auto === true) this.lastAutoResult = { ok: true, at: summary.at, summary }
      this.emitChanged()
      return summary
    })
  }

  /** 恢复：从仓库拉到本机，写盘前先备份被覆盖的文件。 */
  async pull() {
    return this.exclusive('pull', async () => {
      const config = await this.load()
      const transport = await this.transport()
      if (typeof transport.prepare === 'function') await transport.prepare()
      const remote = await transport.readScoped(config.path)
      if (remote.commit === undefined) {
        throw new GitHubError(
          `分支 ${config.branch} 上还没有任何提交，没有东西可拉。请先在一台配置好的机器上点一次「备份到仓库」`,
          { code: 'EMPTY_REMOTE' },
        )
      }
      /**
       * 按目标平台改写配置。
       *
       * 清单（`cloud-sync/plugins.json`）在仓库里，要用**拉回来的那份**判断平台，
       * 不能用本机旧的 —— 老机器上可能换了插件。改写只动 `package.json` /
       * `cordis.patch.yml`，把不适用插件的 bundle 项和配置段剔掉。
       */
      const platform = await this.targetPlatform()
      const manifestFile = remote.files.find((item) => item.rel === `cloud-sync/${MANIFEST_NAME}`)
      let manifest
      try {
        manifest = manifestFile === undefined
          ? undefined
          : JSON.parse(Buffer.from(manifestFile.buffer).toString('utf8'))
      } catch {
        manifest = undefined
      }
      const overrides = await readOverrides(join(pluginDataDir(this.home), 'platform-overrides.json'))
      const rewritten = rewriteFilesForPlatform(remote.files, manifest, platform, overrides)
      if (rewritten.rewritten.length > 0) {
        this.logger?.info?.(`cloud-sync: 按 ${platform} 改写了 ${rewritten.rewritten.length} 个配置文件`)
      }

      const backupDir = await makeBackupDir(this.store.backupRoot)
      const result = await pullPlan({
        files: rewritten.files,
        home: this.home,
        backupDir,
        log: (line) => this.logger?.info?.(`cloud-sync: ${line}`),
      })
      await pruneBackups(this.store.backupRoot, BACKUP_KEEP)
      const summary = {
        action: 'pull',
        transport: config.transport,
        commit: remote.commit,
        written: result.written.length,
        backedUp: result.backedUp.length,
        total: result.staged,
        repo: config.repo,
        branch: config.branch,
        path: config.path,
        platform,
        rewrittenFiles: rewritten.rewritten,
        droppedPlatformPlugins: rewritten.dropped,
        backupDir,
        skipped: result.skipped,
        at: new Date().toISOString(),
        writtenPaths: result.written,
        linkedDeps: await checkLinkedDeps(this.home),
      }
      // 仓库里可能带回来一份新的 config.json，重新读一次（随后 append 的 lastSync 单独存放）。
      this.config = await this.store.read()
      await this.store.writeLastSync(summary)
      this.emitChanged()
      return summary
    })
  }

  /** 「新机器」的一键流程：先校验，再拉取。 */
  async restore() {
    const checked = await this.test()
    const result = await this.pull()
    return { ...result, checked }
  }

  // ---------------- 插件清单 ----------------

  /**
   * 当前 profile 的目录与名字。
   *
   * `ctx.get('profileContext')` 在 Cordis 里同样要求声明过 inject，所以照常只
   * 用 `$DSH_PROFILE` / `$DSH_PROFILE_DIR`（profile 启的进程一定有这两个）。两个
   * 都没有时才退到 `<home>/profiles/desktop`，那是桌面端的默认位置。
   */
  profileInfo() {
    const name = (process.env.DSH_PROFILE ?? '').trim() || 'desktop'
    const dir = (process.env.DSH_PROFILE_DIR ?? '').trim() || join(this.home, 'profiles', name)
    return { name, dir }
  }

  /** 目标平台：可由覆盖文件里的 `$platform` 手动指定，否则取当前系统。 */
  async targetPlatform() {
    const overrides = await readOverrides(join(pluginDataDir(this.home), 'platform-overrides.json'))
    const forced = normalizePlatform(overrides?.$platform)
    return forced ?? currentPlatform()
  }

  /**
   * 生成插件清单并写进 `cloud-sync/plugins.json`。
   *
   * 这个文件会随下一次备份一起进仓库，新机器拉到之后就能照着装。
   */
  async exportPlugins() {
    const manifest = await collectManifest(this.home)
    const dir = pluginDataDir(this.home)
    await mkdir(dir, { recursive: true, mode: 0o700 })
    await writeJsonFile(join(dir, MANIFEST_NAME), manifest, { mode: 0o600 })
    const summary = summarizeManifest(manifest)
    return {
      path: join(dir, MANIFEST_NAME),
      profiles: manifest.profiles.map((profile) => profile.profile),
      ...summary,
      manifest,
    }
  }

  /** 读本机（或仓库里拉回来的）清单；没有就返回 undefined。 */
  async readPluginManifest() {
    try {
      const text = await readFile(join(pluginDataDir(this.home), MANIFEST_NAME), 'utf8')
      const parsed = JSON.parse(text)
      return parsed !== null && typeof parsed === 'object' ? parsed : undefined
    } catch {
      return undefined
    }
  }

  /** 装回插件前的预览：会装什么、哪些装不了。 */
  async previewPlugins() {
    const manifest = await this.readPluginManifest()
    if (manifest === undefined) {
      return {
        available: false,
        message: '还没有插件清单。先在配置好的老机器上点一次「导出插件清单」，备份到仓库后在新机器恢复。',
      }
    }
    const { name: profileName, dir } = this.profileInfo()
    const platform = await this.targetPlatform()
    const plan = planInstall(manifest, profileName, platform)
    const matched = plan[0]
    const installed = await hasInstalledDeps(dir)
    return {
      available: true,
      profile: profileName,
      platform,
      generatedAt: manifest.generatedAt,
      depsReady: installed,
      add: matched?.add ?? [],
      manual: matched?.manual ?? [],
      skippedPlatform: matched?.skippedPlatform ?? [],
      fromProfiles: matched?.fromProfiles,
      otherProfiles: manifest.profiles.map((profile) => profile.profile).filter((name) => name !== profileName),
      summary: summarizeManifest(manifest),
    }
  }

  /**
   * 装回插件。
   *
   * 一件重要的事：**装完之后不会自动重启 DSH**。插件代码是宿主进程里加载的，
   * 新装的包要重启才生效 —— 界面会把这句话说清楚，但不替用户重启（那会把
   * 正在跑的东西全打断）。
   */
  async installPlugins({ pnpmCommand } = {}) {
    const manifest = await this.readPluginManifest()
    if (manifest === undefined) {
      throw new PluginInstallError('还没有插件清单，先在老机器上导出并备份一次', { code: 'NO_MANIFEST' })
    }
    const { name: profileName, dir: profileDir } = this.profileInfo()
    const platform = await this.targetPlatform()
    const plan = planInstall(manifest, profileName, platform)
    const matched = plan[0]
    if (matched === undefined || (matched.add.length === 0 && matched.manual.length === 0)) {
      throw new PluginInstallError(`清单里没有 profile "${profileName}" 的插件记录`, { code: 'NO_PROFILE' })
    }

    const pnpm = await locatePnpm({
      dshInstallDir: process.env.DSH_INSTALL_DIR,
      configured: pnpmCommand,
      platform,
    })
    this.logger?.info?.(`cloud-sync: 用 ${pnpm.source} 的 pnpm 装 ${matched.add.length} 个插件`)
    const result = await installProfilePlugins({
      pnpm,
      profileDir,
      specs: matched.add,
      log: (line) => this.logger?.info?.(`cloud-sync: ${line}`),
    })

    const summary = {
      action: 'install-plugins',
      profile: profileName,
      fromProfiles: matched.fromProfiles,
      pnpm: pnpm.source,
      installed: result.installed,
      failed: result.failed,
      manual: matched.manual,
      skippedPlatform: matched.skippedPlatform ?? [],
      platform,
      warning: result.warning,
      restartRequired: result.installed.length > 0,
      at: new Date().toISOString(),
    }
    await this.store.writeLastSync({ ...summary, previous: await this.store.readLastSync() })
    this.emitChanged()
    return summary
  }

  // ---------------- 定时备份 ----------------

  /**
   * 启动定时备份。插件激活时调一次；之后 `save()` 改配置会就地重排。
   *
   * 定时**只做备份**（push），从不自动恢复：悄悄把人本机的配置覆盖掉是不可接受
   * 的，恢复永远得是用户明确按下的动作。
   */
  async startScheduler() {
    // 先把配置读进来：runner 的 `getSchedule` 是同步的，不能在定时器里 await。
    await this.load()
    if (this.scheduler !== undefined) {
      this.scheduler.arm()
      return
    }
    this.scheduler = new ScheduleRunner({
      getSchedule: () => this.config?.schedule ?? defaultSchedule(),
      run: async () => {
        const schedule = this.config?.schedule ?? defaultSchedule()
        if (schedule.mode === 'off') return
        this.logger?.info?.(`cloud-sync: 定时备份开始（${describeSchedule(schedule)}）`)
        try {
          await this.push({ auto: true })
          this.logger?.info?.('cloud-sync: 定时备份完成')
        } catch (error) {
          this.lastAutoResult = {
            ok: false,
            at: new Date().toISOString(),
            message: error instanceof Error ? error.message : String(error),
          }
          this.emitChanged()
          throw error
        }
      },
      logger: this.logger,
    })
    this.scheduler.arm()
  }

  /** 停止定时备份（插件卸载时调）。 */
  stopScheduler() {
    this.scheduler?.stop()
    this.scheduler = undefined
  }

  /** 下一次定时备份的时刻。 */
  nextRunAt() {
    return this.scheduler?.nextRunAt
  }

  /** 同一时间只允许一个同步跑，避免两个 push 抢同一个 ref。 */
  async exclusive(kind, run) {
    if (this.running !== undefined) {
      throw new Error(`已经有一个${this.running === 'push' ? '备份' : '恢复'}在进行中，请等它完成`)
    }
    this.running = kind
    try {
      return await run()
    } finally {
      this.running = undefined
      this.emitChanged()
    }
  }

  emitChanged() {
    try {
      this.ctx.emit('cloud-sync/changed')
    } catch {
      // 没人监听完全正常。
    }
  }

  /** 提交署名；没配 git 身份就用插件自己的。 */
  author() {
    return {
      name: process.env.GIT_AUTHOR_NAME ?? 'DSH Cloud Sync',
      email: process.env.GIT_AUTHOR_EMAIL ?? 'dsh-cloud-sync@users.noreply.github.com',
      date: new Date().toISOString(),
    }
  }
}

/**
 * 恢复后检查 profile 里指向本机的 `link:` 依赖。
 *
 * DSH 的 profile 把第三方插件记为 `"pkg": "link:/abs/path"`。跨机器恢复时，
 * 这个路径在新机器上通常不存在 —— 不提示的话，用户只会看到「插件装不上」。
 * 这里只检查、不改写：哪个插件该装在哪，是用户自己的决定。
 */
async function checkLinkedDeps(home) {
  const warnings = []
  const profilesDir = join(home, 'profiles')
  let profiles = []
  try {
    profiles = await readdir(profilesDir, { withFileTypes: true })
  } catch {
    return warnings
  }
  for (const profile of profiles) {
    if (!profile.isDirectory()) continue
    const manifest = join(profilesDir, profile.name, 'package.json')
    let parsed
    try {
      parsed = JSON.parse(await readFile(manifest, 'utf8'))
    } catch {
      continue
    }
    const deps = parsed?.dependencies ?? {}
    for (const [name, spec] of Object.entries(deps)) {
      if (typeof spec !== 'string' || !spec.startsWith('link:')) continue
      const target = spec.slice(5)
      const exists = await readFile(join(target, 'package.json'), 'utf8').then(() => true, () => false)
      if (!exists) warnings.push({ profile: profile.name, package: name, target })
    }
  }
  return warnings
}

/** 提交信息：带时间和数量，在 GitHub 上翻历史时一眼能看懂。 */
function defaultMessage(kind, count) {
  const stamp = new Date().toISOString().replace('T', ' ').slice(0, 16)
  if (kind === 'push') {
    return `dsh cloud sync: 备份配置（${count} 个文件）\n\n由 dsh-cloud-sync 于 ${stamp} 自动提交。`
  }
  return 'dsh cloud sync: 恢复配置'
}

/** 给浏览器的配置视图；`lastSync` 来自单独的文件。 */
export function publicConfig(config, lastSync = null) {
  return {
    transport: config.transport,
    repo: config.repo,
    remoteUrl: config.remoteUrl,
    branch: config.branch,
    path: config.path,
    include: config.include,
    extraPaths: config.extraPaths,
    schedule: config.schedule,
    lastSync,
  }
}
