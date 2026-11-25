/**
 * 浏览器半边用的 HTTP 路由。
 *
 * 为什么不用 Remote / Typert：那条通道要求 host 侧与 client 侧都是编译产物并共享
 * 生成出来的 `/remote` 声明，第三方插件复刻不了。`ctx.webServer.register()` 是
 * 宿主公开的普通路由接缝，`dsh-connect-trae` 这些已装插件也在用，稳定且简单。
 *
 * 安全策略：
 *  - 只接受同源请求（`Origin` 必须等于 `Host`，或本机回环名）；
 *  - 写操作额外要求 `x-dsh-cloud-sync: 1` 头，挡掉跨站表单；
 *  - 路由挂在 `/plugins/dsh-cloud-sync/` 前缀下，不会和宿主的 `/api` 撞。
 */

const API_ROOT = '/plugins/dsh-cloud-sync'

/** 请求体上限：这里只有设置，16KB 足够。 */
const MAX_BODY_BYTES = 16 * 1024

function send(res, status, value) {
  const body = `${JSON.stringify(value)}\n`
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  })
  res.end(body)
}

function bareHostname(hostname) {
  return hostname.replace(/^\[|\]$/g, '').toLowerCase()
}

/** 同源判断：没有 Origin（curl / 同进程）放行，有则必须与 Host 一致或是本机名。 */
function sameOrigin(req) {
  const origin = req.headers.origin
  if (origin === undefined || origin.trim() === '') return true
  try {
    const url = new URL(origin)
    const hostname = bareHostname(url.hostname)
    if (hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1') return true
    const rawHost = req.headers.host
    if (typeof rawHost === 'string' && rawHost.trim() !== '') {
      return hostname === bareHostname(new URL(`http://${rawHost}`).hostname)
    }
    return false
  } catch {
    return false
  }
}

async function readJson(req) {
  let size = 0
  const chunks = []
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    size += buffer.length
    if (size > MAX_BODY_BYTES) throw new Error('请求体太大')
    chunks.push(buffer)
  }
  if (chunks.length === 0) return {}
  const value = JSON.parse(Buffer.concat(chunks).toString('utf8'))
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('请求体必须是 JSON 对象')
  return value
}

/** 只允许客户端改这几个字段，别的一概拒绝（包括 token —— 它走单独的路由）。 */
function pickConfigPatch(body) {
  const allowed = ['transport', 'repo', 'remoteUrl', 'branch', 'path', 'include', 'extraPaths', 'schedule']
  const unknown = Object.keys(body).filter((key) => !allowed.includes(key))
  if (unknown.length > 0) throw new Error(`未知字段：${unknown.join(', ')}`)
  const patch = {}
  if (body.transport !== undefined) {
    if (body.transport !== 'api' && body.transport !== 'git') throw new Error('transport 只能是 api 或 git')
    patch.transport = body.transport
  }
  if (body.remoteUrl !== undefined) {
    if (typeof body.remoteUrl !== 'string') throw new Error('remoteUrl 必须是字符串')
    patch.remoteUrl = body.remoteUrl
  }
  if (body.repo !== undefined) {
    if (typeof body.repo !== 'string') throw new Error('repo 必须是字符串')
    patch.repo = body.repo
  }
  if (body.branch !== undefined) {
    if (typeof body.branch !== 'string') throw new Error('branch 必须是字符串')
    patch.branch = body.branch
  }
  if (body.path !== undefined) {
    if (typeof body.path !== 'string') throw new Error('path 必须是字符串')
    patch.path = body.path
  }
  if (body.include !== undefined) {
    if (body.include === null || typeof body.include !== 'object' || Array.isArray(body.include)) {
      throw new Error('include 必须是对象')
    }
    patch.include = {}
    for (const [key, value] of Object.entries(body.include)) {
      if (typeof value !== 'boolean') throw new Error(`include.${key} 必须是布尔值`)
      patch.include[key] = value
    }
  }
  if (body.extraPaths !== undefined) {
    if (!Array.isArray(body.extraPaths) || body.extraPaths.some((item) => typeof item !== 'string')) {
      throw new Error('extraPaths 必须是字符串数组')
    }
    patch.extraPaths = body.extraPaths
  }
  if (body.schedule !== undefined) {
    const raw = body.schedule
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('schedule 必须是对象')
    const unknown = Object.keys(raw).filter((key) => !['mode', 'time', 'minutes', 'weekday'].includes(key))
    if (unknown.length > 0) throw new Error(`schedule 里有未知字段：${unknown.join(', ')}`)
    if (raw.mode !== undefined && !['off', 'daily', 'interval', 'weekly'].includes(raw.mode)) {
      throw new Error('schedule.mode 只能是 off / daily / interval / weekly')
    }
    if (raw.time !== undefined) {
      const time = typeof raw.time === 'string' ? /^(\d{1,2}):(\d{1,2})$/.exec(raw.time.trim()) : null
      if (time === null) throw new Error('schedule.time 要写成 HH:MM')
      const hour = Number(time[1])
      const minute = Number(time[2])
      if (hour > 23 || minute > 59) throw new Error('schedule.time 不是有效时刻（小时 0-23，分钟 0-59）')
    }
    if (raw.minutes !== undefined && !Number.isFinite(Number(raw.minutes))) throw new Error('schedule.minutes 必须是数字')
    if (raw.weekday !== undefined && ![1, 2, 3, 4, 5, 6, 7].includes(Number(raw.weekday))) {
      throw new Error('schedule.weekday 只能是 1（周一）到 7（周日）')
    }
    patch.schedule = raw
  }
  return patch
}

/**
 * 挂上全部路由，返回卸载函数。
 *
 * `service` 就是 CloudSyncService：路由层只做参数校验和错误翻译，
 * 业务全部在 service 里，和 agent 工具共用同一份实现。
 */
export function registerApi(ctx, service) {
  const disposers = []
  const dispose = () => {
    for (const fn of disposers) {
      try {
        fn()
      } catch {
        // 卸载时单个路由失败不影响其它路由。
      }
    }
  }

  disposers.push(ctx.webServer.register({
    kind: 'prefix',
    path: API_ROOT,
    handler: async (req, res) => {
      /**
       * 宿主自带的连接鉴权。
       *
       * 只能用 `ctx.get('connection')` 取，不能写 `ctx.connection`：Cordis 里访问
       * 没在 `inject` 声明过的服务名会直接抛错（实测表现为整个请求 400、body 空），
       * 而这个插件不想把 `connection` 设为硬依赖 —— headless 组合里可能没有它。
       */
      let rejection
      try {
        rejection = ctx.get('connection')?.requestRejection?.(req)
      } catch {
        rejection = undefined
      }
      if (rejection !== undefined) {
        send(res, rejection, { error: rejection === 401 ? '未授权' : '禁止访问' })
        return
      }
      if (!sameOrigin(req)) {
        send(res, 403, { error: '不允许跨源请求' })
        return
      }
      const method = req.method ?? 'GET'
      if (method !== 'GET' && req.headers['x-dsh-cloud-sync'] !== '1') {
        send(res, 403, { error: '缺少 x-dsh-cloud-sync 请求头' })
        return
      }
      const url = new URL(req.url ?? API_ROOT, 'http://localhost')
      const suffix = url.pathname.slice(API_ROOT.length) || '/'
      try {
        if (method === 'GET' && suffix === '/status') {
          send(res, 200, await service.status())
          return
        }
        if (method === 'POST' && suffix === '/config') {
          const body = await readJson(req)
          await service.save(pickConfigPatch(body))
          const status = await service.status()
          send(res, 200, { config: status.config })
          return
        }
        if (method === 'POST' && suffix === '/token') {
          const body = await readJson(req)
          if (body.token !== undefined && typeof body.token !== 'string') throw new Error('token 必须是字符串')
          const token = typeof body.token === 'string' ? body.token.trim() : ''
          if (token === '') {
            await service.clearToken()
            send(res, 200, { token: { configured: false, source: 'none' } })
            return
          }
          const source = await service.saveToken(token)
          send(res, 200, { token: { configured: true, source } })
          return
        }
        if (method === 'POST' && suffix === '/test') {
          send(res, 200, await service.test())
          return
        }
        if (method === 'POST' && suffix === '/preview') {
          send(res, 200, await service.preview())
          return
        }
        if (method === 'POST' && suffix === '/push') {
          const body = await readJson(req)
          if (body.message !== undefined && typeof body.message !== 'string') throw new Error('message 必须是字符串')
          send(res, 200, await service.push({ message: body.message }))
          return
        }
        if (method === 'POST' && suffix === '/pull') {
          send(res, 200, await service.pull())
          return
        }
        if (method === 'POST' && suffix === '/restore') {
          send(res, 200, await service.restore())
          return
        }
        send(res, 404, { error: '没有这个接口' })
      } catch (error) {
        send(res, 400, { error: error instanceof Error ? error.message : String(error), code: error?.code })
      }
    },
  }))

  return dispose
}
