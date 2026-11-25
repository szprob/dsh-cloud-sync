/**
 * 本地冒烟测试：不联网、不装 DSH，纯 node 跑。
 *
 * 覆盖三块最容易悄悄坏掉的东西：
 *  1. 同步计划的 diff 逻辑（上传 / 删除 / 未变）；
 *  2. 仓库内目录的隔离（只动子目录，别处一个字节都不碰）；
 *  3. git blob sha 的算法 —— 它决定「内容有没有变」，算错就会每次都全量上传。
 */

import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, readFile, rm, readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { gitBlobSha } from '../lib/paths.js'
import {
  CATEGORIES,
  categoryOf,
  collectLocal,
  planSync,
  pullPlan,
  repoPathFor,
  localRelFor,
  skipped,
} from '../lib/sync.js'
import { normalizeConfig, normalizeRepoPath, DEFAULT_INCLUDE } from '../lib/config.js'

const tests = []
const test = (name, fn) => tests.push({ name, fn })

// ---------------- git blob sha ----------------

test('gitBlobSha 和 git hash-object 一致', () => {
  // `printf 'hello' | git hash-object --stdin` = b6fc4c620b67d95f953a5c1c1230aaab5db5a1b0
  assert.equal(gitBlobSha(Buffer.from('hello')), 'b6fc4c620b67d95f953a5c1c1230aaab5db5a1b0')
  // 空 blob: e69de29bb2d1d6434b8b29ae775ad8c2e48c5391
  assert.equal(gitBlobSha(Buffer.alloc(0)), 'e69de29bb2d1d6434b8b29ae775ad8c2e48c5391')
})

// ---------------- 配置归一化 ----------------

test('normalizeConfig 补默认值、丢掉坏字段', () => {
  const config = normalizeConfig({ repo: ' a/b ', path: '/x/y/', include: { core: false, secrets: 'yes' } })
  assert.equal(config.repo, 'a/b')
  assert.equal(config.path, 'x/y')
  assert.equal(config.include.core, false)
  assert.equal(config.include.secrets, DEFAULT_INCLUDE.secrets, '非布尔值应被丢掉，回到默认')
  assert.equal(config.include.state, true)
})

test('normalizeRepoPath 拒绝 .. 和空段', () => {
  assert.equal(normalizeRepoPath(''), '')
  assert.equal(normalizeRepoPath('/'), '')
  assert.equal(normalizeRepoPath('dsh/'), 'dsh')
  assert.equal(normalizeRepoPath('/a//b/'), 'a/b')
  assert.throws(() => normalizeRepoPath('a/../b'))
})

// ---------------- 路径分类 ----------------

test('三类路径各自归位', () => {
  assert.equal(categoryOf('cordis.patch.yml'), 'core')
  assert.equal(categoryOf('profiles/desktop/cordis.patch.yml'), 'core')
  assert.equal(categoryOf('profiles/desktop/package.json'), 'core')
  assert.equal(categoryOf('storages/workspace.json'), 'state')
  assert.equal(categoryOf('automation/state.json'), 'state')
  assert.equal(categoryOf('.env'), 'secrets')
  assert.equal(categoryOf('.credentials.yaml'), 'secrets')
  assert.equal(categoryOf('.trae-auth.cn.json'), 'secrets')
})

test('永不进同步的路径', () => {
  for (const path of ['sessions/x/y', 'attachments/a.png', 'storages/session_projcache/s.json',
    'profiles/desktop/node_modules/x/index.js', 'cloud-sync/backups/a/b', '.DS_Store', 'a/b.log']) {
    assert.equal(skipped(path), true, `${path} 应该被跳过`)
  }
  assert.equal(skipped('storages/workspace.json'), false)
})

// ---------------- 同步计划 ----------------

test('planSync：新建 / 更新 / 删除 / 未变 四种情况', () => {
  const files = [
    { rel: 'a.json', sha: 'sha-a' },
    { rel: 'b.json', sha: 'sha-b' },
    { rel: 'new.json', sha: 'sha-new' },
  ]
  const remote = {
    files: new Map([
      ['dsh/a.json', 'sha-a'],      // 未变
      ['dsh/b.json', 'sha-old'],    // 变了
      ['dsh/gone.json', 'sha-gone'],// 仓库有本机没有 -> 删
      ['other/x.json', 'sha-x'],    // 不在同步目录 -> 完全忽略
    ]),
  }
  const plan = planSync({ files, remote, configPath: 'dsh' })
  assert.deepEqual(plan.upload.map((file) => file.rel), ['b.json', 'new.json'])
  assert.deepEqual(plan.unchanged.map((file) => file.rel), ['a.json'])
  assert.deepEqual(plan.remove, ['gone.json'])
  assert.equal(plan.remoteCount, 3)
})

test('planSync：空仓库时全部上传、不删除', () => {
  const files = [{ rel: 'a.json', sha: 'sha-a' }]
  const plan = planSync({ files, remote: undefined, configPath: 'dsh' })
  assert.equal(plan.upload.length, 1)
  assert.deepEqual(plan.remove, [])
  assert.equal(plan.remoteCount, 0)
})

test('planSync：仓库根目录（path 为空）也能正确限定', () => {
  const files = [{ rel: 'a.json', sha: 'sha-a' }]
  const remote = { files: new Map([['a.json', 'sha-a'], ['b.json', 'sha-b']]) }
  const plan = planSync({ files, remote, configPath: '' })
  assert.equal(plan.unchanged.length, 1)
  assert.deepEqual(plan.remove, ['b.json'])
})

test('repoPathFor / localRelFor 互为逆运算', () => {
  assert.equal(repoPathFor('dsh', 'a/b.json'), 'dsh/a/b.json')
  assert.equal(repoPathFor('', 'a/b.json'), 'a/b.json')
  assert.equal(localRelFor('dsh', 'dsh/a/b.json'), 'a/b.json')
  assert.equal(localRelFor('dsh', 'other/a.json'), null)
  assert.equal(localRelFor('', 'a/b.json'), 'a/b.json')
})

// ---------------- collectLocal ----------------

test('collectLocal 按开关收集，跳过符号链接和大目录', async () => {
  const home = await mkdtemp(join(tmpdir(), 'dsh-sync-home-'))
  try {
    await writeFile(join(home, 'cordis.patch.yml'), 'a: 1\n')
    await writeFile(join(home, '.env'), 'KEY=1\n')
    await mkdir(join(home, 'profiles/desktop'), { recursive: true })
    await writeFile(join(home, 'profiles/desktop/cordis.patch.yml'), 'b: 2\n')
    await mkdir(join(home, 'profiles/desktop/node_modules/x'), { recursive: true })
    await writeFile(join(home, 'profiles/desktop/node_modules/x/index.js'), 'x')
    await mkdir(join(home, 'storages/session_projcache'), { recursive: true })
    await writeFile(join(home, 'storages/session_projcache/s.json'), '{}')
    await mkdir(join(home, 'sessions/ws'), { recursive: true })
    await writeFile(join(home, 'sessions/ws/s.jsonl'), '{}')
    await mkdir(join(home, 'storages'), { recursive: true })
    await writeFile(join(home, 'storages/workspace.json'), '{}')
    await writeFile(join(home, '.trae-auth.cn.json'), '{}')

    const withoutSecrets = await collectLocal({
      home,
      include: { core: true, state: true, secrets: false },
    })
    const paths = withoutSecrets.files.map((file) => file.rel).sort()
    assert.deepEqual(paths, [
      'cordis.patch.yml',
      'profiles/desktop/cordis.patch.yml',
      'storages/workspace.json',
    ])

    const withSecrets = await collectLocal({
      home,
      include: { core: true, state: true, secrets: true },
    })
    const all = withSecrets.files.map((file) => file.rel).sort()
    assert.deepEqual(all, [
      '.env',
      '.trae-auth.cn.json',
      'cordis.patch.yml',
      'profiles/desktop/cordis.patch.yml',
      'storages/workspace.json',
    ])
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

test('collectLocal 的 extraPaths 能指定目录，也不允许跑出 ~/.dsh', async () => {
  const home = await mkdtemp(join(tmpdir(), 'dsh-sync-extra-'))
  try {
    await mkdir(join(home, 'weird'), { recursive: true })
    await writeFile(join(home, 'weird/x.txt'), 'x')
    const inside = await collectLocal({
      home,
      include: { core: true, state: true, secrets: false },
      extraPaths: ['weird'],
    })
    assert.deepEqual(inside.files.map((file) => file.rel), ['weird/x.txt'])

    const outside = await collectLocal({
      home,
      include: { core: true, state: true, secrets: false },
      extraPaths: ['../etc/passwd', '/etc/hosts'],
    })
    assert.equal(outside.files.length, 0, 'DSH 目录外的路径必须一个都不收')
    assert.ok(outside.skipped.every((item) => item.reason.includes('不在 DSH 数据目录')))
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

// ---------------- pullPlan ----------------

test('pullPlan 只写 DSH 目录内、会跳过的路径不写，覆盖前备份，内容相同则不动', async () => {
  const home = await mkdtemp(join(tmpdir(), 'dsh-pull-home-'))
  const backupRoot = await mkdtemp(join(tmpdir(), 'dsh-pull-backup-'))
  try {
    await mkdir(join(home, 'profiles/desktop'), { recursive: true })
    await writeFile(join(home, 'profiles/desktop/cordis.patch.yml'), 'OLD\n')
    await writeFile(join(home, 'same.json'), 'SAME\n')

    const result = await pullPlan({
      files: [
        { rel: 'profiles/desktop/cordis.patch.yml', buffer: Buffer.from('NEW\n') },
        { rel: 'same.json', buffer: Buffer.from('SAME\n') },
        { rel: 'sessions/leak.json', buffer: Buffer.from('LEAK\n') },
        { rel: '../escape.txt', buffer: Buffer.from('ESCAPE\n') },
      ],
      home,
      backupDir: backupRoot,
    })

    assert.deepEqual(result.written, ['profiles/desktop/cordis.patch.yml'])
    assert.deepEqual(result.backedUp, ['profiles/desktop/cordis.patch.yml'])
    assert.equal(await readFile(join(home, 'profiles/desktop/cordis.patch.yml'), 'utf8'), 'NEW\n')
    assert.equal(await readFile(join(backupRoot, 'profiles/desktop/cordis.patch.yml'), 'utf8'), 'OLD\n')
    // 内容相同的文件不该被重写
    assert.ok(!result.written.includes('same.json'))
    // 会话目录属于「不同步的路径」，必须被挡掉
    assert.ok(result.skipped.some((item) => item.path === 'sessions/leak.json'))
    // 越界路径必须被挡掉，且文件确实没被创建
    assert.ok(result.skipped.some((item) => item.path === '../escape.txt'))
    await assert.rejects(readFile(join(home, '..', 'escape.txt'), 'utf8'))
  } finally {
    await rm(home, { recursive: true, force: true })
    await rm(backupRoot, { recursive: true, force: true })
  }
})

// ---------------- 跑 ----------------

let failed = 0
for (const { name, fn } of tests) {
  try {
    await fn()
    console.log(`ok   ${name}`)
  } catch (error) {
    failed += 1
    console.error(`FAIL ${name}`)
    console.error(error instanceof Error ? error.stack : error)
  }
}
console.log(`\n${tests.length - failed}/${tests.length} 通过`)
if (failed > 0) process.exitCode = 1
