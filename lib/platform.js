/**
 * 平台识别与兼容性判断。
 *
 * 云同步在 Mac 和 Windows 之间搬配置，但第三方插件里有一部分是「只适配某个平台」
 * 的（典型如 dsh-mac-computer-use）。这类插件装到另一台机器上要么报错，要么加载
 * 一堆用不上的东西。本模块解决两件事：
 *
 *  1. 生成插件清单时，自动识别每个插件支持哪些平台，写进清单；
 *  2. 恢复时按目标平台判断哪些插件不适用，供安装过滤和配置改写使用。
 *
 * 自动识别分三层，按可靠度排序：
 *
 *  - `os` 字段：npm 官方约定，最权威；
 *  - 代码信号：macOS 专有系统路径 / `process.platform` 早退守卫、Windows 专有路径；
 *  - 名称模式：`dsh-mac-*` 这类明显的平台前缀。
 *
 * 三者都没有就认为是通用插件（darwin + win32 + linux）。识别结果可能出错，所以
 * 另有一份**每机独立、不随同步传播**的覆盖文件
 * `~/.dsh/cloud-sync/platform-overrides.json`，用来修正误判。
 *
 * 只依赖 `node:` 内置模块 —— 这个插件是 `link:` 装进 profile 的独立包，解析不到
 * DSH 安装目录里的第三方依赖。
 */

import { readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'

/** 本模块认识的平台家族。npm 的其他 os 值（freebsd、aix…）归一到 linux 一类。 */
export const KNOWN_PLATFORMS = ['darwin', 'win32', 'linux']

/** 全平台通用。 */
export function allPlatforms() {
  return [...KNOWN_PLATFORMS]
}

/** 当前机器所属平台（`process.platform` 已是 'darwin' / 'win32' / 'linux'）。 */
export function currentPlatform() {
  return KNOWN_PLATFORMS.includes(process.platform) ? process.platform : 'linux'
}

/** 归一化单个平台值；不认识的返回 undefined。 */
export function normalizePlatform(value) {
  if (typeof value !== 'string') return undefined
  const clean = value.trim().toLowerCase()
  if (clean === 'macos' || clean === 'mac' || clean === 'osx') return 'darwin'
  if (clean === 'windows') return 'win32'
  if (KNOWN_PLATFORMS.includes(clean)) return clean
  return undefined
}

/**
 * 归一化一组平台值。空数组 / 非数组 → 全平台。
 * 结果排序去重，保证清单稳定可 diff。
 */
export function normalizePlatforms(value) {
  if (!Array.isArray(value)) return allPlatforms()
  const set = new Set()
  for (const item of value) {
    const platform = normalizePlatform(item)
    if (platform !== undefined) set.add(platform)
  }
  if (set.size === 0) return allPlatforms()
  return KNOWN_PLATFORMS.filter((platform) => set.has(platform))
}

/** 某个插件条目是否支持目标平台。没有 platforms 字段的老清单条目视为通用。 */
export function supportsPlatform(entry, platform) {
  const target = normalizePlatform(platform) ?? currentPlatform()
  if (entry === null || typeof entry !== 'object') return true
  const platforms = entry.platforms
  if (!Array.isArray(platforms) || platforms.length === 0) return true
  return platforms.some((item) => normalizePlatform(item) === target)
}

/** 从 npm `os` 字段推导平台集合；处理 `!win32` 这类排除写法。 */
function platformsFromOsField(os) {
  if (!Array.isArray(os)) return undefined
  const exclude = new Set()
  const include = new Set()
  for (const item of os) {
    if (typeof item !== 'string') continue
    const clean = item.trim().toLowerCase()
    if (clean.startsWith('!')) {
      const negated = normalizePlatform(clean.slice(1))
      if (negated !== undefined) exclude.add(negated)
      continue
    }
    const platform = normalizePlatform(clean)
    if (platform !== undefined) include.add(platform)
  }
  if (include.size === 0 && exclude.size === 0) return undefined
  const result = include.size > 0
    ? [...include]
    : KNOWN_PLATFORMS.filter((platform) => !exclude.has(platform))
  return normalizePlatforms(result)
}

// 判定策略：**宁可漏判，不可误判**。误判会把跨平台插件在另一台机器上跳过，
// 直接破坏同步；漏判只是少过滤一个插件，还能靠覆盖文件修正。
//
// 实测教训：跨平台插件（trae / workbuddy）里到处都是 Windows 支持代码 ——
// `C:\...` 路径、powershell、HKEY 注册表、`process.platform !== 'win32'` 差异分支。
// 拿任何 Windows API 当信号都会把它们误判成 Windows-only。反过来 macOS 系统级
// 调用（osascript / screencapture / CGWindow / DARWIN_USER_TEMP_DIR）则是
// Mac 专属插件独有的，跨平台插件不含这些，所以只认这一类硬信号。
//
// Windows-only 插件只靠名称前缀识别（win-* / windows-*），代码层面不猜。
// 只扫代码文件，不扫 README / CHANGELOG。
const MAC_HARD = [
  /\/usr\/bin\/osascript\b/,
  /\/usr\/sbin\/screencapture\b/,
  /DARWIN_USER_TEMP_DIR/,
  /CGWindow(List|CreateImage)/,
  /ObjC\.bindFunction/,
]

/** 包名里的平台前缀。用词边界避免把 machine / match 之类算进去。 */
const MAC_NAME = /(^|[-_])mac(os)?([-_]|$)|(^|[-_])darwin([-_]|$)/i
const WIN_NAME = /(^|[-_])win(32|dows)?([-_]|$)/i

/**
 * 扫描已安装插件目录里的代码，统计平台信号。
 *
 * 只读少量小的文本文件，跳过 node_modules / bin 二进制，避免把整个依赖树翻一遍。
 */
async function scanCodeSignals(packageDir) {
  let macHard = 0
  const entries = await readdir(packageDir, { withFileTypes: true }).catch(() => [])
  // 只扫顶层 + 一层常见的源码目录；大插件（打包后的 lib）也覆盖到。
  const files = []
  for (const entry of entries) {
    if (!entry.isFile() && !entry.isDirectory()) continue
    if (['node_modules', 'bin', 'native', '.git'].includes(entry.name)) continue
    const abs = join(packageDir, entry.name)
    if (entry.isDirectory()) {
      const nested = await readdir(abs, { withFileTypes: true }).catch(() => [])
      for (const child of nested) {
        if (child.isFile()) files.push(join(abs, child.name))
      }
    } else {
      files.push(abs)
    }
  }
  for (const file of files) {
    if (!/\.(m?js|cjs|ts)$/i.test(file)) continue
    let text
    try {
      text = await readFile(file, 'utf8')
    } catch {
      continue
    }
    const sample = text.slice(0, 200 * 1024)
    for (const pattern of MAC_HARD) if (pattern.test(sample)) macHard += 1
  }
  return { macHard }
}

/**
 * 自动识别一个已安装插件支持的平台。
 *
 * @param packageDir - 插件源码目录（profile 的 node_modules/<name>）。
 * @param name - 包名。
 * @param manifest - 已安装的 package.json（已经读进来的对象）。
 * @returns `{ platforms, signals, source }`，`signals` 给人复核用。
 */
export async function detectPlatforms(packageDir, name, manifest) {
  // 本插件自己的源码里就有这些 macOS 正则字面量，跳过自身避免误判。
  if (name === 'dsh-cloud-sync') {
    return { platforms: allPlatforms(), signals: { self: true }, source: 'universal' }
  }
  const osField = platformsFromOsField(manifest?.os)
  if (osField !== undefined) {
    return { platforms: osField, signals: { os: manifest.os }, source: 'os-field' }
  }

  const signals = await scanCodeSignals(packageDir)
  const macName = MAC_NAME.test(name ?? '')
  const winName = WIN_NAME.test(name ?? '')

  // macOS 系统级 API 或 mac- 前缀 → Mac 专属。Windows-only 只认 win- 前缀。
  if (signals.macHard > 0 && !winName) return { platforms: ['darwin'], signals, source: 'signal' }
  if (macName && !winName) return { platforms: ['darwin'], signals, source: 'name' }
  if (winName && !macName) return { platforms: ['win32'], signals, source: 'name' }
  return { platforms: allPlatforms(), signals, source: 'universal' }
}

/**
 * 读取手动覆盖文件。不存在 / 坏掉都当作空，绝不让覆盖文件把插件清单搞崩。
 * 这个文件每机独立，云同步会跳过它（见 sync.js 的 ALWAYS_SKIP）。
 */
export async function readOverrides(file) {
  const raw = await readFile(file, 'utf8').then(
    (text) => JSON.parse(text),
    () => undefined,
  ).catch(() => undefined)
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return {}
  const overrides = {}
  for (const [name, value] of Object.entries(raw)) {
    if (typeof name !== 'string' || name === '') continue
    // `$platform` 是「强制目标平台」的特殊键，不是插件名，单独留给 targetPlatform 读。
    if (name === '$platform') {
      const forced = normalizePlatform(value)
      if (forced !== undefined) overrides.$platform = forced
      continue
    }
    const platforms = normalizePlatforms(value)
    overrides[name] = platforms
  }
  return overrides
}

/** 应用覆盖：返回合并了手动声明后的平台集合。 */
export function applyOverride(platforms, overrides, name) {
  const override = overrides?.[name]
  return override === undefined ? normalizePlatforms(platforms) : normalizePlatforms(override)
}
