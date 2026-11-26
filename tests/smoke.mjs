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
import {
  computeNextRun, defaultSchedule, describeSchedule, normalizeSchedule, ScheduleRunner,
} from '../lib/schedule.js'
import {
  collectManifest, describeDependency, parseRepositoryUrl, planInstall, summarizeManifest,
} from '../lib/plugins-manifest.js'
import {
  normalizePlatform, normalizePlatforms, supportsPlatform, applyOverride, detectPlatforms,
} from '../lib/platform.js'
import {
  unsupportedPluginNames, rewritePackageJson, rewriteCordisPatch, rewriteFilesForPlatform,
} from '../lib/config-rewrite.js'

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

test('workbuddy-vault 归密钥类，不是永远跳过', () => {
  // 这五个文件里是 5 个账号的明文 refreshToken：跟着「密钥」开关走，
  // 放进「永远不同步」等于让用户以为它被跳过了、其实只是没给选择。
  for (const path of ['workbuddy-vault', 'workbuddy-vault/cn/a.json', 'workbuddy-vault/global/b.json']) {
    assert.equal(categoryOf(path), 'secrets', `${path} 应归密钥类`)
    assert.equal(skipped(path), false, `${path} 不该被无条件跳过`)
  }
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

// ---------------- 定时备份 ----------------

test('归一化只认三种周期，越界值夹回范围', () => {
  assert.equal(normalizeSchedule(undefined).mode, 'off')
  assert.equal(normalizeSchedule({ mode: 'cron' }).mode, 'off', '未知周期必须回落到关闭')
  assert.equal(normalizeSchedule({ mode: 'interval', minutes: 0 }).minutes, 1)
  assert.equal(normalizeSchedule({ mode: 'interval', minutes: 999999 }).minutes, 10080)
  assert.equal(normalizeSchedule({ mode: 'daily', time: '25:00' }).time, '21:00', '非法时刻回默认')
  assert.equal(normalizeSchedule({ mode: 'daily', time: '9:5' }).time, '09:05', '补零')
  assert.equal(normalizeSchedule({ mode: 'weekly', weekday: 9 }).weekday, 1)
})

test('非法时刻不会被静默接受', () => {
  // normalizeTime 返回 undefined，normalizeSchedule 回落到默认 —— API 层另有显式拒绝。
  assert.equal(normalizeSchedule({ mode: 'daily', time: '25:00' }).time, '21:00')
  assert.equal(normalizeSchedule({ mode: 'daily', time: '21:60' }).time, '21:00')
})

test('daily：今天没到就今天，过了就明天', () => {
  const now = new Date('2026-11-25T11:05:00+08:00')
  assert.equal(
    computeNextRun({ mode: 'daily', time: '21:00' }, now).toISOString(),
    new Date('2026-11-25T21:00:00+08:00').toISOString(),
  )
  assert.equal(
    computeNextRun({ mode: 'daily', time: '09:00' }, now).toISOString(),
    new Date('2026-11-26T09:00:00+08:00').toISOString(),
  )
})

test('interval：从现在起算 N 分钟', () => {
  const now = new Date('2026-11-25T11:05:00+08:00')
  assert.equal(
    computeNextRun({ mode: 'interval', minutes: 30 }, now).toISOString(),
    new Date('2026-11-25T11:35:00+08:00').toISOString(),
  )
})

test('weekly：同日未到是今天，已过就顺延一周', () => {
  const wednesday = new Date('2026-11-25T11:05:00+08:00') // 周三
  assert.equal(
    computeNextRun({ mode: 'weekly', weekday: 3, time: '21:00' }, wednesday).toISOString(),
    new Date('2026-11-25T21:00:00+08:00').toISOString(),
  )
  assert.equal(
    computeNextRun({ mode: 'weekly', weekday: 3, time: '09:00' }, wednesday).toISOString(),
    new Date('2026-12-02T09:00:00+08:00').toISOString(),
  )
  assert.equal(
    computeNextRun({ mode: 'weekly', weekday: 1, time: '21:00' }, wednesday).toISOString(),
    new Date('2026-11-30T21:00:00+08:00').toISOString(),
  )
  // 周日是 7，Date 里是 0：这条最容易写错
  assert.equal(
    computeNextRun({ mode: 'weekly', weekday: 7, time: '21:00' }, wednesday).toISOString(),
    new Date('2026-11-29T21:00:00+08:00').toISOString(),
  )
})

test('off 永远不排期', () => {
  assert.equal(computeNextRun({ mode: 'off' }, new Date()), undefined)
})

test('describeSchedule 三种周期都说人话', () => {
  assert.equal(describeSchedule({ mode: 'off' }), '关闭')
  assert.equal(describeSchedule({ mode: 'daily', time: '21:00' }), '每天 21:00')
  assert.equal(describeSchedule({ mode: 'interval', minutes: 30 }), '每隔 30 分钟')
  assert.equal(describeSchedule({ mode: 'weekly', weekday: 1, time: '21:00' }), '每周一 21:00')
  assert.equal(describeSchedule({ mode: 'weekly', weekday: 7, time: '09:30' }), '每周日 09:30')
})

test('ScheduleRunner 到点跑一次并重排；off 时不排', async () => {
  let now = new Date('2026-11-25T11:00:00+08:00')
  const clock = { get: () => now }
  let runs = 0
  let config = { mode: 'interval', minutes: 30 }
  const runner = new ScheduleRunner({
    getSchedule: () => config,
    run: async () => { runs += 1 },
    logger: { warn() {} },
    now: () => clock.get(),
  })

  const first = runner.arm()
  assert.equal(first.toISOString(), new Date('2026-11-25T11:30:00+08:00').toISOString())
  assert.ok(runner.nextRunAt, '排期后应有 nextRunAt')

  // 直接调 fire 模拟到点：不该依赖真实等待
  now = new Date('2026-11-25T11:30:00+08:00')
  await runner.fire()
  assert.equal(runs, 1)
  assert.equal(
    runner.nextRunAt.toISOString(),
    new Date('2026-11-25T12:00:00+08:00').toISOString(),
    '跑完应从结束时刻重排下一次',
  )

  // 关掉后不该再排
  config = { mode: 'off' }
  assert.equal(runner.arm(), undefined)
  assert.equal(runner.nextRunAt, undefined)
  runner.stop()
})

test('ScheduleRunner 里 run 抛错不会打死循环，仍会排下一次', async () => {
  const now = new Date('2026-11-25T11:00:00+08:00')
  let runs = 0
  const warned = []
  const runner = new ScheduleRunner({
    getSchedule: () => ({ mode: 'interval', minutes: 10 }),
    run: async () => { runs += 1; throw new Error('网络炸了') },
    logger: { warn: (...args) => warned.push(args) },
    now: () => now,
  })
  runner.arm()
  await runner.fire()
  assert.equal(runs, 1)
  assert.ok(warned.length > 0, '失败应记日志')
  assert.ok(runner.nextRunAt, '失败后仍要排下一次，否则一次网络抖动就永久停摆')
  runner.stop()
})

// ---------------- 插件清单 ----------------

test('parseRepositoryUrl 认 https / ssh / shorthand 三种写法', () => {
  assert.equal(parseRepositoryUrl('git+https://github.com/o/r.git'), 'o/r')
  assert.equal(parseRepositoryUrl('git@github.com:o/r.git'), 'o/r')
  assert.equal(parseRepositoryUrl('https://github.com/o/r'), 'o/r')
  assert.equal(parseRepositoryUrl('github:o/r'), 'o/r')
  assert.equal(parseRepositoryUrl('gitlab.com/x/y'), undefined)
  assert.equal(parseRepositoryUrl(undefined), undefined)
})

test('registry 依赖钉死已装版本，不照抄 ^ 范围', () => {
  const pinned = describeDependency('p', '^1.2.0', { version: '1.2.5' })
  assert.equal(pinned.kind, 'registry')
  assert.equal(pinned.spec, 'p@1.2.5', '必须装回同一个版本，不能拿到当时的最新版')
  assert.equal(pinned.recorded, '^1.2.0')
  // 读不到已装 manifest 时退回记录里的范围，但仍然要带上包名
  // （只写 `^1.2.0` 会被 pnpm 当成一个叫 \"^1.2.0\" 的包去 registry 找，必然 404）
  assert.equal(describeDependency('p', '^1.2.0', undefined).spec, 'p@1.2.0')
})

test('link: 依赖从 repository 反推 github spec，monorepo 带 path', () => {
  const single = describeDependency('a', 'link:/Users/me/a', {
    version: '1.0.0',
    repository: { url: 'git+https://github.com/o/r.git' },
  })
  assert.equal(single.kind, 'git')
  assert.equal(single.spec, 'github:o/r')

  const mono = describeDependency('b', 'link:/Users/me/r/packages/b', {
    version: '1.0.0',
    repository: { url: 'git+https://github.com/o/r.git', directory: 'packages/b' },
  })
  assert.equal(mono.spec, 'github:o/r#path:/packages/b')
})

test('反推不出的 link: 依赖标成 unresolvable，绝不硬装', () => {
  const local = describeDependency('local', 'link:/tmp/local', { version: '0.1.0' })
  assert.equal(local.kind, 'unresolvable')
  assert.equal(local.spec, undefined, '没有可安装的地址就不该给出 spec 去装空包')
  assert.ok(local.reason.includes('repository'))

  const manifest = { profiles: [{ profile: 'desktop', plugins: [local, { name: 'ok', kind: 'git', spec: 'github:o/r' }] }] }
  const plan = planInstall(manifest, 'desktop')
  assert.deepEqual(plan[0].add, ['github:o/r'], 'unresolvable 不能进安装列表')
  assert.equal(plan[0].manual.length, 1)
})

test('collectManifest 跳过官方包，只留有依赖的 profile', async () => {
  const home = await mkdtemp(join(tmpdir(), 'plg-manifest-'))
  try {
    const pdir = join(home, 'profiles/desktop')
    await mkdir(join(pdir, 'node_modules/demo'), { recursive: true })
    await writeFile(join(pdir, 'package.json'), JSON.stringify({
      name: 'dsh-profile-desktop',
      private: true,
      dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', 'demo'] } },
      dependencies: {
        '@deepseek-ai/dsh-web-app': '0.2.2',
        demo: '^2.0.0',
      },
    }))
    await writeFile(join(pdir, 'node_modules/demo/package.json'), JSON.stringify({ name: 'demo', version: '2.1.0' }))
    const manifest = await collectManifest(home)
    assert.equal(manifest.profiles.length, 1)
    const plugins = manifest.profiles[0].plugins
    assert.deepEqual(plugins.map((p) => p.name), ['demo'], '官方包不该进清单')
    assert.equal(manifest.profiles[0].bundles.length, 1, 'bundles 里也不该有官方包')
    assert.equal(summarizeManifest(manifest).total, 1)
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

test('当前 profile 不在清单里时退回其他 profile 的并集', () => {
  const manifest = { profiles: [
    { profile: 'web', plugins: [
      { name: 'a', kind: 'registry', spec: 'a@1' },
      { name: 'b', kind: 'git', spec: 'github:o/b' },
    ] },
  ] }
  // 新机器是 desktop，但清单来自一台只用 web 的机器
  const plan = planInstall(manifest, 'desktop')
  assert.equal(plan.length, 1)
  assert.deepEqual(plan[0].add, ['a@1', 'github:o/b'])
  assert.deepEqual(plan[0].fromProfiles, ['web'])
})

test('同一插件出现在多个 profile 时只算一次', () => {
  const manifest = { profiles: [
    { profile: 'a', plugins: [{ name: 'x', kind: 'git', spec: 'github:o/x' }] },
    { profile: 'b', plugins: [{ name: 'x', kind: 'git', spec: 'github:o/x' }] },
  ] }
  assert.equal(summarizeManifest(manifest).total, 1)
  assert.equal(summarizeManifest(manifest).git, 1)
})

// ---------------- 平台识别与跨平台同步 ----------------

test('normalizePlatform / normalizePlatforms 归一化', () => {
  assert.equal(normalizePlatform('macOS'), 'darwin')
  assert.equal(normalizePlatform('Windows'), 'win32')
  assert.equal(normalizePlatform('solaris'), undefined)
  assert.deepEqual(normalizePlatforms(['darwin']), ['darwin'])
  assert.deepEqual(normalizePlatforms([]), ['darwin', 'win32', 'linux'])
  assert.deepEqual(normalizePlatforms('bad'), ['darwin', 'win32', 'linux'])
})

test('supportsPlatform：无 platforms 的老条目视为通用', () => {
  assert.equal(supportsPlatform({ name: 'x' }, 'win32'), true)
  assert.equal(supportsPlatform({ name: 'x', platforms: ['darwin'] }, 'win32'), false)
  assert.equal(supportsPlatform({ name: 'x', platforms: ['darwin'] }, 'darwin'), true)
  assert.equal(supportsPlatform({ name: 'x', platforms: ['darwin', 'win32'] }, 'win32'), true)
})

test('applyOverride 让手动覆盖优先于自动识别', () => {
  assert.deepEqual(applyOverride(['darwin'], { x: ['win32'] }, 'x'), ['win32'])
  assert.deepEqual(applyOverride(['darwin'], {}, 'x'), ['darwin'])
})

test('detectPlatforms：os 字段最权威', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'plat-detect-'))
  try {
    const r = await detectPlatforms(dir, 'p', { os: ['darwin'] })
    assert.deepEqual(r.platforms, ['darwin'])
    assert.equal(r.source, 'os-field')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('detectPlatforms：macOS 系统 API 信号只把 Mac 插件判为专属，跨平台插件不误判', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'plat-scan-'))
  try {
    await writeFile(join(dir, 'index.js'), "import { execFile } from 'node:child_process'\nexecFile('/usr/sbin/screencapture', ['-x'])\nif (process.platform !== 'darwin') return\n")
    const mac = await detectPlatforms(dir, 'some-cua', { version: '1' })
    assert.deepEqual(mac.platforms, ['darwin'])

    // 跨平台插件：代码里有 Windows 支持、process.platform !== 'win32' 分支，
    // 但没有 macOS 系统级调用 —— 必须判为通用，不能被误跳过。
    await writeFile(join(dir, 'index.js'), "if (process.platform === 'win32') { exec('powershell') }\nconst p = 'C:\\\\Windows\\\\System32'\n")
    const cross = await detectPlatforms(dir, 'cross-platform-thing', { version: '1' })
    assert.deepEqual(cross.platforms, ['darwin', 'win32', 'linux'])
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('planInstall 按目标平台过滤，清单条目不丢（双向）', () => {
  const manifest = { profiles: [{ profile: 'desktop', plugins: [
    { name: 'mac-only', kind: 'registry', spec: 'mac-only@1', platforms: ['darwin'] },
    { name: 'win-only', kind: 'registry', spec: 'win-only@1', platforms: ['win32'] },
    { name: 'common', kind: 'registry', spec: 'common@1', platforms: ['darwin', 'win32', 'linux'] },
  ] }] }
  const win = planInstall(manifest, 'desktop', 'win32')[0]
  assert.deepEqual(win.add, ['win-only@1', 'common@1'])
  assert.deepEqual(win.skippedPlatform.map((item) => item.name), ['mac-only'])
  const mac = planInstall(manifest, 'desktop', 'darwin')[0]
  assert.deepEqual(mac.add, ['mac-only@1', 'common@1'])
  assert.deepEqual(mac.skippedPlatform.map((item) => item.name), ['win-only'])
})

test('summarizeManifest 统计平台专属数量', () => {
  const manifest = { profiles: [{ profile: 'desktop', plugins: [
    { name: 'm', platforms: ['darwin'] },
    { name: 'w', platforms: ['win32'] },
    { name: 'c', platforms: ['darwin', 'win32'] },
  ] }] }
  const s = summarizeManifest(manifest)
  assert.equal(s.darwinOnly, 1)
  assert.equal(s.win32Only, 1)
  assert.equal(s.universal, 1)
})

test('unsupportedPluginNames 支持本机覆盖', () => {
  const manifest = { profiles: [{ profile: 'desktop', plugins: [
    { name: 'x', platforms: ['darwin'] },
  ] }] }
  assert.ok(unsupportedPluginNames(manifest, 'win32').has('x'))
  assert.ok(!unsupportedPluginNames(manifest, 'win32', { x: ['darwin', 'win32'] }).has('x'))
})

test('rewritePackageJson 剔除 bundles 与 dependencies 里的不适用插件', () => {
  const text = JSON.stringify({
    dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', 'dsh-mac-computer-use'] } },
    dependencies: { 'dsh-mac-computer-use': '^1.5.5', common: '1.0.0' },
  }, null, 2)
  const next = rewritePackageJson(text, new Set(['dsh-mac-computer-use']))
  const parsed = JSON.parse(next)
  assert.deepEqual(parsed.dsh.profile.bundles, ['@deepseek-ai/dsh-base'])
  assert.deepEqual(Object.keys(parsed.dependencies), ['common'])
})

test('rewriteCordisPatch 只删顶层条目，保留内部多行与 !!js', () => {
  const text = [
    '# header',
    '- id: keep',
    '  name: keep-plugin',
    '  config:',
    '    key: !!js process.env.X',
    '- id: dsh-mac-computer-use',
    '  name: dsh-mac-computer-use',
    '  config:',
    '    nested:',
    '      - a',
    '- id: other',
    '  name: other-plugin',
  ].join('\n')
  const next = rewriteCordisPatch(text, new Set(['dsh-mac-computer-use']))
  assert.ok(!next.includes('dsh-mac-computer-use'))
  assert.ok(next.includes('key: !!js process.env.X'))
  assert.ok(next.includes('name: other-plugin'))
  assert.ok(next.includes('# header'))
})

test('rewriteFilesForPlatform 只改写相关文件，报告被剔除插件', async () => {
  const manifest = { profiles: [{ profile: 'desktop', plugins: [
    { name: 'mac-only', platforms: ['darwin'] },
  ] }] }
  const files = [
    { rel: 'profiles/desktop/package.json', buffer: Buffer.from('{"dependencies":{"mac-only":"1","x":"1"}}') },
    { rel: 'profiles/desktop/cordis.patch.yml', buffer: Buffer.from('- id: mac-only\n  name: mac-only\n') },
    { rel: 'storages/workspace.json', buffer: Buffer.from('{"a":1}') },
  ]
  const result = rewriteFilesForPlatform(files, manifest, 'win32', {})
  assert.deepEqual(result.rewritten.sort(), ['profiles/desktop/cordis.patch.yml', 'profiles/desktop/package.json'])
  assert.deepEqual(result.dropped, ['mac-only'])
  assert.deepEqual(JSON.parse(result.files[0].buffer.toString()).dependencies, { x: '1' })
  assert.equal(result.files[2].buffer.toString(), '{"a":1}', '无关文件不该动')
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
