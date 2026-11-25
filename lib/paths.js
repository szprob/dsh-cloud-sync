/**
 * 路径与文件系统小工具。
 *
 * 这里刻意只用 `node:` 内置模块：插件是 `link:` 装进 profile 的，不保证能解析
 * DSH 安装目录里的 `@deepseek-ai/*` 包，所以不引入任何裸模块名。
 */

import { homedir } from 'node:os'
import { isAbsolute, join, resolve, sep } from 'node:path'
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'

/** DSH 数据根：`$DSH_HOME`，否则 `~/.dsh`。 */
export function resolveDshHome() {
  const fromEnv = process.env.DSH_HOME
  if (typeof fromEnv === 'string' && fromEnv.trim() !== '') return resolve(fromEnv.trim())
  return join(homedir(), '.dsh')
}

/** 本插件自己的数据目录（配置 + 最近一次同步的哈希 + 恢复前的备份）。 */
export function pluginDataDir(home = resolveDshHome()) {
  return join(home, 'cloud-sync')
}

/** 把用户给的相对路径解析到 DSH 根下；绝对路径原样返回。 */
export function resolveUnder(home, value) {
  return isAbsolute(value) ? resolve(value) : resolve(join(home, value))
}

/** 相对 DSH 根的正斜杠路径；不在根下时返回 null。 */
export function relativeToHome(home, absolute) {
  const root = resolve(home)
  const target = resolve(absolute)
  if (target === root) return ''
  const prefix = root.endsWith(sep) ? root : root + sep
  if (!target.startsWith(prefix)) return null
  return target.slice(prefix.length).split(sep).join('/')
}

/** 仓库内完整路径：`<configPath>/<rel>`。 */
export function repoPathFor(configPath, rel) {
  return configPath === '' ? rel : `${configPath}/${rel}`
}

/** 仓库路径去掉 `configPath` 前缀后的相对路径；不在范围内返回 null。 */
export function localRelFor(configPath, repoPath) {
  if (configPath === '') return repoPath
  const prefix = `${configPath}/`
  if (repoPath === configPath) return ''
  if (!repoPath.startsWith(prefix)) return null
  return repoPath.slice(prefix.length)
}

/** 原子写：先写同目录的临时文件再 rename，避免半截文件被 DSH 读到。 */
export async function writeFileAtomic(target, data, { mode = 0o600 } = {}) {
  await mkdir(join(target, '..'), { recursive: true, mode: 0o700 })
  const temp = `${target}.tmp-${process.pid}-${Date.now()}`
  try {
    await writeFile(temp, data, { mode })
    await rename(temp, target)
  } catch (error) {
    await rm(temp, { force: true })
    throw error
  }
}

/** 读 JSON；文件不存在或内容坏掉时返回 undefined（坏文件不会让插件起不来）。 */
export async function readJsonFile(file) {
  try {
    const text = await readFile(file, 'utf8')
    const value = JSON.parse(text)
    return value !== null && typeof value === 'object' ? value : undefined
  } catch {
    return undefined
  }
}

/** 写 JSON（缩进两格，便于人直接看和 git diff）。 */
export async function writeJsonFile(file, value, options) {
  await writeFileAtomic(file, `${JSON.stringify(value, null, 2)}\n`, options)
}

/** 文件是否存在（不跟随符号链接判断以外的语义）。 */
export async function pathExists(target) {
  try {
    await stat(target)
    return true
  } catch {
    return false
  }
}

/** git 的 blob 对象 id：`sha1("blob <字节数>\0" + 内容)`。 */
export function gitBlobSha(buffer) {
  return createHash('sha1').update(`blob ${buffer.length}\0`).update(buffer).digest('hex')
}

/** 给人看的字节数。 */
export function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`
}
