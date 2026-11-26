/**
 * 插件清单：把 profile 里「装了什么」变成一份可以带到别的机器上的描述。
 *
 * 为什么不同步 `node_modules`：几百 MB、含平台相关的二进制、编译产物跨机器
 * 不通用。真正要带走的是**装什么**，不是装好的东西。
 *
 * 每条依赖收敛成三种形态之一：
 *
 *  - `registry`   —— 直接写名字和版本，新机器 `pnpm add name@version`
 *  - `git`        —— 从包的 `repository` 字段反推出 `github:owner/repo#path:/sub`
 *  - `unresolvable` —— 反推不出来（纯本地包、没有 repository 字段），列出来让人手工装
 *
 * `link:` 依赖是重点：它指向本机路径，直接抄到新机器只会装出一个 0.0.0 的空包
 * （pnpm 只警告一句「non-existent directory」），不报错但插件是坏的。
 */

import { readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { detectPlatforms, supportsPlatform, applyOverride, currentPlatform, readOverrides } from './platform.js'

/** DSH 自带的官方包：新机器一定有，不用记进清单。 */
const OFFICIAL_SCOPE = '@deepseek-ai/'

/** 清单文件名，放在 `cloud-sync/` 下（这个目录会同步）。 */
export const MANIFEST_NAME = 'plugins.json'

/** 从 `git+https://github.com/o/r.git`、`git@github.com:o/r.git` 这类 URL 里取 `owner/repo`。 */
export function parseRepositoryUrl(url) {
  if (typeof url !== 'string' || url.trim() === '') return undefined
  const clean = url.trim().replace(/^git\+/, '').replace(/\.git$/i, '')
  const https = /^https?:\/\/[^/]+\/([^/]+\/[^/]+)$/.exec(clean)
  if (https !== null) return https[1]
  const ssh = /^git@[^:]+:(.+)$/.exec(clean)
  if (ssh !== null) return ssh[1]
  const shorthand = /^github:([^/#]+(?:\/[^/#]+)?)$/.exec(clean)
  if (shorthand !== null) return shorthand[1]
  return undefined
}

/**
 * 读一个已安装包的 manifest；失败返回 undefined。
 *
 * `link:` 依赖在 `node_modules` 里是符号链接，直接读到的是源码目录 —— 这正是
 * 我们要的（仓库里有完整的 `package.json`）。
 */
async function readInstalledManifest(profileDir, name) {
  try {
    const text = await readFile(join(profileDir, 'node_modules', name, 'package.json'), 'utf8')
    const parsed = JSON.parse(text)
    return parsed !== null && typeof parsed === 'object' ? parsed : undefined
  } catch {
    return undefined
  }
}

/**
 * 把一条依赖描述成可安装的 spec。
 *
 * @param name - 包名。
 * @param recorded - profile `package.json` 里记录的值。
 * @param manifest - 已安装包的 manifest（可能读不到）。
 * @returns 一条清单条目。
 */
export function describeDependency(name, recorded, manifest, options = {}) {
  const version = typeof manifest?.version === 'string' ? manifest.version : undefined
  /** 平台信息由调用方（collectProfile）探测后传入，单独测试时可省略。 */
  const platformInfo = options.platform
  /** 只有探测到了才写 platforms 字段，老清单条目（没有该字段）继续按通用处理。 */
  const platformFields = platformInfo?.platforms !== undefined
    ? { platforms: platformInfo.platforms, platformSource: platformInfo.source }
    : {}

  /**
   * registry 版本：**钉死实际装到的版本**，而不是照抄 `^4.18.7` 这种范围。
   *
   * 新机器照范围装会拿到当时的最新版，可能和这台机器跑的不是同一个东西 ——
   * 一个插件的破坏性更新就能让恢复出来的环境起不来。范围只在读不到已安装
   * manifest 时才退回使用。
   */
  if (!/^link:|^file:/.test(recorded)) {
    /**
     * `recorded` 可能是 `^4.18.7`、`1.27.1`，也可能是 `npm:other@1.0.0` 这种别名。
     *
     * 只有「纯版本/范围」才需要补上包名去拼 spec；别名和 `workspace:` 这类
     * 已经自带名字的写法必须原样保留 —— 拼成 `name@npm:other@1.0.0` 是废的。
     */
    const isPlainRange = !/^[a-z][a-z0-9+.-]*:/i.test(recorded) || /^workspace:/i.test(recorded)
    if (!isPlainRange) {
      return { name, spec: recorded, kind: 'registry', version, recorded, ...platformFields }
    }
    // 读得到已装版本就钉死它；读不到才退回记录里的范围（去掉 ^ / ~ 让语法干净）。
    const spec = version !== undefined ? `${name}@${version}` : `${name}@${recorded.replace(/^[\^~]/, '')}`
    return { name, spec, kind: 'registry', version, recorded, ...platformFields }
  }

  // link: / file: —— 本机路径，必须换成能跨机器用的地址。
  const repository = manifest?.repository
  const url = typeof repository === 'string' ? repository : repository?.url
  const ownerRepo = parseRepositoryUrl(url)
  if (ownerRepo === undefined) {
    return {
      name,
      kind: 'unresolvable',
      version,
      localPath: recorded.replace(/^(link:|file:)/, ''),
      reason: '包没有 repository 字段，无法推出可安装的地址',
      ...platformFields,
    }
  }
  // monorepo 里子包要带 #path：`repository.directory` 就是子目录。
  const directory = typeof repository === 'object' && typeof repository?.directory === 'string'
    ? repository.directory.replace(/^\.?\/+|\/+$/g, '')
    : ''
  const spec = directory === ''
    ? `github:${ownerRepo}`
    : `github:${ownerRepo}#path:/${directory}`
  return { name, spec, kind: 'git', version, repository: `https://github.com/${ownerRepo}`, ...platformFields }
}

/** 读一个 profile 的依赖清单。 */
export async function collectProfile(profileDir, profileName, overrides = {}) {
  let manifest
  try {
    manifest = JSON.parse(await readFile(join(profileDir, 'package.json'), 'utf8'))
  } catch {
    return undefined
  }
  const dependencies = manifest?.dependencies
  if (dependencies === null || typeof dependencies !== 'object') {
    return { profile: profileName, bundles: bundleListOf(manifest), plugins: [] }
  }
  const plugins = []
  for (const [name, recorded] of Object.entries(dependencies)) {
    if (typeof recorded !== 'string') continue
    // 官方包由 DSH 自带，记进去反而会在新机器上装出第二份。
    if (name.startsWith(OFFICIAL_SCOPE)) continue
    const installed = await readInstalledManifest(profileDir, name)
    // 自动探测平台，再叠加本机手动覆盖（覆盖文件每机独立，不进同步）。
    const detected = await detectPlatforms(join(profileDir, 'node_modules', name), name, installed)
    const platform = {
      platforms: applyOverride(detected.platforms, overrides, name),
      source: overrides[name] !== undefined ? 'override' : detected.source,
    }
    plugins.push(describeDependency(name, recorded, installed, { platform }))
  }
  plugins.sort((a, b) => a.name.localeCompare(b.name))
  return { profile: profileName, bundles: bundleListOf(manifest), plugins }
}

/** profile 声明的 bundle 列表（只保留第三方项）。 */
function bundleListOf(manifest) {
  const bundles = manifest?.dsh?.profile?.bundles
  if (!Array.isArray(bundles)) return []
  return bundles.filter((name) => typeof name === 'string' && !name.startsWith(OFFICIAL_SCOPE))
}

/**
 * 收集所有 profile 的清单。
 *
 * 多 profile 一起记：桌面端用 `desktop`，CLI 用 `web` / `headless`，各自装的东西
 * 可能不同，但同一台机器上通常是一致的。恢复时按 profile 名对应。
 */
export async function collectManifest(home) {
  const profilesDir = join(home, 'profiles')
  // 手动覆盖文件每机独立：导出时叠加它修正误判；它本身不随同步传播。
  const overrides = await readOverrides(join(home, 'cloud-sync', 'platform-overrides.json'))
  let entries = []
  try {
    entries = await readdir(profilesDir, { withFileTypes: true })
  } catch {
    return { version: 1, generatedAt: new Date().toISOString(), profiles: [] }
  }
  const profiles = []
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (!entry.isDirectory()) continue
    const collected = await collectProfile(join(profilesDir, entry.name), entry.name, overrides)
    if (collected !== undefined) profiles.push(collected)
  }
  return {
    version: 1,
    generatedAt: new Date().toISOString(),
    profiles,
  }
}

/** 清单里的包总数（去重后）。 */
export function summarizeManifest(manifest) {
  const names = new Set()
  const kinds = { registry: 0, git: 0, unresolvable: 0 }
  const platformCounts = { darwinOnly: 0, win32Only: 0, universal: 0 }
  for (const profile of manifest?.profiles ?? []) {
    for (const plugin of profile.plugins ?? []) {
      if (names.has(plugin.name)) continue
      names.add(plugin.name)
      if (plugin.kind in kinds) kinds[plugin.kind] += 1
      const platforms = Array.isArray(plugin.platforms) ? plugin.platforms : []
      if (platforms.length === 1 && platforms[0] === 'darwin') platformCounts.darwinOnly += 1
      else if (platforms.length === 1 && platforms[0] === 'win32') platformCounts.win32Only += 1
      else platformCounts.universal += 1
    }
  }
  return { total: names.size, ...kinds, ...platformCounts }
}

/**
 * 生成装回全部插件的命令序列。
 *
 * 按 profile 分组：每个 profile 的依赖写在它自己的 `package.json` 里，所以要
 * 分 profile 执行。`unresolvable` 的条目单独列出来，绝不硬装 —— 装个空包比
 * 不装更糟。
 *
 * @param manifest - `plugins.json` 的内容。
 * @param onlyProfile - 只处理这个 profile（恢复当前 profile 时用）。
 * @param platform - 目标平台；默认当前机器。不适配该平台的插件不进安装列表，
 *   但**仍留在清单里**（`skipped` 列出原因），这正是双向同步需要的：Mac 的清单
 *   带到 Windows 不装 Mac 插件，回 Mac 时同一个清单又能把它们装回来。
 */
export function planInstall(manifest, onlyProfile, platform = currentPlatform()) {
  const all = manifest?.profiles ?? []
  const profiles = onlyProfile === undefined ? all : all.filter((profile) => profile.profile === onlyProfile)
  const supported = (plugin) => supportsPlatform(plugin, platform)
  const skippedByPlatform = (plugins) => (plugins ?? [])
    .filter((plugin) => !supported(plugin))
    .map((plugin) => ({ name: plugin.name, platforms: plugin.platforms, reason: `不支持 ${platform}` }))

  /**
   * 当前 profile 不在清单里时，退回「所有 profile 的并集」。
   *
   * profile 名是固定的（desktop / web / headless / acp），但清单可能来自一台只
   * 用了 web 的机器 —— 那时新机器的 desktop 在清单里找不到。装回老机器上装过的
   * 那批插件，比什么都不装更接近用户的预期；装多了顶多是几个用不到的包。
   */
  if (profiles.length === 0 && onlyProfile !== undefined && all.length > 0) {
    const merged = new Map()
    for (const profile of all) {
      for (const plugin of profile.plugins ?? []) {
        if (!merged.has(plugin.name)) merged.set(plugin.name, plugin)
      }
    }
    const plugins = [...merged.values()]
    return [{
      profile: onlyProfile,
      fromProfiles: all.map((profile) => profile.profile),
      platform,
      add: plugins.filter((plugin) => plugin.kind !== 'unresolvable' && supported(plugin)).map((plugin) => plugin.spec),
      manual: plugins.filter((plugin) => plugin.kind === 'unresolvable' && supported(plugin)),
      skippedPlatform: skippedByPlatform(plugins),
    }]
  }

  return profiles.map((profile) => {
    const plugins = profile.plugins ?? []
    return {
      profile: profile.profile,
      platform,
      add: plugins.filter((plugin) => plugin.kind !== 'unresolvable' && supported(plugin)).map((plugin) => plugin.spec),
      manual: plugins.filter((plugin) => plugin.kind === 'unresolvable' && supported(plugin)),
      skippedPlatform: skippedByPlatform(plugins),
    }
  })
}
