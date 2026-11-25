# 云同步 · 详细说明

这份文档展开讲：同步范围为什么这么切、两种传输的差别、出错怎么办、以及几个刻意的限制。

## 1. 同步范围

DSH 把一切都放在 `~/.dsh` 下。它的大小分布大致是：

| 路径 | 典型大小 | 是否同步 |
|---|---|---|
| `sessions/` | 几十 MB ~ 几百 MB | ❌ 会话记录，只属于这台机器 |
| `attachments/` | 几十 MB | ❌ 附件图片 |
| `storages/session_projcache/` | 几十 MB | ❌ 会话投影缓存，可重建 |
| `workbuddy-vault/` | 视插件 | ❌ 第三方插件的私有数据 |
| `dsh-runtimes/` | 几百 MB | ❌ 运行时 |
| `profiles/*/node_modules/` | 几百 MB | ❌ 依赖 |
| **`cordis.patch.yml`** | 几 KB | ✅ |
| **`profiles/*/cordis.patch.yml`** 等 | 每个几 KB ~ 几十 KB | ✅ |
| **`storages/*.json`** | 几 KB | ✅ 工作区列表、定时任务 |
| **`automation/state.json`** | 几 KB | ✅ |
| `.env` / `.credentials.yaml` / `.<插件>.json` | 几 KB | ⚠️ 密钥，默认关 |

结论：真正该带走的是**几 KB 到几十 KB 的配置**，其余全是机器本地状态。所以默认只同步配置和使用状态。

### 三类开关

**配置**（默认开）：主补丁、各 profile 的补丁与依赖清单。这是核心 —— 没有它，新机器就是空的。

**应用状态**（默认开）：`storages/*.json` 里有工作区列表和定时任务，`automation/state.json` 是自动化插件的状态，`scripts/` 下是自定义脚本。这些丢了要重配，带上是合理的。

**密钥**（默认关）：`.env`、`.credentials.yaml`、各插件的登录态。风险见 README。这里额外说一句：**`.credentials.yaml` 里的东西有些是设备绑定的**（例如 DeepSeek 平台登录授权），复制到另一台机器可能直接失效，甚至造成两台设备互相顶掉。所以即使打开密钥开关，也建议先确认里面每一项都是「可迁移的纯 key」。

### 额外路径

`额外路径` 让你补充其它文件，一行一个。规则：

- 相对 `~/.dsh` 解析；绝对路径也接受，但必须落在 `~/.dsh` 内
- 可以是文件或目录
- 不受三类开关限制（你点名了就同步）
- 但仍然受「永远不同步」的黑名单和单文件 1 MiB 限制

## 2. 两种传输

### GitHub API

`lib/github.js`。走 [Git Data API](https://docs.github.com/rest/git)：

1. `POST /git/blobs` —— 每个变化文件建一个 blob
2. `POST /git/trees` —— 用 `base_tree` + 子路径条目建一棵新树
3. `POST /git/commits` —— 建 commit
4. `PATCH /git/refs/heads/<branch>` —— 挪分支指针

一次同步 = 一个 commit，中途任何一步失败，仓库都还是原来那个 commit。

需要的权限：fine-grained token 的 **Contents: Read and write**（如果仓库是新建的，还要确保 token 的 Repository access 包含它）；classic token 的 `repo` scope。

### git 命令

`lib/gitcli.js`。在 `~/.dsh/cloud-sync/work` 维护一个浅克隆镜像：

- `push`：把本机文件铺进镜像 → `git add -- <同步目录>` → `git commit` → `git push`
- `pull`：`git fetch` + `reset --hard` → 从镜像里读文件 → 写回本机

适合已经配好 SSH key 的机器；也适合自建 Git 服务（在「git 远程地址」里填完整 URL）。

一个坑：镜像工作区是**跨分支复用的**。切到一个远端还不存在的分支时，如果不先清空工作区，上一次同步留下的文件会被当成「这个分支的现状」读出来。所以 `prepare()` 在新建孤儿分支前会 `rm -r .` + `clean -ffd`。

## 3. 定时备份

### 三种周期，没有 cron

| 类型 | 字段 | 语义 |
|---|---|---|
| `off` | — | 关闭（默认） |
| `daily` | `time: "HH:MM"` | 每天这个时刻 |
| `interval` | `minutes: 1..10080` | 每隔 N 分钟 |
| `weekly` | `weekday: 1..7`, `time: "HH:MM"` | 每周几这个时刻（1=周一，7=周日） |

刻意不支持 cron 表达式：备份配置这件事，用户想要的永远是这三种之一。多出来的表达力只会变成配置错误 —— 而配置错误在这里的代价是「以为在备份，其实没跑」。

### 排期怎么算

`computeNextRun(schedule, now)` 是纯函数，永远返回**严格晚于 `now`** 的时刻。这带来两个可预期的行为：

- **刚启动不会立刻跑**。`daily 21:00` 在 20:59 打开 DSH，下一次是今天 21:00；在 21:01 打开，下一次是明天 21:00。不会出现「一开机就备份一次，重启几次备份几次」。
- **不补跑错过的周期**。电脑关机错过了 21:00，开机后不会立刻补一次，而是等下一个 21:00。补跑会让「今天备份过没有」变得不可预测。

时间一律按**本机时区**解释。`Date#setHours` 用的是本地时间，"每天 21:00" 就是你表上的 21:00 —— 而不是 UTC 21:00。

周日的映射是最容易写错的一处：配置里用 1..7（周一..周日，符合中文习惯），`Date#getDay()` 用 0..6（周日..周六）。转换在 `computeNextRun` 里集中做一次，测试里有专门的断言（`weekday: 7` 必须落在周日）。

### 调度循环

`ScheduleRunner` 用 `setTimeout` 而不是 `setInterval`：

```
arm() → setTimeout(到点) → fire() → run() → arm()（按当前配置重算）
```

三个结果：

1. **间隔从上次结束起算**。「每隔 30 分钟」不是固定节拍，而是「这次备份做完，再过 30 分钟」。一次慢同步不会把后面的挤成一串。
2. **改配置立刻生效**。`save()` 之后调 `arm()`，旧的 `setTimeout` 被清掉、按新配置重排。用户改完不该等旧周期。
3. **失败不放弃**。`fire()` 里 `run()` 抛错只记日志，`finally` 里照样 `arm()`。一次网络抖动不会让定时备份永久停摆。

定时器上挂了 `unref()`，不会把测试进程吊着不退出。

### 生命周期

`index.js` 把 `startScheduler()` 放进 `ctx.effect`：

```js
ctx.effect(() => {
  service.startScheduler()
  return () => service.stopScheduler()
}, 'cloud-sync: scheduled backup')
```

插件卸载或 HMR 重载时定时器被清掉，不会留下「插件已经关了但还在偷偷 push」的幽灵。

### 只备份，不恢复

定时任务只调 `push()`，从不调 `pull()`。自动覆盖用户本机的配置是不可接受的 —— 用户可能正在改东西，或者刚手工调好某个文件。恢复必须是明确的动作。

`push({ auto: true })` 会在摘要里打标记，界面据此显示「上次自动备份」，和手动点按钮的结果区分开。

### 失败了会怎样

失败记在 `lastAutoResult`（只在内存里，重启即清空），界面上显示「上次自动备份失败：时间 — 原因」。没有做成持久化，是因为它描述的是「本次运行期间最后一次自动备份」，跨重启的历史没有意义 —— 真要查历史，`~/.dsh/cloud-sync/last-sync.json` 里有完整的最近一次同步摘要。

## 4. 出错怎么办

### 常见错误

| 报错 | 原因 | 处理 |
|---|---|---|
| `BAD_TOKEN` / 401 | token 无效或过期 | 重新生成 |
| `FORBIDDEN` / 403 | token 没有写权限 | 检查 Contents 权限和仓库授权范围 |
| `NOT_FOUND` / 404 | 仓库或分支不存在 | 确认 `owner/repo` 拼写；私有仓库要授权给 token |
| `EMPTY_REMOTE` | 分支上还没有提交 | 先在老机器上备份一次 |
| `NO_REPO` / `NO_TOKEN` | 配置没填 | 设置页填好再试 |
| git 传输 `Permission denied (publickey)` | SSH key 没配好 | 先 `ssh -T git@github.com` 确认 |

### 备份在哪

每次「从仓库恢复」覆盖文件前，旧文件被复制到：

```
~/.dsh/cloud-sync/backups/<YYYY-MM-DD_HH-MM-SS>/<原相对路径>
```

保留最近 10 份，更早的自动删除。要手动回滚，把里面的文件拷回去就行。

### 同步卡住

同一时间只允许一个同步任务。如果界面一直显示「进行中」但其实没有请求在跑（比如页面关掉时正好在同步），重启 DSH 即可 —— 运行状态在内存里，不落盘。

## 5. 刻意的限制

**不做三方合并。** 两台机器都改过同一个文件时，恢复会用仓库版本整份覆盖本机。配置文件逐行合并看起来很美，实际上没法判断「这行为什么这么写」，不如让人自己决定。备份兜底。

**不跟随符号链接。** `~/.dsh/skills` 指向 `~/git/skills`，那是一个完整的 git 仓库。跟随它会把几百个文件拖进同步仓库，而且这些文件的更新应该走它们自己的 git 流程，不该经过这里。

**不处理超过 1 MiB 的文件。** GitHub API 能传更大，但配置文件超过 1 MiB 通常说明范围选错了。超限的文件会被跳过并在预览里列出来。

**最多 2000 个文件。** 同理。同步的是配置，不是代码仓库。

**恢复后要重启 DSH。** 配置文件在启动时读取，热重载覆盖不到所有项（尤其是 Host 侧的补丁）。界面上的恢复结果会提示这一点。

**不做定时同步。** 配置改动不频繁，自动同步带来的「哪次覆盖了哪次」的困惑远大于便利。要定时，可以用 DSH 自己的定时任务功能让模型调用 `cloud_sync_backup`。

## 6. 数据在哪

| 文件 | 内容 | 权限 |
|---|---|---|
| `~/.dsh/cloud-sync/config.json` | 仓库、分支、目录、开关、额外路径 | 0600 |
| `~/.dsh/cloud-sync/last-sync.json` | 最近一次同步摘要 | 0600 |
| `~/.dsh/cloud-sync/token.json` | token（**仅在凭据服务缺席时**使用） | 0600 |
| `~/.dsh/cloud-sync/backups/` | 恢复前的备份 | 0700 |
| `~/.dsh/cloud-sync/work/` | git 传输的镜像工作区 | — |

token 正常情况下存在 DSH 的凭据记录里（key: `dsh-cloud-sync/github`），不在上面任何文件中。调 `ctx.credentials.modifyRecord()` 写入，只有凭据服务不可用时才退回 `token.json`。

`config.json` 会参与同步 —— 它本身是配置，也不含密钥。`last-sync.json` 和 `backups/` 不参与同步（在跳过名单里）。

## 7. HTTP 路由

浏览器半边通过宿主 HTTP 服务调用：

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/plugins/dsh-cloud-sync/status` | 配置 + token 状态 + 最近同步 |
| POST | `/plugins/dsh-cloud-sync/config` | 改配置 |
| POST | `/plugins/dsh-cloud-sync/token` | 存 / 清 token |
| POST | `/plugins/dsh-cloud-sync/test` | 校验仓库可达 |
| POST | `/plugins/dsh-cloud-sync/preview` | 算差异，不写 |
| POST | `/plugins/dsh-cloud-sync/push` | 备份 |
| POST | `/plugins/dsh-cloud-sync/pull` | 恢复 |
| POST | `/plugins/dsh-cloud-sync/restore` | 校验 + 恢复 |

`POST /config` 的 `schedule` 字段会做校验：`mode` 只接受四个枚举值，`time` 必须是 `HH:MM`（允许一位数），`minutes` 必须是数字，`weekday` 必须在 1..7。越界值在 `normalizeSchedule` 里夹回合法范围，非法枚举回落到 `off`。

安全：只接受同源请求（`Origin` 为空或与 `Host` 一致，或本机名）；写操作要求 `x-dsh-cloud-sync: 1` 请求头，挡掉跨站表单；请求体上限 16 KB。
