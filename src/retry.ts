import type {
  SessionHttpRequest,
  SessionHttpResponse,
  SessionRetry,
} from "@opencode/plugin/promise/session"
import { captureShapes, currentKey, readKey, writeKey } from "./auth.ts"
import type { Isolation } from "./isolation.ts"
import {
  BUMP_MS,
  FAKE_TOOL_CALL_AFTER,
  MAX_ROUNDS,
  MIN_FAKE_INTERVAL_MS,
  POLL_MS,
  ROUND_TTL_MS,
  TRANSPORT,
  delayMs,
  fakeToolCallResponse,
  handled,
  log,
  retryAfterMs,
  sleep,
} from "./shared.ts"

type Mode =
  | { readonly kind: "rotate"; readonly from?: string }
  | { readonly kind: "pin"; readonly key: string }

interface Round {
  readonly providerID: string
  readonly keys: string[]
  readonly cooldown: Map<string, number>
  n: number
  attempt: number
  current?: string
  mode?: Mode
  /** 当前请求已交给原生重试，尚未收到响应。 */
  pending: boolean
  /** 已进入伪造续跑模式：不再因 attempt 回落重置，直到真实 2xx 或超时。 */
  fake?: boolean
  retryAfter?: number
  waitUntil?: number
  lastAt: number
}

const AUTH = new Set([401, 403])

export class Retry {
  private readonly rounds = new Map<string, Round>()
  private readonly providers: Map<string, string[]>
  private readonly isolation: Isolation
  /** 上次伪造空指令的时间，避免死配额下每秒刷一个空回合。 */
  private lastFakeAt = 0

  constructor(providers: Map<string, string[]>, isolation: Isolation) {
    this.providers = providers
    this.isolation = isolation
  }

  request = async (event: SessionHttpRequest): Promise<void> => {
    if (event.kind !== "primary") return
    if (!this.providers.has(event.model.providerID)) return

    const id = this.id(event.sessionID, event.model.providerID, event.model.id)
    const now = Date.now()

    let round = this.rounds.get(id)
    if (round === undefined || this.expired(round, now)) {
      round = this.create(event.model.providerID)
      this.rounds.set(id, round)
      this.trim(now)
    } else if (!round.pending && round.fake !== true) {
      this.reset(round)
    }

    const shapes = captureShapes(event.request.headers)
    const mode = round.mode

    // 早于排定时刻到来的请求：上一次等待已被取消，这是新一轮模型调用
    const stale = mode !== undefined && now < (round.waitUntil ?? 0) - POLL_MS
    if (stale && round.fake !== true) this.reset(round)

    round.mode = undefined
    round.waitUntil = undefined
    round.pending = false
    round.lastAt = now
    round.current =
      readKey(event.request.headers, round.keys) ?? currentKey(event.request.headers)

    if (mode === undefined || stale) return
    if (shapes.length === 0) return

    const key =
      mode.kind === "rotate"
        ? await this.rotateTo(round, mode.from, event.request.signal)
        : await this.pinTo(round, mode.key, event.request.signal)

    if (key === undefined) return

    writeKey(event.request.headers, key, shapes)
    round.current = key
  }

  response = async (event: SessionHttpResponse): Promise<void> => {
    if (event.kind !== "primary") return
    if (!this.providers.has(event.model.providerID)) return

    const id = this.id(event.sessionID, event.model.providerID, event.model.id)
    const round = this.rounds.get(id)

    // 连续第 N 次 429：把响应替换为一个空 tool_call（shell 空字符串，无副作用），
    // runner 会照常执行并把结果写回，自动进入下一轮，从而不走到 12 次的原生上限。
    // 注意：不删除 round，并标记 pending——下一轮的请求要继承重试次数与冷却记录，
    // 而不是每轮重新起算 10 次。真实 2xx 才会清理 round。
    if (
      event.response.status === 429 &&
      round !== undefined &&
      round.n + 1 >= FAKE_TOOL_CALL_AFTER &&
      Date.now() - this.lastFakeAt >= MIN_FAKE_INTERVAL_MS
    ) {
      this.lastFakeAt = Date.now()
      round.pending = true
      round.fake = true
      round.lastAt = Date.now()
      log(`${event.model.providerID} 第 ${round.n + 1} 次 429，伪造空 tool_call，跳过重试上限`)
      event.response = fakeToolCallResponse(event.model.id)
      return
    }

    if (round === undefined) return

    round.lastAt = Date.now()

    const status = event.response.status
    // 成功不只有 200：201/202/204/206 等都代表本轮已经结束，必须同样清理
    // round，否则紧接着的 retry 事件会错误地沿用上一轮的状态。
    if (status >= 200 && status < 300) {
      this.rounds.delete(id)
      return
    }

    if (!handled(status)) return

    round.retryAfter = retryAfterMs(event.response.headers)
  }

  retry = async (event: SessionRetry): Promise<void> => {
    // 与 request/response 保持一致：插件没有接管这个 provider、或本轮没有
    // round 时，绝不改动原生决策。400 分支原先排在这些检查之前，会把
    // 未注册 provider 的「重试」也强行改成「放弃」。
    if (!this.providers.has(event.model.providerID)) return
    const rid = `${event.model.providerID}/${event.model.id}`
    log(`retry 触发: ${rid} status=${event.error.status} type=${event.error.type} attempt=${event.attempt}`)
    const id = this.id(event.sessionID, event.model.providerID, event.model.id)
    const round = this.rounds.get(id)
    if (round === undefined) {
      log(`retry 触发: ${rid} → 无本轮状态，交还原生`)
      return
    }

    const status = event.error.status

    if (status === 400 || event.error.type === "provider.invalid-request") {
      this.rounds.delete(id)
      event.decision = { retry: false }
      return
    }

    round.lastAt = Date.now()

    // attempt 回落说明上一轮已结束（原生放弃、被取消等）：丢弃旧退避，从本轮重新起算。
    // 伪造续跑模式例外：必须把 n 和冷却记录继承到后续轮次。
    if (event.attempt <= round.attempt && round.fake !== true) this.reset(round)
    round.attempt = event.attempt

    const retryAfter = round.retryAfter ?? event.error.retryAfterMs
    round.retryAfter = undefined

    const key = round.current

    // 未收到响应、且不是传输类失败（取消、凭据解析等）：不判定、不计数
    if (status === undefined && !TRANSPORT.has(event.error.type)) {
      log(`retry 判定: ${rid} → 无响应且非传输类，交还原生`)
      this.handback(round)
      return
    }

    round.n += 1

    // 状态处理表以外的失败：不设冷却，交还原生
    if (status !== undefined && !handled(status)) {
      log(`retry 判定: ${rid} → 未处理状态，交还原生`)
      this.handback(round)
      return
    }

    if (await this.apply(round, status, key, retryAfter)) {
      log(`retry 判定: ${rid} → 可用 key 不足，交还原生`)
      this.handback(round)
      return
    }

    const mode: Mode =
      status === undefined && key !== undefined ? { kind: "pin", key } : { kind: "rotate", from: key }
    const delay = this.waitMs(round, mode)

    round.mode = mode
    round.waitUntil = Date.now() + delay
    round.pending = true
    event.decision = { retry: true, delay }
    log(`retry 判定: ${rid} → 接管重试，delay=${delay}ms (第 ${round.n} 次失败)`)

    if (delay > 0) this.reportWait(round, mode, delay)
  }

  /** 目标 key 距可用还要多久；有可用 key 时为 0。 */
  private waitMs(round: Round, mode: Mode): number {
    const now = Date.now()

    if (mode.kind === "pin") {
      const until = round.cooldown.get(mode.key)
      return until === undefined ? 0 : Math.max(0, until - now)
    }

    let earliest = Infinity
    for (const key of this.pool(round)) {
      const until = round.cooldown.get(key)
      if (until === undefined || until <= now) return 0
      earliest = Math.min(earliest, until - now)
    }

    return earliest === Infinity ? 0 : earliest
  }

  /** 等待时把倒计时写到服务端日志，精确到 0.1s；可见的进度条由原生调度负责。 */
  private reportWait(round: Round, mode: Mode, delay: number): void {
    if (mode.kind === "pin") {
      log(
        `${round.providerID} transport error; retrying the same key in ${(delay / 1000).toFixed(1)}s`,
      )
      return
    }

    const now = Date.now()
    const lines = round.keys.map((key, index) => {
      if (this.isolation.has(round.providerID, key)) return `  #${index + 1} isolated`

      const until = round.cooldown.get(key) ?? now
      return `  #${index + 1} ${(Math.max(0, until - now) / 1000).toFixed(1)}s left`
    })

    log(
      `${round.providerID} has no usable key; next attempt in ${(delay / 1000).toFixed(1)}s\n${lines.join("\n")}`,
    )
  }

  /** 记退避与隔离；返回 true 表示这次失败交还原生逻辑。 */
  private apply = async (
    round: Round,
    status: number | undefined,
    key: string | undefined,
    retryAfter: number | undefined,
  ): Promise<boolean> => {
    // 池大小按本次失败发生前的隔离记录计算，新隔离在判定之后才写入
    const pre = this.pool(round).length

    if (status !== undefined && AUTH.has(status)) {
      if (key !== undefined) round.cooldown.set(key, -1)
      if (key !== undefined && round.keys.includes(key)) {
        await this.isolation.add(round.providerID, key)
      }
      return pre < 2
    }

    if (pre < 2) return true

    // 429 且没有 Retry-After：与其它可处理的失败一样按 delayMs 指数退避
    const wait = status === 429 ? retryAfter ?? delayMs(round.n) : delayMs(round.n)
    const now = Date.now()
    if (key !== undefined) round.cooldown.set(key, now + wait)

    // 退避顺延整池：其它 key 至少再冷却 1s，避免立刻用下一个 key 撞上去
    for (const other of this.pool(round)) {
      if (other === key) continue
      round.cooldown.set(other, Math.max(round.cooldown.get(other) ?? now, now) + BUMP_MS)
    }
    return false
  }

  private handback(round: Round): void {
    round.pending = true
    round.mode = undefined
  }

  private rotateTo = async (
    round: Round,
    from: string | undefined,
    signal: AbortSignal,
  ): Promise<string | undefined> => {
    let logged = false

    while (!signal.aborted) {
      const key = this.firstUsable(round, from)
      if (key !== undefined) return key
      if (this.pool(round).length === 0) return undefined

      // 兜底：原生提前发出重试请求时，在这里等到 key 可用
      if (!logged) {
        logged = true
        const mode: Mode = { kind: "rotate", from }
        this.reportWait(round, mode, this.waitMs(round, mode))
      }

      await sleep(POLL_MS, signal)
    }

    return undefined
  }

  private pinTo = async (
    round: Round,
    key: string,
    signal: AbortSignal,
  ): Promise<string | undefined> => {
    while (!signal.aborted) {
      const until = round.cooldown.get(key)
      if (until === -1) return undefined
      if (until === undefined || until <= Date.now()) return key

      await sleep(Math.min(POLL_MS, until - Date.now()), signal)
    }

    return undefined
  }

  private firstUsable(round: Round, from?: string): string | undefined {
    const list = this.pool(round)
    if (list.length === 0) return undefined

    const index = from === undefined ? -1 : list.indexOf(from)
    const start = index === -1 ? 0 : (index + 1) % list.length

    for (let step = 0; step < list.length; step += 1) {
      const key = list[(start + step) % list.length]
      const until = round.cooldown.get(key)
      if (until === undefined || until <= Date.now()) return key
    }

    return undefined
  }

  private pool(round: Round): string[] {
    return round.keys.filter((key) => !this.isolation.has(round.providerID, key))
  }

  private id(sessionID: string, providerID: string, modelID: string): string {
    return `${sessionID}:${providerID}/${modelID}`
  }

  private create(providerID: string): Round {
    return {
      providerID,
      keys: [...(this.providers.get(providerID) ?? [])],
      cooldown: new Map(),
      n: 0,
      attempt: 0,
      current: undefined,
      mode: undefined,
      pending: false,
      retryAfter: undefined,
      waitUntil: undefined,
      lastAt: Date.now(),
    }
  }

  private reset(round: Round): void {
    round.cooldown.clear()
    round.n = 0
    round.mode = undefined
    round.retryAfter = undefined
    round.waitUntil = undefined
  }

  private expired(round: Round, now: number): boolean {
    return now - Math.max(round.lastAt, round.waitUntil ?? 0) > ROUND_TTL_MS
  }

  private trim(now: number): void {
    for (const [id, round] of this.rounds) {
      if (this.expired(round, now)) this.rounds.delete(id)
    }

    while (this.rounds.size > MAX_ROUNDS) {
      const first = this.rounds.keys().next()
      if (first.done) return
      this.rounds.delete(first.value)
    }
  }
}
