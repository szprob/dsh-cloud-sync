/**
 * dsh-cloud-sync 的 Host 半边。
 *
 * 职责三件事：
 *  1. `CloudSyncService` —— 同步逻辑的唯一实现，网页按钮和模型工具共用；
 *  2. 在 `/plugins/dsh-cloud-sync/` 下挂 HTTP 路由，供浏览器半边调用；
 *  3. 注册 `cloud_sync_status` / `cloud_sync_backup` / `cloud_sync_restore` 三个工具。
 *
 * 依赖全部做成可选的：没有 `tools` 的宿主（纯 UI 场景）页面照样能用；
 * 没有 `webServer` 的宿主（headless）工具照样能用。
 */

import { CloudSyncService } from './lib/service.js'
import { registerApi } from './lib/api.js'
import { registerTools } from './lib/tools.js'

export const name = 'dsh-cloud-sync'

/** 只声明一定要有的服务；`tools` 走下面的可选注入。 */
export const inject = ['webServer']

export function apply(ctx) {
  const service = new CloudSyncService(ctx)

  // 路由是页面工作的前提，先挂。
  ctx.effect(() => registerApi(ctx, service), 'cloud-sync: http routes')

  /**
   * 工具是可选能力：`tools` 到位才注册。
   *
   * 一律走 `ctx.inject(['tools'], ...)` —— 不能用 `ctx.tools` 或 `ctx.get('tools')`
   * 在 apply 里探测：前者没 inject 声明会抛错，后者在 Cordis 里同样受 inject 约束
   * （实测 `cannot get property "tools" without inject`）。`ctx.inject` 是唯一
   * 合法的「就绪后再用」入口，服务缺席时它只是不触发。
   */
  ctx.inject(['tools'], (scope) => {
    scope.effect(() => registerTools(scope, service), 'cloud-sync: agent tools')
  })

  ctx.logger?.info?.('dsh-cloud-sync 已加载：/plugins/dsh-cloud-sync')
}
