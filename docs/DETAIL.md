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

## 3. 出错怎么办

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

## 4. 刻意的限制

**不做三方合并。** 两台机器都改过同一个文件时，恢复会用仓库版本整份覆盖本机。配置文件逐行合并看起来很美，实际上没法判断「这行为什么这么写」，不如让人自己决定。备份兜底。

**不跟随符号链接。** `~/.dsh/skills` 指向 `~/git/skills`，那是一个完整的 git 仓库。跟随它会把几百个文件拖进同步仓库，而且这些文件的更新应该走它们自己的 git 流程，不该经过这里。

**不处理超过 1 MiB 的文件。** GitHub API 能传更大，但配置文件超过 1 MiB 通常说明范围选错了。超限的文件会被跳过并在预览里列出来。

**最多 2000 个文件。** 同理。同步的是配置，不是代码仓库。

**恢复后要重启 DSH。** 配置文件在启动时读取，热重载覆盖不到所有项（尤其是 Host 侧的补丁）。界面上的恢复结果会提示这一点。

**不做定时同步。** 配置改动不频繁，自动同步带来的「哪次覆盖了哪次」的困惑远大于便利。要定时，可以用 DSH 自己的定时任务功能让模型调用 `cloud_sync_backup`。

## 5. 数据在哪

| 文件 | 内容 | 权限 |
|---|---|---|
| `~/.dsh/cloud-sync/config.json` | 仓库、分支、目录、开关、额外路径 | 0600 |
| `~/.dsh/cloud-sync/last-sync.json` | 最近一次同步摘要 | 0600 |
| `~/.dsh/cloud-sync/token.json` | token（**仅在凭据服务缺席时**使用） | 0600 |
| `~/.dsh/cloud-sync/backups/` | 恢复前的备份 | 0700 |
| `~/.dsh/cloud-sync/work/` | git 传输的镜像工作区 | — |

token 正常情况下存在 DSH 的凭据记录里（key: `dsh-cloud-sync/github`），不在上面任何文件中。调 `ctx.credentials.modifyRecord()` 写入，只有凭据服务不可用时才退回 `token.json`。

`config.json` 会参与同步 —— 它本身是配置，也不含密钥。`last-sync.json` 和 `backups/` 不参与同步（在跳过名单里）。

## 6. HTTP 路由

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

安全：只接受同源请求（`Origin` 为空或与 `Host` 一致，或本机名）；写操作要求 `x-dsh-cloud-sync: 1` 请求头，挡掉跨站表单；请求体上限 16 KB。
