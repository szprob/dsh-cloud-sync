# dsh-cloud-sync

把 **DeepSeek Harness（DSH）的配置同步到你自己的 GitHub 仓库**：填一个 token 和一个仓库，一键备份、一键恢复。换台机器装上这个插件、填同样的两项，就能把整套配置拉回来。

> 不是把 `~/.dsh` 整个打包上传。同步的是一个**明确的子集** —— 配置、应用状态、密钥三类，各自有开关；会话记录、附件、缓存、依赖、日志永远不同步。

## 为什么需要它

DSH 会把人设、模型选择、主题、定时任务、插件参数、API key 全写在 `~/.dsh` 里。这台机器上折腾了很久的配置，换机器就得从头再来一遍。

云同步插件补上这一步：`~/.dsh` 里该带走的东西进 git 仓库，新机器一条命令装插件、填两项配置、点一次恢复。

## 安装

```sh
dsh plugin --profile desktop add "github:szprob/dsh-cloud-sync"
```

桌面客户端：**设置 → 插件** 里按包名 `dsh-cloud-sync` 安装。

装完刷新页面，**设置 → 云同步** 出现一个新页面。

## 用起来

### 老机器：备份

1. **设置 → 云同步**
2. 「仓库」填 `owner/repo`（例如 `szprob/dsh-config`）
3. 「仓库内目录」填 `dsh`（或留空用仓库根目录）
4. 传输方式二选一：
   - **GitHub API**：填一个 [fine-grained PAT](https://github.com/settings/tokens?type=beta)，权限 **Contents: Read and write**
   - **git 命令**：不用填 token，直接用本机已有的 SSH key
5. 点「测试连接」确认能通
6. 点「预览差异」看看会传什么
7. 点「备份到仓库」

### 新机器：恢复

1. 装插件
2. 填**同样的**仓库、目录、token（或配好 SSH key 后选 git 传输）
3. 点「从仓库恢复」
4. **重启 DSH**

恢复会覆盖本机同名文件 —— 覆盖前自动备份到 `~/.dsh/cloud-sync/backups/<时间戳>/`，保留最近 10 份。

### 其他插件：一键装回

配置同步**不带插件代码本身** —— `node_modules` 几百 MB，还含平台相关的二进制，跨机器不通用。但只恢复配置的话，新机器上所有第三方插件都会加载失败：

```
dsh: skipping profile bundle "dsh-connect-trae": cannot resolve profile bundle...
dsh: skipping profile bundle "dsh-eye-care": cannot resolve profile bundle...
```

所以「设置 → 云同步」里多了一块 **其他插件**：

1. **导出插件清单** —— 把当前 profile 装了哪些插件写成 `cloud-sync/plugins.json`，随配置一起进仓库
2. **一键装回全部插件** —— 新机器恢复配置后点一下，按清单装回全部

每次备份前会自动刷新清单，不用记得手动导出。

清单里每条依赖收敛成三种形态：

| 形态 | 例子 | 新机器怎么装 |
|---|---|---|
| **registry** | `dsh-connect-trae@4.18.7` | 按名字和版本装 |
| **git** | `github:szprob/dsh-plugins#path:/packages/eye-care` | 从 GitHub 装 |
| **手工** | 没有 `repository` 字段的本地包 | 列出来，告诉你要手动装 |

两个关键细节：

- **registry 依赖钉死实际装到的版本**，不照抄 `^4.18.7` 这种范围。照范围装会拿到当时的最新版，一个插件的破坏性更新就能让恢复出来的环境起不来。
- **`link:` 依赖会从包自己的 `repository` 字段反推**成 `github:` spec。直接把 `link:/Users/songze/...` 抄到新机器，pnpm 只会警告一句并**装出一个 0.0.0 的空包** —— 不报错，但插件是坏的。

装完**必须重启 DSH** 才会加载新插件：插件代码是宿主进程启动时加载的，界面会把这句话说清楚，但不会替用户重启。

### 定时备份

「设置 → 云同步」底部的 **定时备份** 支持三种周期：

| 周期 | 说明 |
|---|---|
| **每天** | 每天 `HH:MM` 备份一次 |
| **每隔** | 每隔 N 分钟备份一次（1 分钟 ~ 7 天） |
| **每周** | 每周几 `HH:MM` 备份一次 |

默认**关闭**。时间按**本机时区**算，所以「每天 21:00」就是你表上的 21:00。

定时任务**只做备份，不会自动恢复** —— 悄悄把本机配置覆盖掉是不可接受的，恢复永远得是你明确按下的动作。

几点行为说明：

- **改完立刻生效**：切换周期、改时间会就地重排下一次，不用等旧周期跑完
- **插件卸载/重载即停**：定时器挂在插件生命周期上，不会留下「插件关了还在偷偷 push」的幽灵
- **从上次结束起算**：间隔模式不是固定节拍，而是「这次备份做完之后再过 N 分钟」，慢同步不会把后面的挤成一串
- **失败不放弃**：一次网络错误只记一条日志（界面上显示「上次自动备份失败」），下一个周期照常再试
- **重启 DSH 后重新计时**：不补跑错过的周期。否则「今天已经备份过了」这件事会变得不可预测

### 让模型来跑

装好之后可以直接说：

> 帮我把配置备份到仓库
> 从仓库恢复配置
> 定时备份改成每周一 21 点

对应四个工具：`cloud_sync_status` / `cloud_sync_backup` / `cloud_sync_restore` / `cloud_sync_schedule`。

## 同步什么

| 类别 | 默认 | 内容 |
|---|:---:|---|
| **配置** | ✅ | `cordis.patch.yml`、各 profile 的 `cordis.patch.yml` / `cordis.yml` / `package.json` / `pnpm-workspace.yaml` / `pnpm-lock.yaml` |
| **应用状态** | ✅ | `storages/*.json`（工作区列表、定时任务）、`automation/state.json`、`scripts/*`、本插件自己的配置 |
| **密钥** | ❌ | `.env`、`.credentials.yaml`、各插件的登录态与账号池（`.trae-auth.cn.json`、`.workbuddy-pool.cn.json` 这类）、`workbuddy-vault/` |
| **额外路径** | — | 自己填，一行一个，相对 `~/.dsh`。只接受这个目录里的文件 |

**永远不同步**：`sessions/`（会话记录，几十上百 MB）、`attachments/`、`storages/session_projcache/`、`dsh-runtimes/`（310 MB 运行时）、`node_modules/`、`cloud-sync/backups/`、`*.log`、符号链接（`skills/` 就是指向 git 仓库的链接，跟进去会把整个技能库拖进来）。

### 关于密钥

密钥默认**关闭**。打开之前想清楚：

- 推到**公开**仓库 = 全世界都能看到你的 API key
- 推到**私有**仓库 = 只有你能看，但仓库一旦泄露、被 fork、被 GitHub 误设成公开，key 就跟着走

真要用，建议：仓库**必须**是私有的；只同步确实需要跨机器的 key；定期轮换。

## 两种传输

| | GitHub API | git 命令 |
|---|---|---|
| 需要 | token | 本机 git + SSH key |
| 适合 | 无 git 环境、CI | 已经配好 SSH 的机器 |
| 副作用 | 无 | 在 `~/.dsh/cloud-sync/work` 维护一个浅克隆镜像 |

两者写出的仓库结构完全相同，随时可以切换。API 模式一次同步 = 一个 commit（先建 blob、再建 tree、再建 commit、最后挪 ref），中途失败不会留下半套文件。

## 仓库长什么样

`~/.dsh` 下的相对路径原样保留在配置的目录里：

```
dsh/
├── cordis.patch.yml
├── .env                        # 开了密钥才有
├── profiles/
│   ├── desktop/
│   │   ├── cordis.patch.yml
│   │   └── package.json
│   └── web/
│       └── cordis.patch.yml
├── storages/
│   ├── workspace.json
│   └── schedule.json
└── automation/
    └── state.json
```

**只读写配置的那个子目录**。你把同步目录放在一个已有内容的仓库里（比如 `dsh-plugins/dsh-config/`）也没关系，仓库里其它文件一个字节都不会动 —— 上传、删除都限定在那棵子树里。

## 一些实现上的取舍

**为什么要「仓库内目录」**：很多人有一个 `dotfiles` 或 `dsh-plugins` 仓库，希望配置也放进去。限定子目录之后，同步逻辑只需要处理相对路径，删除也只删自己那棵树，不会误删别人的文件。

**为什么用 Git Data API 而不是 git 命令**：一次同步是一个 commit。用 `git add` 的话，中途失败会在仓库里留下半套文件，下次同步看到的就是个「既不是旧的、也不是新的」的状态。tree + commit 天然原子。

**为什么「内容有变化才提交」**：每次 push 都算一遍 git blob sha（`sha1("blob <长度>\0" + 内容)`），和远端 tree 里的 sha 对比。一样就跳过——不产生空提交，也不会因为改了个 mtime 就传一遍全量。

**为什么 `lastSync` 单独存**：它一开始放在 `config.json` 里，而 `config.json` 本身要参与同步 —— 每次同步更新它，它就变了，于是每次 push 都产生新提交。挪到 `cloud-sync/last-sync.json` 之后才稳定。这个 bug 冒烟测试抓不到，端到端一跑就露出来了。

**为什么跳过符号链接**：`~/.dsh/skills` 指向 `~/git/skills`，那是一整个 git 仓库。跟随链接会把几百个文件拖进同步仓库。

## 边界

- **只处理 `~/.dsh` 内的文件**。IDE 的私有存储（Trae 的 `storage.json`、WorkBuddy 的 vault）不在同步范围，也不该由这个插件碰。
- **不合并冲突**。恢复是「用仓库覆盖本机」，不做三方合并 —— 配置文件的语义合并没法做对，不如让人自己决定。覆盖前有备份。
- **恢复后要重启**。DSH 在启动时读配置，热重载覆盖不到所有项。
- **token 存在 DSH 的凭据记录里**（`ctx.credentials` 的 `dsh-cloud-sync/github` 记录），不写在配置文件中。凭据服务缺席时才退回 `~/.dsh/cloud-sync/token.json`（0600）。
- **桌面端与 CLI 的 profile 不通用**：桌面端用 `desktop` profile。如果你同时用 CLI 的 `web` / `headless`，它们的 profile 补丁也会一起同步（都在 `profiles/` 下）。
- **浏览器里的偏好不在同步范围**：护眼模式的开关、对话宽度这类存在浏览器 `localStorage`（在 `~/Library/Application Support/@deepseek-ai/dsh-desktop/Local Storage`），那是 Electron 的站点数据，不是 DSH 的配置。换机器后会回到默认值，重新点一下就行。
- **`dsh-runtimes/` 不参与同步**：310 MB 的运行时（node / pnpm / python），DSH 首次启动会自己补。

## 开发

```sh
npm test        # 28 个冒烟测试，不联网
```

测试覆盖同步计划（上传 / 删除 / 未变）、路径分类、目录隔离、越界拦截、备份与幂等，
以及定时备份的排期计算（每日 / 间隔 / 每周，含周日映射）与调度循环的失败恢复。

目录结构：

```
index.js          Host 入口：挂服务、路由、工具
client.js         浏览器半边：「设置 → 云同步」页面
lib/config.js     配置读写与归一化
lib/github.js     GitHub REST 客户端（Git Data API）
lib/gitcli.js     本机 git 传输
lib/sync.js       同步引擎：收集、diff、推送、拉取
lib/service.js    业务编排，UI 与工具共用
lib/plugins-manifest.js  插件清单：依赖 → 可安装 spec 的反推
lib/pnpm.js       定位 DSH 自带的 pnpm 并执行安装
lib/schedule.js   定时备份的排期计算与调度循环
lib/tools.js      agent 工具
lib/api.js        HTTP 路由
```

## License

MIT
