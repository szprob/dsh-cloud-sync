/**
 * 定时备份的调度。
 *
 * 只有三种周期，刻意不做 cron 表达式：备份配置这件事，用户想要的永远是
 * 「每天几点」「每隔多久」「每周几几点」这三个之一，多出来的表达力只会变成
 * 配置错误。
 *
 * 时间一律按**本机时区**解释（`Date` 的本地时间），因为「每天 21 点」对用户
 * 来说就是自己表上的 21 点，不是 UTC 的 21 点。
 */

/** 允许的周期类型。 */
export const SCHEDULE_MODES = ['off', 'daily', 'interval', 'weekly']

/** 「每隔 N 分钟」的取值范围：1 分钟到 1 周。 */
export const MIN_INTERVAL_MINUTES = 1
export const MAX_INTERVAL_MINUTES = 7 * 24 * 60

/** `setTimeout` 能接受的最大延迟（约 24.8 天）；超过要先截断再续接。 */
const MAX_TIMER_DELAY = 2_147_483_647

/** 默认调度配置：关闭。 */
export function defaultSchedule() {
  return {
    mode: 'off',
    /** `HH:MM`，daily / weekly 用。 */
    time: '21:00',
    /** 间隔分钟数，interval 用。 */
    minutes: 60,
    /** 1=周一 … 7=周日，weekly 用。 */
    weekday: 1,
  }
}

/** `HH:MM` 校验并规范化；不合法返回 undefined。 */
export function normalizeTime(value) {
  if (typeof value !== 'string') return undefined
  // 分钟也允许一位数（`9:5` = `09:05`）：界面上手填 9:5 是很自然的事。
  const match = /^(\d{1,2}):(\d{1,2})$/.exec(value.trim())
  if (match === null) return undefined
  const hour = Number(match[1])
  const minute = Number(match[2])
  if (!Number.isInteger(hour) || hour < 0 || hour > 23) return undefined
  if (!Number.isInteger(minute) || minute < 0 || minute > 59) return undefined
  return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`
}

/** 把任意读到的对象收敛成一份完整调度配置。 */
export function normalizeSchedule(raw) {
  const base = defaultSchedule()
  if (raw === null || raw === undefined || typeof raw !== 'object' || Array.isArray(raw)) return base
  const mode = SCHEDULE_MODES.includes(raw.mode) ? raw.mode : base.mode
  const time = normalizeTime(raw.time) ?? base.time
  const minutesRaw = Number(raw.minutes)
  const minutes = Number.isFinite(minutesRaw)
    ? Math.min(MAX_INTERVAL_MINUTES, Math.max(MIN_INTERVAL_MINUTES, Math.round(minutesRaw)))
    : base.minutes
  const weekdayRaw = Number(raw.weekday)
  const weekday = Number.isInteger(weekdayRaw) && weekdayRaw >= 1 && weekdayRaw <= 7 ? weekdayRaw : base.weekday
  return { mode, time, minutes, weekday }
}

/**
 * 算出下一次该跑的时间；`off` 返回 undefined。
 *
 * 规则：**严格晚于 `now`**。所以刚备份完（或刚打开 DSH）不会立刻再跑一次 ——
 * 开机补偿那种行为会让「今天已经备份过了」这件事变得不可预测。
 *
 * @param schedule - 已归一化的调度配置。
 * @param now - 当前时间。
 * @returns 下一次运行时刻。
 */
export function computeNextRun(schedule, now = new Date()) {
  const config = normalizeSchedule(schedule)
  if (config.mode === 'off') return undefined
  if (config.mode === 'interval') {
    return new Date(now.getTime() + config.minutes * 60_000)
  }

  const [hour, minute] = config.time.split(':').map(Number)
  const next = new Date(now.getTime())
  next.setHours(hour, minute, 0, 0)
  if (next.getTime() <= now.getTime()) next.setDate(next.getDate() + 1)

  if (config.mode === 'daily') return next

  // weekly：把 1..7（周一..周日）映射成 Date.getDay() 的 0..6（周日..周六）。
  const target = config.weekday === 7 ? 0 : config.weekday
  const delta = (target - next.getDay() + 7) % 7
  next.setDate(next.getDate() + delta)
  // 同一天但时刻已过，就要顺延一整周。
  if (next.getTime() <= now.getTime()) next.setDate(next.getDate() + 7)
  return next
}

/** 周期的一句话描述，给界面和工具输出用。 */
export function describeSchedule(schedule, labels = {}) {
  const config = normalizeSchedule(schedule)
  const weekdays = labels.weekdays ?? ['周一', '周二', '周三', '周四', '周五', '周六', '周日']
  if (config.mode === 'off') return labels.off ?? '关闭'
  if (config.mode === 'daily') return `${labels.dailyPrefix ?? '每天'} ${config.time}`
  if (config.mode === 'interval') return `${labels.intervalPrefix ?? '每隔'} ${config.minutes} ${labels.minutesUnit ?? '分钟'}`
  const day = weekdays[config.weekday - 1]
  // 「每周周一」读着别扭：前缀已经是「每周」，只在「周X」上取后一个字。
  const short = day.startsWith('周') && day.length === 2 ? day.slice(1) : day
  return `${labels.weeklyPrefix ?? '每周'}${short} ${config.time}`
}

/**
 * 一个到点就触发 `run` 的循环。
 *
 * 用最朴素的 `setTimeout` 而不是 `setInterval`：每次跑完重新按配置算下一次，
 * 这样「每隔 N 分钟」是从**上一次结束**起算的，不会因为一次慢同步把后面的
 * 全部挤在一起。定时器由调用方在插件卸载时 `stop()`。
 */
export class ScheduleRunner {
  constructor({ getSchedule, run, logger, now = () => new Date() }) {
    this.getSchedule = getSchedule
    this.run = run
    this.logger = logger
    this.now = now
    this.timer = undefined
    this.nextRunAt = undefined
    this.running = false
  }

  /** 按当前配置重新排一次；返回下一次运行时刻（`off` 时 undefined）。 */
  arm() {
    this.stop()
    const schedule = this.getSchedule()
    const next = computeNextRun(schedule, this.now())
    this.nextRunAt = next
    if (next === undefined) return undefined
    const delay = Math.max(0, Math.min(next.getTime() - this.now().getTime(), MAX_TIMER_DELAY))
    this.timer = setTimeout(() => { this.fire() }, delay)
    // unref：别因为这个定时器把进程（或测试）吊着不退出。
    this.timer.unref?.()
    return next
  }

  stop() {
    if (this.timer !== undefined) clearTimeout(this.timer)
    this.timer = undefined
    this.nextRunAt = undefined
  }

  /** 到点了：跑一次，然后不管成功失败都排下一次。 */
  async fire() {
    this.timer = undefined
    this.nextRunAt = undefined
    this.running = true
    try {
      await this.run()
    } catch (error) {
      this.logger?.warn?.('cloud-sync: 定时备份失败，等下一个周期再试')
      this.logger?.warn?.(error)
    } finally {
      this.running = false
      this.arm()
    }
  }
}
