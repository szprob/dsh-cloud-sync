/**
 * git 命令行传输。
 *
 * 为什么要有第二条路：REST API 走 token，干净、无依赖，但受单个文件 100MB、
 * 一次 tree 10 万条、以及 fine-grained token 权限粒度的影响；而很多人本机早就
 * 配好了 SSH key，用 `git` 本身反而更省事。两种方式产出的仓库结构完全一致
 * （同一份目录布局），可以随时来回切。
 *
 * 实现在 `~/.dsh/cloud-sync/work` 维护一个「镜像工作区」：它就是仓库的一份
 * 浅克隆，push 时把本机文件铺进去、提交、推送；pull 时先 reset 到远端最新，
 * 再把文件拷回本机。工作区不参与同步（cloud-sync/work 在跳过名单里）。
 */

import { execFile } from 'node:child_process'
import { mkdir, readdir, readFile, rm, writeFile, copyFile, lstat } from 'node:fs/promises'
import { dirname, join, relative } from 'node:path'
import { promisify } from 'node:util'
import { gitBlobSha } from './paths.js'

const run = promisify(execFile)

/** git 失败时把 stderr 带出来，方便直接给用户看。 */
export class GitError extends Error {
  constructor(message, { stderr, code } = {}) {
    super(message)
    this.name = 'GitError'
    this.stderr = stderr
    this.code = code
  }
}

/** 从 owner/repo 推导 SSH 地址；也允许用户自己填完整 URL。 */
export function gitRemoteUrl(repo, explicit) {
  if (typeof explicit === 'string' && explicit.trim() !== '') return explicit.trim()
  const clean = String(repo ?? '').trim()
  if (/^git@|^https?:\/\//.test(clean)) return clean
  return `git@github.com:${clean}.git`
}

async function git(cwd, args, { allowFailure = false } = {}) {
  try {
    const result = await run('git', args, {
      cwd,
      maxBuffer: 32 * 1024 * 1024,
      env: {
        ...process.env,
        // 别让 git 弹交互式密码提示把进程挂住。
        GIT_TERMINAL_PROMPT: '0',
        GIT_SSH_COMMAND: process.env.GIT_SSH_COMMAND ?? 'ssh -o BatchMode=yes',
      },
    })
    return { stdout: result.stdout, stderr: result.stderr, code: 0 }
  } catch (error) {
    if (allowFailure) {
      return { stdout: error.stdout ?? '', stderr: error.stderr ?? '', code: error.code ?? 1 }
    }
    const detail = String(error.stderr ?? error.message ?? '').trim()
    throw new GitError(detail === '' ? `git ${args[0]} 失败` : detail, { stderr: detail, code: error.code })
  }
}

/** 一个浅克隆的镜像工作区。 */
export class GitTransport {
  constructor({ repo, branch = 'main', workDir, remoteUrl, log = () => {} }) {
    this.repo = repo
    this.branch = branch
    this.workDir = workDir
    this.remoteUrl = gitRemoteUrl(repo, remoteUrl)
    this.log = log
  }

  /** 确保工作区存在且远端已 fetch；返回远端分支是否存在。 */
  async prepare() {
    await mkdir(this.workDir, { recursive: true })
    const isRepo = await run('git', ['-C', this.workDir, 'rev-parse', '--git-dir'], {
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
    }).then(() => true, () => false)

    if (!isRepo) {
      // 空目录里 init，比 clone 更能应付「仓库还是空的」这种情况。
      for (const entry of await readdir(this.workDir)) {
        await rm(join(this.workDir, entry), { recursive: true, force: true })
      }
      await git(this.workDir, ['init', '--quiet'])
      await git(this.workDir, ['remote', 'add', 'origin', this.remoteUrl])
    } else {
      const current = await git(this.workDir, ['remote', 'get-url', 'origin'], { allowFailure: true })
      if (current.code !== 0 || current.stdout.trim() !== this.remoteUrl) {
        await git(this.workDir, ['remote', 'set-url', 'origin', this.remoteUrl])
      }
    }

    const fetched = await git(this.workDir, ['fetch', '--quiet', 'origin', this.branch], { allowFailure: true })
    const exists = fetched.code === 0
    this.branchExists = exists
    if (exists) {
      await git(this.workDir, ['checkout', '--quiet', '--force', '-B', this.branch, 'FETCH_HEAD'])
      await git(this.workDir, ['reset', '--quiet', '--hard', 'FETCH_HEAD'])
      await git(this.workDir, ['clean', '--quiet', '-ffd'])
    } else {
      /**
       * 分支还不存在。
       *
       * 必须先清空工作区再建孤儿分支：工作区是跨分支复用的镜像目录，上一次
       * 同步别的分支留下的文件会留在里面 —— 不清就会把「另一个分支的内容」
       * 当成本仓库的现状读出来（实测踩过：`head()` 还返回旧提交，
       * `readScoped()` 读出一堆陈年文件）。
       */
      await git(this.workDir, ['checkout', '--quiet', '--force', '-B', `orphan-${this.branch}`], { allowFailure: true })
      await git(this.workDir, ['rm', '-r', '--quiet', '--ignore-unmatch', '.'], { allowFailure: true })
      await git(this.workDir, ['clean', '--quiet', '-ffd'])
      await git(this.workDir, ['checkout', '--quiet', '--orphan', this.branch])
    }
    return { branchExists: exists }
  }

  /** 仓库里同步目录下的文件：`{ commit, files: Map<相对路径, blob sha> }`。 */
  async listScoped(configPath) {
    const result = new Map()
    const commit = await this.head()
    const root = configPath === '' ? this.workDir : join(this.workDir, configPath)
    const walk = async (dir, rel) => {
      let entries
      try {
        entries = await readdir(dir, { withFileTypes: true })
      } catch {
        return
      }
      for (const entry of entries) {
        if (entry.name === '.git') continue
        const abs = join(dir, entry.name)
        const nextRel = rel === '' ? entry.name : `${rel}/${entry.name}`
        if (entry.isSymbolicLink()) continue
        if (entry.isDirectory()) {
          await walk(abs, nextRel)
          continue
        }
        if (!entry.isFile()) continue
        const buffer = await readFile(abs)
        result.set(nextRel, gitBlobSha(buffer))
      }
    }
    await walk(root, '')
    return { commit, files: result }
  }

  /**
   * 写入一批文件并从同步目录里删掉 `remove` 里的文件，然后提交并推送。
   *
   * 返回新 commit sha；没有变化时返回 undefined。
   */
  async commitFiles({ configPath, files, remove, message, author }) {
    const scopedRoot = configPath === '' ? this.workDir : join(this.workDir, configPath)

    for (const file of files) {
      const abs = join(scopedRoot, file.rel)
      await mkdir(dirname(abs), { recursive: true })
      await writeFile(abs, file.buffer)
    }
    for (const rel of remove) {
      await rm(join(scopedRoot, rel), { force: true })
      // 顺手清掉空的父目录，别在仓库里留下一堆空目录。
      let parent = dirname(join(scopedRoot, rel))
      while (parent.startsWith(scopedRoot) && parent !== scopedRoot) {
        const items = await readdir(parent).catch(() => null)
        if (items === null || items.length > 0) break
        await rm(parent, { recursive: true, force: true })
        parent = dirname(parent)
      }
    }

    const pathspec = configPath === '' ? '.' : configPath
    await git(this.workDir, ['add', '--all', '--', pathspec])
    const status = await git(this.workDir, ['status', '--porcelain', '--', pathspec])
    if (status.stdout.trim() === '') return undefined

    await git(this.workDir, [
      '-c', `user.name=${author?.name ?? 'DSH Cloud Sync'}`,
      '-c', `user.email=${author?.email ?? 'dsh-cloud-sync@users.noreply.github.com'}`,
      'commit', '--quiet', '--message', message,
    ])
    let pushed = await git(this.workDir, ['push', '--quiet', 'origin', `HEAD:${this.branch}`], { allowFailure: true })
    if (pushed.code !== 0) {
      // 用 `-u` 在第一次推送时建立上游；失败再抛。
      pushed = await git(this.workDir, ['push', '--quiet', '--set-upstream', 'origin', this.branch])
    }
    const head = await git(this.workDir, ['rev-parse', 'HEAD'])
    return head.stdout.trim()
  }

  /** 把仓库里同步目录下的文件读出来：`{ commit, files: [{ rel, buffer }] }`。 */
  async readScoped(configPath) {
    const commit = await this.head()
    const files = []
    const root = configPath === '' ? this.workDir : join(this.workDir, configPath)
    const walk = async (dir, rel) => {
      let entries
      try {
        entries = await readdir(dir, { withFileTypes: true })
      } catch {
        return
      }
      for (const entry of entries) {
        if (entry.name === '.git') continue
        const abs = join(dir, entry.name)
        const nextRel = rel === '' ? entry.name : `${rel}/${entry.name}`
        if (entry.isSymbolicLink()) continue
        if (entry.isDirectory()) {
          await walk(abs, nextRel)
          continue
        }
        if (!entry.isFile()) continue
        files.push({ rel: nextRel, buffer: await readFile(abs) })
      }
    }
    await walk(root, '')
    return { commit, files }
  }

  /** 当前分支的提交；分支还不存在（或没有任何提交）时 undefined。 */
  async head() {
    if (this.branchExists === false) return undefined
    const result = await git(this.workDir, ['rev-parse', 'HEAD'], { allowFailure: true })
    if (result.code !== 0) return undefined
    const sha = result.stdout.trim()
    // 孤儿分支刚建、一次都没提交时，`rev-parse HEAD` 会失败；这里再兜一层。
    return /^[0-9a-f]{40}$/.test(sha) ? sha : undefined
  }
}
