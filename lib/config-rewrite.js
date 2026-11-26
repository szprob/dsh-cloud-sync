/**
 * 恢复时按目标平台改写配置：把不适用插件从 profile 配置里剔掉。
 *
 * 为什么需要：Mac 上备份的 `package.json`（bundles / dependencies）和
 * `cordis.patch.yml`（每个第三方插件一段顶层配置）里都带着 Mac 专属插件。
 * 原样恢复到 Windows，DSH 启动就会去加载 `dsh-mac-computer-use` 这类插件，
 * 轻则报错、重则起不来。反过来 Windows → Mac 也一样。
 *
 * 判断依据来自插件清单里的 `platforms` 字段（备份时自动探测写进去），
 * 叠加本机覆盖文件。清单里没有平台信息的老条目按通用处理，不改写。
 *
 * `cordis.patch.yml` 没有可用的 YAML 解析器（插件独立安装，不能依赖 DSH
 * 安装目录里的包），但它的结构是固定的**顶层数组**：每个条目以行首
 * `- id:` 开始。因此按行切块、整块保留/丢弃即可，不解析内部内容，
 * `!!js` 表达式、多行 config 都能原样保住。
 */

import { normalizePlatform } from './platform.js'

/** 从清单 + 目标平台算出不该装/不该出现在配置里的插件名集合。 */
export function unsupportedPluginNames(manifest, platform, overrides = {}) {
  const target = normalizePlatform(platform) ?? 'darwin'
  const names = new Set()
  for (const profile of manifest?.profiles ?? []) {
    for (const plugin of profile.plugins ?? []) {
      if (typeof plugin?.name !== 'string') continue
      let platforms = plugin.platforms
      // 本机覆盖优先（键是插件名，值可以是字符串或数组）。
      if (overrides[plugin.name] !== undefined) platforms = overrides[plugin.name]
      if (!Array.isArray(platforms) || platforms.length === 0) continue
      const normalized = platforms.map((item) => normalizePlatform(item)).filter(Boolean)
      if (normalized.length === 0) continue
      if (!normalized.includes(target)) names.add(plugin.name)
    }
  }
  return names
}

/** 把 JSON 里的依赖 / bundle 里属于 `names` 的插件去掉；没有变化时返回原字符串。 */
export function rewritePackageJson(text, names) {
  if (names.size === 0) return text
  let parsed
  try {
    parsed = JSON.parse(text)
  } catch {
    return text // 坏 JSON 不改写，交给后续读取报错，别偷偷修。
  }
  if (parsed === null || typeof parsed !== 'object') return text

  let changed = false
  for (const key of ['dependencies', 'devDependencies', 'optionalDependencies']) {
    const deps = parsed[key]
    if (deps === null || typeof deps !== 'object') continue
    for (const name of Object.keys(deps)) {
      if (names.has(name)) {
        delete deps[name]
        changed = true
      }
    }
  }

  const profile = parsed?.dsh?.profile
  if (profile !== undefined && profile !== null && typeof profile === 'object') {
    if (Array.isArray(profile.bundles)) {
      const before = profile.bundles.length
      profile.bundles = profile.bundles.filter((name) => !names.has(name))
      if (profile.bundles.length !== before) changed = true
    }
  }

  if (!changed) return text
  return `${JSON.stringify(parsed, null, 2)}\n`
}

/**
 * 从补丁文件里删掉引用了 `names` 中插件的顶层条目；没有变化时返回原字符串。
 *
 * 只认行首的 `- id:` / `- name:` 作为条目边界，条目内部任何缩进都不动。
 */
export function rewriteCordisPatch(text, names) {
  if (names.size === 0) return text
  const lines = text.split('\n')
  const blocks = []
  let header = []
  let current = null

  const startsItem = (line) => /^-\s+(id|name):/.test(line)
  for (const line of lines) {
    if (startsItem(line)) {
      if (current !== null) blocks.push(current)
      current = [line]
    } else if (current === null) {
      header.push(line) // 文件头注释 / 空行
    } else {
      current.push(line)
    }
  }
  if (current !== null) blocks.push(current)

  const keep = blocks.filter((block) => {
    const identifiers = []
    for (const line of block) {
      const match = /^\s*(?:-\s*)?(?:id|name):\s*['"]?([^'"\s]+)/.exec(line)
      if (match !== null) identifiers.push(match[1])
    }
    return !identifiers.some((id) => names.has(id))
  })
  if (keep.length === blocks.length) return text

  const dropped = blocks.length - keep.length
  const notice = `# dsh-cloud-sync: 按目标平台剔除了 ${dropped} 个不适用插件的配置段\n`
  return [...header, notice, ...keep.flat()].join('\n')
}

/**
 * 对一批从仓库读回来的文件做平台改写。
 *
 * @param files - `[{ rel, buffer }]`（`rel` 相对 ~/.dsh）。
 * @param manifest - `cloud-sync/plugins.json` 的内容。
 * @param platform - 目标平台。
 * @param overrides - 本机平台覆盖（可选）。
 * @returns `{ files, rewritten }`：`rewritten` 是被改写的文件相对路径列表。
 */
export function rewriteFilesForPlatform(files, manifest, platform, overrides = {}) {
  const names = unsupportedPluginNames(manifest, platform, overrides)
  const rewritten = []
  const result = files.map((item) => {
    if (!names.size) return item
    const isPackage = /(^|\/)package\.json$/.test(item.rel)
    const isPatch = /(^|\/)cordis\.patch\.yml$/.test(item.rel)
    if (!isPackage && !isPatch) return item
    const text = Buffer.isBuffer(item.buffer) ? item.buffer.toString('utf8') : String(item.buffer)
    const next = isPackage ? rewritePackageJson(text, names) : rewriteCordisPatch(text, names)
    if (next === text) return item
    rewritten.push(item.rel)
    return { ...item, buffer: Buffer.from(next, 'utf8') }
  })
  return { files: result, rewritten, dropped: [...names] }
}
