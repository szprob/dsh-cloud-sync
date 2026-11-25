/**
 * 一个最小可用的 GitHub Git Data 客户端。
 *
 * 为什么走 Git Data API 而不是 git 命令：
 *  1. 不依赖本机装没装 git、也不用处理 ssh / 凭据助手；
 *  2. 一次同步是一个 commit —— 先建 blob、再建 tree、再建 commit、最后挪 ref，
 *     中途失败不会在仓库里留下半套文件；
 *  3. 只写指定的子目录（`base_tree` + 子路径条目），不会碰仓库里别的东西。
 *
 * API 文档：https://docs.github.com/rest/git
 */

import { localRelFor, repoPathFor } from './paths.js'

const API_ROOT = 'https://api.github.com'

/** GitHub 的 Markdown 渲染上限是 1MiB；配置文件更大说明选错了目录，直接跳过。 */
export const MAX_FILE_BYTES = 1024 * 1024

/** 一次 tree 请求最多 10 万个条目，这里保守得多：同步的是配置，不是代码仓库。 */
export const MAX_FILES = 2000

/** 把上游的 JSON 错误翻成能直接给人看的中文。 */
export class GitHubError extends Error {
  constructor(message, { status, code, detail } = {}) {
    super(message)
    this.name = 'GitHubError'
    this.status = status
    this.code = code
    this.detail = detail
  }
}

/** 常见状态码的说明；`hint` 是给用户下一步做什么。 */
function explain(status, detail) {
  if (status === 401) return { code: 'BAD_TOKEN', hint: 'token 无效或已过期，请重新填一个（fine-grained 需要 Contents: Read and write 权限）' }
  if (status === 403) return { code: 'FORBIDDEN', hint: 'token 没有这个仓库的写权限，检查仓库是否在 token 的授权范围内、Contents 权限是否为 Read and write' }
  if (status === 404) return { code: 'NOT_FOUND', hint: '仓库或分支不存在；私有仓库还要确认 token 已被授权访问它' }
  if (status === 409) return { code: 'EMPTY_REPO', hint: '仓库还是空的（没有任何提交），先随便建一个初始提交，或让插件替你建' }
  if (status === 422) return { code: 'INVALID', hint: '请求参数被 GitHub 拒绝' }
  if (status === 429 || status === 403) return { code: 'RATE_LIMIT', hint: '触发了 GitHub 限流，等几分钟再试' }
  return { code: 'HTTP_ERROR', hint: detail ?? '未知错误' }
}

function parseRepo(repo) {
  const clean = String(repo ?? '').trim().replace(/^https?:\/\/github\.com\//i, '').replace(/\.git$/i, '').replace(/^\/+|\/+$/g, '')
  const match = /^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)$/.exec(clean)
  if (match === null) throw new GitHubError(`仓库要写成 "owner/repo" 的形式，收到的是 "${repo}"`, { code: 'BAD_REPO' })
  return { owner: match[1], name: match[2], full: `${match[1]}/${match[2]}` }
}

export class GitHubClient {
  constructor({ token, repo, branch = 'main', fetchImpl = globalThis.fetch }) {
    this.token = token
    this.repo = parseRepo(repo)
    this.branch = branch
    this.fetch = fetchImpl
  }

  async request(method, path, body) {
    const url = path.startsWith('http') ? path : `${API_ROOT}${path}`
    let response
    try {
      response = await this.fetch(url, {
        method,
        headers: {
          accept: 'application/vnd.github+json',
          authorization: `Bearer ${this.token}`,
          'x-github-api-version': '2022-11-28',
          'user-agent': 'dsh-cloud-sync',
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      })
    } catch (error) {
      throw new GitHubError(`连不上 GitHub：${error instanceof Error ? error.message : String(error)}`, { code: 'NETWORK' })
    }
    const text = await response.text()
    let payload
    try {
      payload = text === '' ? undefined : JSON.parse(text)
    } catch {
      payload = undefined
    }
    if (!response.ok) {
      const { code, hint } = explain(response.status, payload?.message)
      throw new GitHubError(`GitHub ${response.status}：${payload?.message ?? '请求失败'}（${hint}）`, {
        status: response.status,
        code,
        detail: payload?.message,
      })
    }
    return payload
  }

  /** 校验 token 与仓库权限；返回仓库信息和默认分支。 */
  async inspect() {
    const repoInfo = await this.request('GET', `/repos/${this.repo.full}`)
    return {
      full: this.repo.full,
      private: repoInfo.private === true,
      defaultBranch: repoInfo.default_branch ?? 'main',
      htmlUrl: repoInfo.html_url,
      permissions: repoInfo.permissions ?? {},
      empty: repoInfo.size === 0,
    }
  }

  /** 当前分支的 head commit；仓库为空时返回 undefined。 */
  async head() {
    try {
      const ref = await this.request('GET', `/repos/${this.repo.full}/git/ref/heads/${encodeURIComponent(this.branch)}`)
      return ref.object?.sha
    } catch (error) {
      if (error instanceof GitHubError && (error.code === 'NOT_FOUND' || error.status === 409)) return undefined
      throw error
    }
  }

  /** 读指定 commit 的完整文件列表（路径 -> blob sha），不取内容。 */
  async listTree(commitSha) {
    const commit = await this.request('GET', `/repos/${this.repo.full}/git/commits/${commitSha}`)
    const treeSha = commit.tree?.sha
    if (treeSha === undefined) throw new GitHubError('读不到这个提交的 tree', { code: 'BAD_TREE' })
    const tree = await this.request('GET', `/repos/${this.repo.full}/git/trees/${treeSha}?recursive=1`)
    const files = new Map()
    for (const entry of tree.tree ?? []) {
      if (entry.type === 'blob') files.set(entry.path, entry.sha)
    }
    return { commitSha, treeSha, files, truncated: tree.truncated === true }
  }

  /** 按 sha 取文件内容（base64 解出来是原始字节）。 */
  async readBlob(sha) {
    const blob = await this.request('GET', `/repos/${this.repo.full}/git/blobs/${sha}`)
    if (blob.encoding === 'base64') return Buffer.from(blob.content ?? '', 'base64')
    return Buffer.from(blob.content ?? '', 'utf8')
  }

  async createBlob(buffer) {
    const blob = await this.request('POST', `/repos/${this.repo.full}/git/blobs`, {
      content: buffer.toString('base64'),
      encoding: 'base64',
    })
    return blob.sha
  }

  /**
   * 写一批文件。
   *
   * `baseTree` 为 undefined 时建一棵全新的树（仓库还没有提交时用）。
   * `remove` 里的路径会从树里删掉（`sha: null`）。
   */
  // ---- 与 GitTransport 共用的接口（service 只依赖这三个方法）----

  /** 同步目录下现有的文件：相对路径 -> blob sha。 */
  async listScoped(configPath) {
    const head = await this.head()
    const scoped = new Map()
    if (head === undefined) return { commit: undefined, files: scoped }
    const tree = await this.listTree(head)
    for (const [path, sha] of tree.files) {
      const rel = localRelFor(configPath, path)
      if (rel === null || rel === '') continue
      scoped.set(rel, sha)
    }
    return { commit: head, files: scoped, truncated: tree.truncated === true }
  }

  /** 写入 / 删除一批文件并提交，返回新 commit sha；无变化时 undefined。 */
  async commitFiles({ configPath, files, remove, message, author }) {
    const entries = []
    for (const file of files) entries.push([repoPathFor(configPath, file.rel), await this.createBlob(file.buffer)])
    const head = await this.head()
    const baseTree = head === undefined ? undefined : (await this.listTree(head)).treeSha
    const removePaths = remove.map((rel) => repoPathFor(configPath, rel))
    if (entries.length === 0 && removePaths.length === 0) return undefined
    return this.commit({ baseTree, baseCommit: head, entries, remove: removePaths, message, author })
  }

  /** 读出同步目录下的全部文件（pull 用）。 */
  async readScoped(configPath) {
    const head = await this.head()
    if (head === undefined) return { commit: undefined, files: [] }
    const tree = await this.listTree(head)
    if (tree.truncated) throw new GitHubError('仓库文件太多，GitHub 返回的文件列表被截断；请检查仓库内目录设置', { code: 'TREE_TRUNCATED' })
    const files = []
    for (const [path, sha] of tree.files) {
      const rel = localRelFor(configPath, path)
      if (rel === null || rel === '') continue
      files.push({ rel, buffer: await this.readBlob(sha) })
    }
    return { commit: head, files }
  }

  async commit({ baseTree, baseCommit, entries, remove, message, author }) {
    const tree = []
    for (const [path, sha] of entries) tree.push({ path, mode: '100644', type: 'blob', sha })
    for (const path of remove) tree.push({ path, mode: '100644', type: 'blob', sha: null })
    const treeResult = await this.request('POST', `/repos/${this.repo.full}/git/trees`, {
      ...(baseTree === undefined ? {} : { base_tree: baseTree }),
      tree,
    })
    const commitBody = { message, tree: treeResult.sha, ...(baseCommit === undefined ? {} : { parents: [baseCommit] }) }
    if (author !== undefined) commitBody.author = author
    const commit = await this.request('POST', `/repos/${this.repo.full}/git/commits`, commitBody)
    if (baseCommit === undefined) {
      await this.request('POST', `/repos/${this.repo.full}/git/refs`, { ref: `refs/heads/${this.branch}`, sha: commit.sha })
    } else {
      await this.request('PATCH', `/repos/${this.repo.full}/git/refs/heads/${encodeURIComponent(this.branch)}`, {
        sha: commit.sha,
        force: false,
      })
    }
    return commit.sha
  }
}
