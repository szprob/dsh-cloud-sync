/**
 * 插件的持久化配置。
 *
 * `config.json` 只放非敏感配置；token 走 DSH 的凭据记录（`ctx.credentials`），
 * 只有凭据服务缺席时才退回 `token.json`（0600）。配置里不该出现密钥。
 */

import { join } from 'node:path'
import { rm } from 'node:fs/promises'
import { readJsonFile, pluginDataDir, writeJsonFile } from './paths.js'
import { defaultSchedule, normalizeSchedule } from './schedule.js'

/** 配置版本；将来结构变了靠它迁移。 */
export const CONFIG_VERSION = 1

/**
 * 默认同步哪些类别。密钥默认关 —— 推到公开仓库会泄露，必须用户自己开。
 */
export const DEFAULT_INCLUDE = {
  core: true,
  state: true,
  secrets: false,
}

/** 全量默认配置。 */
export function defaultConfig() {
  return {
    version: CONFIG_VERSION,
    /** `api` 走 GitHub REST（要 token）；`git` 走本机 git 命令（用 SSH key）。 */
    transport: 'api',
    repo: '',
    /** 仅 transport=git 时使用；留空则从 repo 推出 git@github.com:owner/repo.git。 */
    remoteUrl: '',
    branch: 'main',
    path: 'dsh',
    include: { ...DEFAULT_INCLUDE },
    extraPaths: [],
    /** 定时备份：默认关闭。 */
    schedule: defaultSchedule(),
  }
}

/** 仓库内目录：去掉首尾斜杠、折叠多余斜杠；空串表示仓库根。 */
export function normalizeRepoPath(value) {
  const trimmed = String(value ?? '')
    .trim()
    .replace(/^\/+|\/+$/g, '')
    .replace(/\/{2,}/g, '/')
  if (trimmed === '' || trimmed === '.') return ''
  const segments = trimmed.split('/')
  if (segments.some((segment) => segment === '..' || segment === '' || segment === '.')) {
    throw new Error('仓库内目录不能包含 ".." 或空段')
  }
  return trimmed
}

/** 把任意读到的对象收敛成一份完整配置：缺字段补默认，类型不对就丢掉。 */
export function normalizeConfig(raw) {
  const base = defaultConfig()
  if (raw === null || raw === undefined) return base
  const include = { ...DEFAULT_INCLUDE }
  if (raw.include !== null && typeof raw.include === 'object' && !Array.isArray(raw.include)) {
    for (const key of Object.keys(DEFAULT_INCLUDE)) {
      if (typeof raw.include[key] === 'boolean') include[key] = raw.include[key]
    }
  }
  return {
    version: CONFIG_VERSION,
    transport: raw.transport === 'git' ? 'git' : 'api',
    repo: typeof raw.repo === 'string' ? raw.repo.trim() : base.repo,
    remoteUrl: typeof raw.remoteUrl === 'string' ? raw.remoteUrl.trim() : '',
    branch: typeof raw.branch === 'string' && raw.branch.trim() !== '' ? raw.branch.trim() : base.branch,
    path: normalizeRepoPath(typeof raw.path === 'string' ? raw.path : base.path),
    include,
    extraPaths: Array.isArray(raw.extraPaths)
      ? raw.extraPaths
          .filter((value) => typeof value === 'string' && value.trim() !== '')
          .map((value) => value.trim())
      : [],
    schedule: normalizeSchedule(raw.schedule),
  }
}

/** 配置文件的读写。 */
export class ConfigStore {
  constructor(home) {
    this.home = home
    this.dir = pluginDataDir(home)
    this.file = join(this.dir, 'config.json')
    this.tokenFile = join(this.dir, 'token.json')
    this.lastSyncFile = join(this.dir, 'last-sync.json')
    this.backupRoot = join(this.dir, 'backups')
  }

  async read() {
    return normalizeConfig(await readJsonFile(this.file))
  }

  async write(config) {
    const normalized = normalizeConfig(config)
    await writeJsonFile(this.file, normalized, { mode: 0o600 })
    return normalized
  }

  /**
   * 最近一次同步摘要。
   *
   * 刻意**不**放进 `config.json`：那份文件本身要参与同步，而每次同步都会更新
   * 摘要 —— 写进配置就会让配置文件每次都变，于是每次 push 都产生新提交（真实的
   * bug，冒烟测试抓不到，端到端一跑就露）。单独放一个文件，且不参与同步。
   */
  async readLastSync() {
    const raw = await readJsonFile(this.lastSyncFile)
    return raw !== undefined && typeof raw === 'object' ? raw : null
  }

  async writeLastSync(summary) {
    await writeJsonFile(this.lastSyncFile, summary, { mode: 0o600 })
    return summary
  }

  /** 退回文件存 token 时的读写（凭据服务缺席的情况）。 */
  async readFallbackToken() {
    const raw = await readJsonFile(this.tokenFile)
    return typeof raw?.token === 'string' && raw.token !== '' ? raw.token : undefined
  }

  async writeFallbackToken(token) {
    await writeJsonFile(this.tokenFile, { token }, { mode: 0o600 })
  }

  async clearFallbackToken() {
    await rm(this.tokenFile, { force: true })
  }
}
