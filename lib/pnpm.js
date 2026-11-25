/**
 * 用 DSH 自带的 pnpm 装插件。
 *
 * 为什么不 shell 出去让用户自己跑：新机器上 `pnpm` 多半不在 PATH 里（DSH 桌面端
 * 自带一份，npm CLI 版靠 corepack），而且 profile 的 `pnpm-workspace.yaml` 里有
 * `nodeLinker: hoisted` 这种只有在这份配置下才对的设置 —— 换个工作目录跑就装错。
 * 所以固定用运行中 DSH 的那一份，`cwd` 固定为 profile 目录。
 *
 * 定位顺序：
 *  1. 桌面端：`<app>/Contents/Resources/runtime/primary-runtime/dependencies/pnpm`
 *  2. 复用 `plugin-manager` 的 `pnpmCommand`（如果宿主配了）
 *  3. PATH 上的 `pnpm`
 */

import { existsSync } from 'node:fs'
import { readdir, stat } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const run = promisify(execFile)

/** 一次安装的超时：插件多、网慢时确实要几分钟。 */
const INSTALL_TIMEOUT_MS = 10 * 60_000

/** 装插件的失败。 */
export class PluginInstallError extends Error {
  constructor(message, { code, output } = {}) {
    super(message)
    this.name = 'PluginInstallError'
    this.code = code
    this.output = output
  }
}

/**
 * 找到可用的 pnpm。
 *
 * @param options.dshInstallDir - 运行中的 DSH 包目录（`$DSH_INSTALL_DIR`）。
 * @returns `{ command, args, source }`：`args` 是 pnpm 之前要带的前缀参数
 *   （桌面端要用 node 跑 `pnpm.cjs`）。
 */
export async function locatePnpm({ dshInstallDir, configured } = {}) {
  // 1) 桌面端自带的那份：最可靠，版本和宿主对齐。
  if (typeof dshInstallDir === 'string' && dshInstallDir !== '') {
    // $DSH_INSTALL_DIR 是 .../app.asar/dsh/node_modules/@deepseek-ai/dsh
    // 桌面端的 runtime 在 .../Contents/Resources/runtime/primary-runtime/dependencies
    let cursor = dshInstallDir
    for (let depth = 0; depth < 8; depth += 1) {
      const resources = dirname(cursor)
      const candidate = join(resources, 'runtime', 'primary-runtime', 'dependencies')
      const pnpmBin = join(candidate, 'pnpm', 'bin', 'pnpm.cjs')
      const nodeBin = join(candidate, 'node', 'bin', 'node')
      if (existsSync(pnpmBin) && existsSync(nodeBin)) {
        return { command: nodeBin, args: [pnpmBin], source: 'bundled' }
      }
      const next = dirname(cursor)
      if (next === cursor) break
      cursor = next
    }
  }

  // 2) 宿主配置里指定的命令（plugin-manager 的 pnpmCommand 也是这个用法）。
  if (typeof configured === 'string' && configured.trim() !== '') {
    return { command: configured.trim(), args: [], source: 'configured' }
  }

  // 3) PATH 上的 pnpm。
  try {
    await run('pnpm', ['--version'], { timeout: 10_000 })
    return { command: 'pnpm', args: [], source: 'path' }
  } catch {
    // 继续往下抛更清楚的错。
  }

  throw new PluginInstallError(
    '找不到 pnpm。桌面端通常自带一份；命令行版请先 `npm i -g pnpm`，或在 profile 的 plugin-manager 里配 pnpmCommand',
    { code: 'NO_PNPM' },
  )
}

/** 把 pnpm 的输出裁到末尾若干行，报错时够看就行。 */
function tail(text, lines = 20) {
  const all = String(text ?? '').split('\n').filter((line) => line.trim() !== '')
  if (all.length <= lines) return all.join('\n')
  return `…\n${all.slice(-lines).join('\n')}`
}

/** 用已知的 pnpm 位置对某个 profile 执行一次安装。 */
async function pnpmInstall(pnpm, profileDir, args) {
  try {
    const result = await run(pnpm.command, [...pnpm.args, ...args], {
      cwd: profileDir,
      timeout: INSTALL_TIMEOUT_MS,
      maxBuffer: 16 * 1024 * 1024,
      env: {
        ...process.env,
        // 别让 pnpm 在等交互确认时把进程吊死。
        CI: '1',
        NO_COLOR: '1',
      },
    })
    return { code: 0, stdout: result.stdout, stderr: result.stderr }
  } catch (error) {
    return {
      code: typeof error?.code === 'number' ? error.code : 1,
      stdout: error?.stdout ?? '',
      stderr: error?.stderr ?? (error instanceof Error ? error.message : String(error)),
      timedOut: error?.killed === true,
    }
  }
}

/**
 * 按清单装回一个 profile 的全部插件。
 *
 * 先 `add` 每条 spec（一条一条加，这样某一项失败时其余的还能装进去，失败项也
 * 报得出名字），最后跑一次 `install` 收尾，确保 `pnpm-lock.yaml` 与
 * `node_modules` 一致。
 *
 * @returns `{ installed, failed, output }`
 */
export async function installProfilePlugins({ pnpm, profileDir, specs, log = () => {} }) {
  const installed = []
  const failed = []
  const outputs = []

  if (specs.length === 0) {
    return { installed, failed, output: '没有需要安装的插件' }
  }

  for (const spec of specs) {
    log(`安装 ${spec}`)
    const result = await pnpmInstall(pnpm, profileDir, ['add', spec, '--save-exact'])
    outputs.push(`$ pnpm add ${spec}\n${tail(result.stderr || result.stdout, 8)}`)
    if (result.code === 0) installed.push(spec)
    else failed.push({ spec, reason: tail(result.stderr || result.stdout, 12) })
  }

  // 收尾：把依赖树对齐，顺带把 peer 依赖拉齐。
  if (installed.length > 0) {
    const result = await pnpmInstall(pnpm, profileDir, ['install'])
    outputs.push(`$ pnpm install\n${tail(result.stderr || result.stdout, 12)}`)
    if (result.code !== 0) {
      return {
        installed,
        failed,
        output: outputs.join('\n\n'),
        warning: `依赖已添加，但收尾的 pnpm install 失败：${tail(result.stderr, 8)}`,
      }
    }
  }

  return { installed, failed, output: outputs.join('\n\n') }
}

/** profile 目录里有没有装好的依赖（判断要不要提示先安装）。 */
export async function hasInstalledDeps(profileDir) {
  try {
    const info = await stat(join(profileDir, 'node_modules'))
    if (!info.isDirectory()) return false
    const entries = await readdir(join(profileDir, 'node_modules'))
    return entries.some((name) => !name.startsWith('.'))
  } catch {
    return false
  }
}
