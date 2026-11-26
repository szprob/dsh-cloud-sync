/**
 * 同步引擎：本机文件 ↔ 仓库里的一个子目录。
 *
 * 三条不变量：
 *  1. **只碰自己的目录** —— 仓库里 `<config.path>` 之外的任何文件都不读、不写、不删，
 *     把同步目录放进一个已有的仓库也不会误伤别的内容。
 *  2. **一次同步一个 commit** —— 由 github.js 的 tree+commit 实现，中途失败不留半套文件。
 *  3. **只同步 `~/.dsh` 下的文件** —— 不读 IDE 的私有存储，也不跟随符号链接。
 */

import { lstat, readdir, readFile, rm, mkdir, copyFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import {
  gitBlobSha,
  formatBytes,
  localRelFor,
  relativeToHome,
  repoPathFor,
  resolveUnder,
  writeFileAtomic,
} from './paths.js'

export { localRelFor, repoPathFor }
import { MAX_FILES, MAX_FILE_BYTES } from './github.js'

/**
 * 同步类别。每类的 `match` 判断 `~/.dsh` 下的相对路径是否属于它。
 *
 * 拆成三类而不是一个总开关，是因为风险不同：`core` 是配置，`state` 是应用状态
 * （定时任务、工作区列表），`secrets` 是密钥 —— 只有第三类推到公开仓库会出事，
 * 所以它单独可关，且默认关。
 */
export const CATEGORIES = {
  core: {
    match: (rel) =>
      rel === 'cordis.patch.yml' ||
      /^profiles\/[^/]+\/(cordis\.patch\.yml|cordis\.yml|package\.json|pnpm-workspace\.yaml|pnpm-lock\.yaml)$/.test(rel),
  },
  state: {
    match: (rel) =>
      /^storages\/[^/]+\.json$/.test(rel) ||
      /^automation\/state\.json$/.test(rel) ||
      /^cloud-sync\/(config|plugins)\.json$/.test(rel) ||
      /^scripts\/[^/]+\.(mjs|js|sh)$/.test(rel),
  },
  secrets: {
    match: (rel) =>
      rel === '.env' ||
      rel === '.credentials.yaml' ||
      rel === 'cloud-sync/token.json' ||
      // 各插件写在 ~/.dsh 根下的登录态 / 账号池 / 签到记录（trae、qoder、workbuddy）。
      /^\.[A-Za-z0-9][A-Za-z0-9._-]*\.json$/.test(rel.replace(/^.*\//, '')) ||
      // workbuddy 的明文凭据仓库（每个账号一个文件，含 refreshToken）。
      rel === 'workbuddy-vault' || rel.startsWith('workbuddy-vault/'),
  },
}

/** 永远不同步的路径：会话记录、附件、缓存、日志、依赖、恢复备份。 */
const ALWAYS_SKIP = [
  'sessions/',
  'attachments/',
  'storages/session_projcache/',
  'dsh-runtimes/',
  'cloud-sync/backups/',
  // 平台覆盖是「本机修正」，每机独立，绝不跟着同步传播。
  'cloud-sync/platform-overrides.json',
  // git 传输的镜像工作区：它就是仓库本身的一份克隆，绝不能反过来再同步回去。
  'cloud-sync/work/',
  '.cache/',
  'skills/',
]

/** 要不要跳过这个文件路径。 */
export function skipped(rel) {
  if (rel === '') return true
  if (ALWAYS_SKIP.some((prefix) => rel === prefix.slice(0, -1) || rel.startsWith(prefix))) return true
  if (rel === 'node_modules' || rel.startsWith('node_modules/') || rel.includes('/node_modules/')) return true
  if (rel.endsWith('.log')) return true
  if (rel === '.DS_Store' || rel.endsWith('/.DS_Store')) return true
  return false
}

/** 要不要跳过这个目录（`rel` 不带结尾斜杠）。 */
function skipDir(rel) {
  if (rel === '') return false
  return skipped(`${rel}/`) || skipped(rel)
}

/** 这个路径属于哪一类；不属于任何一类返回 undefined。 */
export function categoryOf(rel) {
  for (const [name, def] of Object.entries(CATEGORIES)) {
    if (def.match(rel)) return name
  }
  return undefined
}

/**
 * 收集本机要同步的文件。
 *
 * 返回 `{ files, skipped, totalBytes }`，`files[i]` 是
 * `{ rel, abs, size, buffer, sha }`，`rel` 相对 `~/.dsh`。
 *
 * 只从已知的几个顶层目录递归（profiles / storages / automation / cloud-sync /
 * scripts），加上根下几个固定文件 —— 不整盘扫 `~/.dsh`，那会把附件和会话拖进来。
 */
export async function collectLocal({ home, include, extraPaths = [], log = () => {} }) {
  const files = []
  const skippedEntries = []
  const wanted = (rel) => {
    const category = categoryOf(rel)
    if (category === undefined) return false
    return include[category] !== false
  }

  /**
   * 递归收集。
   *
   * `force` 为真时绕过类别过滤 —— `extraPaths` 是用户显式点名的，不该再被
   * 「配置 / 状态 / 密钥」三类的规则挡住。
   */
  const visit = async (absDir, relDir, force = false) => {
    let entries
    try {
      entries = await readdir(absDir, { withFileTypes: true })
    } catch (error) {
      if (error?.code === 'ENOENT') return
      throw error
    }
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const rel = relDir === '' ? entry.name : `${relDir}/${entry.name}`
      const abs = join(absDir, entry.name)
      if (entry.isSymbolicLink()) {
        skippedEntries.push({ path: rel, reason: '符号链接（不跟随，避免把整个 git 仓库拖进来）' })
        continue
      }
      if (entry.isDirectory()) {
        if (skipDir(rel)) continue
        await visit(abs, rel, force)
        continue
      }
      if (!entry.isFile()) continue
      if (skipped(rel) || (!force && !wanted(rel))) continue
      files.push({ rel, abs })
    }
  }

  // 1) 已知的顶层目录。逐个尝试，不存在的直接跳过（新机器可能没有 automation）。
  for (const dir of ['profiles', 'storages', 'automation', 'cloud-sync', 'scripts', 'workbuddy-vault']) {
    await visit(join(home, dir), dir)
  }

  // 2) DSH 根下直接放着的文件：主补丁、.env、.credentials.yaml、顶层 `.<name>.json` 登录态。
  let rootEntries = []
  try {
    rootEntries = await readdir(home, { withFileTypes: true })
  } catch {
    rootEntries = []
  }
  for (const entry of rootEntries) {
    if (entry.isSymbolicLink() || !entry.isFile()) continue
    const rel = entry.name
    if (skipped(rel) || !wanted(rel)) continue
    if (!files.some((file) => file.rel === rel)) files.push({ rel, abs: join(home, rel) })
  }

  // 3) 用户额外指定的路径（文件或目录），按原样展开。
  for (const raw of extraPaths) {
    const abs = resolveUnder(home, raw)
    // 先判目录边界再碰文件系统：DSH 目录外的路径无论存不存在都不该被读。
    const rel = relativeToHome(home, abs)
    if (rel === null || rel === '') {
      skippedEntries.push({ path: raw, reason: '不在 DSH 数据目录（~/.dsh）下，只同步这个目录里的文件' })
      continue
    }
    let info
    try {
      info = await lstat(abs)
    } catch {
      skippedEntries.push({ path: raw, reason: '不存在' })
      continue
    }
    if (info.isSymbolicLink()) {
      skippedEntries.push({ path: raw, reason: '符号链接（不跟随）' })
      continue
    }
    if (info.isDirectory()) await visit(abs, rel, true)
    else if (!skipped(rel) && !files.some((file) => file.rel === rel)) files.push({ rel, abs })
  }

  // 4) 去重、读内容、过滤超大文件、算 git blob sha。
  const byRel = new Map()
  for (const file of files) if (!byRel.has(file.rel)) byRel.set(file.rel, file)
  const result = []
  let totalBytes = 0
  for (const [rel, file] of [...byRel].sort(([a], [b]) => a.localeCompare(b))) {
    let buffer
    try {
      buffer = await readFile(file.abs)
    } catch (error) {
      skippedEntries.push({ path: rel, reason: `读取失败（${error?.code ?? error}）` })
      continue
    }
    if (buffer.length > MAX_FILE_BYTES) {
      skippedEntries.push({ path: rel, reason: `超过单文件上限 ${formatBytes(MAX_FILE_BYTES)}` })
      continue
    }
    totalBytes += buffer.length
    result.push({ rel, abs: file.abs, size: buffer.length, buffer, sha: gitBlobSha(buffer) })
  }
  if (result.length > MAX_FILES) {
    throw new Error(`要同步的文件有 ${result.length} 个，超过上限 ${MAX_FILES}；请收窄同步范围`)
  }
  log(`本地共 ${result.length} 个文件，${formatBytes(totalBytes)}`)
  return { files: result, skipped: skippedEntries, totalBytes }
}

/**
 * 算出一次同步要做什么，不写任何东西。
 *
 * `remote` 是 `listTree()` 的结果；`undefined` 表示分支上还没有提交。
 */
export function planSync({ files, remote, configPath }) {
  const remoteInScope = new Map()
  if (remote !== undefined) {
    for (const [path, sha] of remote.files) {
      const rel = localRelFor(configPath, path)
      if (rel === null || rel === '') continue
      remoteInScope.set(rel, sha)
    }
  }
  const upload = []
  const unchanged = []
  const localRels = new Set()
  for (const file of files) {
    localRels.add(file.rel)
    if (remoteInScope.get(file.rel) === file.sha) unchanged.push(file)
    else upload.push(file)
  }
  const remove = [...remoteInScope.keys()].filter((rel) => !localRels.has(rel)).sort()
  return { upload, unchanged, remove, remoteCount: remoteInScope.size }
}

/** 把选中的文件推上去，返回新 commit sha；没有变化时返回 undefined。 */
export async function pushPlan({ client, plan, configPath, message, author }) {
  const entries = []
  for (const file of plan.upload) {
    const sha = await client.createBlob(file.buffer)
    entries.push([repoPathFor(configPath, file.rel), sha])
  }
  const remove = plan.remove.map((rel) => repoPathFor(configPath, rel))
  if (entries.length === 0 && remove.length === 0) return undefined
  const head = await client.head()
  const baseTree = head === undefined ? undefined : (await client.listTree(head)).treeSha
  return client.commit({ baseTree, baseCommit: head, entries, remove, message, author })
}

/**
 * 从仓库拉回本机。
 *
 * 入参 `files` 是已经读进内存的 `[{ rel, buffer }]`（相对 `~/.dsh`）。两条传输
 * 各自负责把字节读出来，这里只负责「写盘 + 备份」，所以 API 和 git 两条路径的
 * 落盘行为完全一致。
 *
 * 先整体校验、再逐个写：覆盖已有文件前把它复制进 `backupDir`；内容相同的
 * 文件跳过不写，免得改 mtime 触发宿主的文件监听（HMR）。
 */
export async function pullPlan({ files, home, backupDir, log = () => {} }) {
  const staged = []
  const skippedItems = []
  for (const item of files) {
    const abs = resolve(join(home, item.rel))
    if (relativeToHome(home, abs) === null || relativeToHome(home, abs) === '') {
      skippedItems.push({ path: item.rel, reason: '解析到 DSH 目录之外，已跳过' })
      continue
    }
    if (skipped(item.rel)) {
      skippedItems.push({ path: item.rel, reason: '属于不同步的路径' })
      continue
    }
    staged.push({ ...item, abs })
  }
  log(`准备写入 ${staged.length} 个文件`)

  const written = []
  const backedUp = []
  for (const item of staged) {
    try {
      const existing = await readFile(item.abs)
      if (existing.equals(item.buffer)) continue
      const backup = join(backupDir, item.rel)
      await mkdir(dirname(backup), { recursive: true, mode: 0o700 })
      await copyFile(item.abs, backup)
      backedUp.push(item.rel)
    } catch {
      // 目标不存在：没有要备份的。
    }
    await mkdir(dirname(item.abs), { recursive: true })
    await writeFileAtomic(item.abs, item.buffer, { mode: 0o600 })
    written.push(item.rel)
  }
  return { written, backedUp, skipped: skippedItems, staged: staged.length }
}

/** 建一份带时间戳的备份目录。 */
export async function makeBackupDir(backupRoot, now = new Date()) {
  const stamp = now.toISOString().replace(/[:.]/g, '-').replace('T', '_').slice(0, 19)
  const dir = join(backupRoot, stamp)
  await mkdir(dir, { recursive: true, mode: 0o700 })
  return dir
}

/** 只保留最近 `keep` 份备份，其余删掉。 */
export async function pruneBackups(backupRoot, keep = 10) {
  let items
  try {
    items = await readdir(backupRoot, { withFileTypes: true })
  } catch {
    return
  }
  const dirs = items
    .filter((item) => item.isDirectory())
    .map((item) => item.name)
    .sort()
  for (const name of dirs.slice(0, Math.max(0, dirs.length - keep))) {
    await rm(join(backupRoot, name), { recursive: true, force: true })
  }
}
