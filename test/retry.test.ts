import assert from "node:assert/strict"
import test, { type TestContext } from "node:test"
import type { SessionHttpRequest, SessionRetryDecision } from "@opencode/plugin/promise/session"
import {
  captureWarn,
  makeEnv,
  requestEvent,
  responseEvent,
  retryEvent,
} from "./harness.ts"
import { Isolation } from "../src/isolation.ts"
import { readState } from "../src/state.ts"

const authOf = (event: SessionHttpRequest): string =>
  event.request.headers.get("authorization") ?? ""

/** 等步推进假时钟：步长固定为轮询间隔，并多走一步越过窗口边界。 */
const drain = async (context: TestContext, totalMs: number): Promise<void> => {
  for (let step = 0, steps = Math.ceil(totalMs / 300); step < steps; step += 1) {
    context.mock.timers.tick(300)
    await new Promise((resolve) => setImmediate(resolve))
  }
}

test("一轮的首个请求不经插件改写", async () => {
  const env = await makeEnv(["A", "B", "C"])
  const event = requestEvent({ headers: { authorization: "Bearer A" } })

  await env.retry.request(event)

  assert.strictEqual(authOf(event), "Bearer A")
})

test("500：接管重试并换下一个可用 key；其它 key 冷却顺延 1s", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] })
  const env = await makeEnv(["A", "B", "C"])
  const first = requestEvent({ headers: { authorization: "Bearer A" } })
  await env.retry.request(first)
  await env.retry.response(responseEvent(first, new Response("err", { status: 500 })))

  const decision = retryEvent()
  await env.retry.retry(decision)
  assert.deepStrictEqual(decision.decision, { retry: true, delay: 1000 }, "B、C 各顺延 1s")

  t.mock.timers.tick(2100)
  const second = requestEvent({ headers: { authorization: "Bearer A" } })
  await env.retry.request(second)
  assert.strictEqual(authOf(second), "Bearer B")
})

test("README 示例一：500 → 429(Retry-After) → 500，全部在同一轮", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] })
  const warns = captureWarn(t.mock)
  const env = await makeEnv(["A", "B", "C"])

  const a = requestEvent({ headers: { authorization: "Bearer A" } })
  await env.retry.request(a)
  await env.retry.response(responseEvent(a, new Response("err", { status: 500 })))
  await env.retry.retry(retryEvent({ error: { status: 500 } }))

  t.mock.timers.tick(1100)
  const b = requestEvent({ headers: { authorization: "Bearer A" } })
  await env.retry.request(b)
  assert.strictEqual(authOf(b), "Bearer B")
  await env.retry.response(
    responseEvent(b, new Response("err", { status: 429, headers: { "retry-after": "7" } })),
  )
  await env.retry.retry(retryEvent({ attempt: 3, error: { status: 429 } }))

  t.mock.timers.tick(1100)
  const c = requestEvent({ headers: { authorization: "Bearer A" } })
  await env.retry.request(c)
  assert.strictEqual(authOf(c), "Bearer C")
  await env.retry.response(responseEvent(c, new Response("err", { status: 500 })))

  // 池内全部在冷却：#2 的倒计时来自 Retry-After（7s）加顺延，#1 被顺延两次后最早到期
  const decision = retryEvent({ attempt: 4, error: { status: 500 } })
  await env.retry.retry(decision)
  assert.deepStrictEqual(decision.decision, { retry: true, delay: 2800 }, "A 最早到期")
  assert.ok(
    warns.some((line) => line.includes("next attempt in 2.8s") && line.includes("#2 6.9s left")),
    `Retry-After 应反映在倒计时里: ${warns.join(" | ")}`,
  )

  // 等待由原生调度承担：到期后重试请求到来，插件立刻换上第一个可用 key
  await drain(t, 2900)
  const retried = requestEvent({ headers: { authorization: "Bearer C" } })
  await env.retry.request(retried)
  assert.strictEqual(authOf(retried), "Bearer A", "A 先到期，先恢复使用")
})

test("401：置 -1、持久隔离、跨轮剔除", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] })
  const env = await makeEnv(["A", "B", "C"])

  const a = requestEvent({ headers: { authorization: "Bearer A" } })
  await env.retry.request(a)
  await env.retry.response(responseEvent(a, new Response("err", { status: 401 })))
  await env.retry.retry(retryEvent({ error: { status: 401 } }))

  const b = requestEvent({ headers: { authorization: "Bearer B" } })
  await env.retry.request(b)
  assert.strictEqual(authOf(b), "Bearer B")
  await env.retry.response(responseEvent(b, new Response("ok", { status: 200 })))

  assert.ok(env.isolation.has("p", "A"))
  const state = readState(env.file)
  assert.deepStrictEqual(state?.isolated.p, ["A"], "隔离写入独立配置文件")

  // 下一轮：池 = [B, C]，A 不再被选取
  const next = requestEvent({ headers: { authorization: "Bearer A" } })
  await env.retry.request(next)
  await env.retry.response(responseEvent(next, new Response("err", { status: 500 })))
  await env.retry.retry(retryEvent({ attempt: 2 }))

  t.mock.timers.tick(2100)
  const rotated = requestEvent({ headers: { authorization: "Bearer A" } })
  await env.retry.request(rotated)
  assert.strictEqual(authOf(rotated), "Bearer B")
})

test("401 隔离在进程外也保留（重新加载）", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] })
  const env = await makeEnv(["A", "B"])

  const a = requestEvent({ headers: { authorization: "Bearer A" } })
  await env.retry.request(a)
  await env.retry.response(responseEvent(a, new Response("err", { status: 401 })))
  await env.retry.retry(retryEvent({ error: { status: 401 } }))

  const reloaded = new Isolation(readState(env.file)?.isolated ?? {}, env.file)
  assert.ok(reloaded.has("p", "A"))
  assert.ok(!reloaded.has("p", "B"))
})

test("池不足 2：401 照样隔离，但失败交还原生", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] })
  const env = await makeEnv(["A", "B"])

  const a = requestEvent({ headers: { authorization: "Bearer A" } })
  await env.retry.request(a)
  await env.retry.response(responseEvent(a, new Response("err", { status: 401 })))
  await env.retry.retry(retryEvent({ error: { status: 401 } }))

  const b = requestEvent({ headers: { authorization: "Bearer B" } })
  await env.retry.request(b)
  assert.strictEqual(authOf(b), "Bearer B")
  await env.retry.response(responseEvent(b, new Response("err", { status: 401 })))

  const native: SessionRetryDecision = { retry: false }
  const event = retryEvent({ attempt: 3, error: { status: 401 }, native })
  await env.retry.retry(event)
  assert.deepStrictEqual(event.decision, { retry: false }, "交还原生时不改 decision")
  assert.ok(env.isolation.has("p", "B"))
})

test("400：断开并抛出，本轮结束", async () => {
  const env = await makeEnv(["A", "B"])

  const a = requestEvent({ headers: { authorization: "Bearer A" } })
  await env.retry.request(a)
  await env.retry.response(responseEvent(a, new Response("bad", { status: 400 })))

  const event = retryEvent({ error: { status: 400 } })
  await env.retry.retry(event)
  assert.deepStrictEqual(event.decision, { retry: false })

  const decision = retryEvent()
  await env.retry.retry(decision)
  assert.strictEqual(env.isolation.has("p", "A"), false)
})

test("网络错误：退避记在失败 key 上，等它到期再用它重发", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] })
  const warns = captureWarn(t.mock)
  const env = await makeEnv(["A", "B"])

  const a = requestEvent({ headers: { authorization: "Bearer A" } })
  await env.retry.request(a)
  const decision = retryEvent({ error: { type: "provider.transport", status: undefined } })
  await env.retry.retry(decision)
  assert.deepStrictEqual(decision.decision, { retry: true, delay: 3000 })
  assert.ok(
    warns.some((line) => line.includes("transport error; retrying the same key in 3.0s")),
    `决策时应输出一次倒计时: ${warns.join(" | ")}`,
  )

  // 兜底：原生提前发来请求时，插件在请求侧等到到期才放行
  await drain(t, 2700)
  const early = requestEvent({ headers: { authorization: "Bearer A" } })
  let done = false
  const pending = env.retry.request(early).then(() => {
    done = true
    return early
  })
  t.mock.timers.tick(150)
  assert.strictEqual(done, false, "冷却未到不把请求放行")
  assert.strictEqual(authOf(early), "Bearer A")

  await drain(t, 450)
  const retried = await pending
  assert.strictEqual(done, true)
  assert.strictEqual(authOf(retried), "Bearer A", "到期后仍用原来的 key 重发")
})

test("池内没有可用 key：把等待交给原生调度并列出剩余时间", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] })
  const warns = captureWarn(t.mock)
  const env = await makeEnv(["A", "B", "C"])

  let attempt = 2
  for (const key of ["A", "B"]) {
    const event = requestEvent({ headers: { authorization: `Bearer ${key}` } })
    await env.retry.request(event)
    await env.retry.response(responseEvent(event, new Response("err", { status: 500 })))
    await env.retry.retry(retryEvent({ attempt, error: { status: 500 } }))
    attempt += 1
    t.mock.timers.tick(1100)
  }

  const c = requestEvent({ headers: { authorization: "Bearer B" } })
  await env.retry.request(c)
  assert.strictEqual(authOf(c), "Bearer C")
  await env.retry.response(responseEvent(c, new Response("err", { status: 500 })))

  const decision = retryEvent({ attempt, error: { status: 500 } })
  await env.retry.retry(decision)
  assert.deepStrictEqual(decision.decision, { retry: true, delay: 2800 })

  assert.ok(
    warns.some((line) =>
      line.includes(
        "[opencode-multikey-retry] p has no usable key; next attempt in 2.8s\n" +
          "  #1 2.8s left\n" +
          "  #2 4.4s left\n" +
          "  #3 6.8s left",
      ),
    ),
    `等待列表格式不符: ${warns.join(" | ")}`,
  )
  assert.ok(!warns.join("\n").includes("Bearer"), "输出不得包含 key 内容")

  await drain(t, 2900)
  const retried = requestEvent({ headers: { authorization: "Bearer C" } })
  await env.retry.request(retried)
  assert.strictEqual(authOf(retried), "Bearer A", "A 先到期，先恢复使用")
})

test("隔离的 key 在等待列表中显示 isolated", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] })
  const warns = captureWarn(t.mock)
  const env = await makeEnv(["A", "B", "C"], { isolated: ["C"] })

  const a = requestEvent({ headers: { authorization: "Bearer A" } })
  await env.retry.request(a)
  await env.retry.response(responseEvent(a, new Response("err", { status: 500 })))
  await env.retry.retry(retryEvent({ error: { status: 500 } }))

  t.mock.timers.tick(1100)
  const b = requestEvent({ headers: { authorization: "Bearer B" } })
  await env.retry.request(b)
  assert.strictEqual(authOf(b), "Bearer B")
  await env.retry.response(responseEvent(b, new Response("err", { status: 500 })))

  const decision = retryEvent({ attempt: 3, error: { status: 500 } })
  await env.retry.retry(decision)
  assert.deepStrictEqual(decision.decision, { retry: true, delay: 2900 })
  assert.ok(
    warns.some((line) => line.includes("#3 isolated")),
    `隔离 key 应显示 isolated: ${warns.join(" | ")}`,
  )

  await drain(t, 3000)
  const retried = requestEvent({ headers: { authorization: "Bearer B" } })
  await env.retry.request(retried)
  assert.strictEqual(authOf(retried), "Bearer A")
})

test("跨模型调用冷却不累积：stale pending 后由 attempt 回落重置", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] })
  const warns = captureWarn(t.mock)
  const env = await makeEnv(["A", "B"])

  // 第一轮：A 500 → 接管换 B；B 404 → 交还原生，原生放弃
  const a = requestEvent({ headers: { authorization: "Bearer A" } })
  await env.retry.request(a)
  await env.retry.response(responseEvent(a, new Response("err", { status: 500 })))
  await env.retry.retry(retryEvent({ attempt: 2 }))

  t.mock.timers.tick(1100)
  const b = requestEvent({ headers: { authorization: "Bearer B" } })
  await env.retry.request(b)
  assert.strictEqual(authOf(b), "Bearer B")
  await env.retry.response(responseEvent(b, new Response("nope", { status: 404 })))
  const native: SessionRetryDecision = { retry: true, delay: 4000 }
  const handback = retryEvent({ attempt: 3, error: { status: 404 }, native })
  await env.retry.retry(handback)
  assert.deepStrictEqual(handback.decision, { retry: true, delay: 4000 })

  // 新一轮：首个请求仍带 A，失败后 backoff 必须从 3s 重新起算
  const next = requestEvent({ headers: { authorization: "Bearer A" } })
  await env.retry.request(next)
  await env.retry.response(responseEvent(next, new Response("err", { status: 500 })))
  const fresh = retryEvent({ attempt: 2, error: { status: 500 } })
  await env.retry.retry(fresh)
  assert.deepStrictEqual(fresh.decision, { retry: true, delay: 1000 })
  assert.ok(
    warns.some((line) => line.includes("#1 3.0s left") && line.includes("#2 1.0s left")),
    `新一轮退避应从 3s 重新起算: ${warns.join(" | ")}`,
  )

  t.mock.timers.tick(1100)
  const then = requestEvent({ headers: { authorization: "Bearer A" } })
  await env.retry.request(then)
  assert.strictEqual(authOf(then), "Bearer B")
  await env.retry.response(responseEvent(then, new Response("err", { status: 500 })))
  const decision = retryEvent({ attempt: 3, error: { status: 500 } })
  await env.retry.retry(decision)
  assert.deepStrictEqual(decision.decision, { retry: true, delay: 2900 })

  await drain(t, 3000)
  const retried = requestEvent({ headers: { authorization: "Bearer B" } })
  await env.retry.request(retried)
  assert.strictEqual(authOf(retried), "Bearer A")
})

test("等待被取消后开始的新一轮：首个请求不经插件改写", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] })
  const env = await makeEnv(["A", "B"])

  // 第一轮：A 500 → 换 B；B 500 → 全池冷却，交给原生调度等
  const a = requestEvent({ headers: { authorization: "Bearer A" } })
  await env.retry.request(a)
  await env.retry.response(responseEvent(a, new Response("err", { status: 500 })))
  await env.retry.retry(retryEvent({ attempt: 2, error: { status: 500 } }))

  t.mock.timers.tick(1100)
  const b = requestEvent({ headers: { authorization: "Bearer B" } })
  await env.retry.request(b)
  assert.strictEqual(authOf(b), "Bearer B")
  await env.retry.response(responseEvent(b, new Response("err", { status: 500 })))
  const wait = retryEvent({ attempt: 3, error: { status: 500 } })
  await env.retry.retry(wait)
  assert.deepStrictEqual(wait.decision, { retry: true, delay: 2900 })

  // 原生等待被取消（100ms 时）：此后新一轮的首个请求应原样放行
  t.mock.timers.tick(100)
  const fresh = requestEvent({ headers: { authorization: "Bearer A" } })
  await env.retry.request(fresh)
  assert.strictEqual(authOf(fresh), "Bearer A")

  // 且旧冷却已清除：再失败时按新一轮起算，B 只顺延 1s，而不是等旧冷却
  await env.retry.response(responseEvent(fresh, new Response("err", { status: 500 })))
  const decision = retryEvent({ attempt: 2, error: { status: 500 } })
  await env.retry.retry(decision)
  assert.deepStrictEqual(decision.decision, { retry: true, delay: 1000 }, "新一轮 1s 后换 B")

  t.mock.timers.tick(1100)
  const retried = requestEvent({ headers: { authorization: "Bearer A" } })
  await env.retry.request(retried)
  assert.strictEqual(authOf(retried), "Bearer B")
})

test("未处理状态交还原生，且本轮冷却保留", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] })
  const env = await makeEnv(["A", "B", "C"])

  const a = requestEvent({ headers: { authorization: "Bearer A" } })
  await env.retry.request(a)
  await env.retry.response(responseEvent(a, new Response("err", { status: 500 })))
  await env.retry.retry(retryEvent({ attempt: 2 }))

  t.mock.timers.tick(2100)
  const b = requestEvent({ headers: { authorization: "Bearer B" } })
  await env.retry.request(b)
  await env.retry.response(responseEvent(b, new Response("nope", { status: 404 })))
  const native: SessionRetryDecision = { retry: true, delay: 1000 }
  const handback = retryEvent({ attempt: 3, error: { status: 404 }, native })
  await env.retry.retry(handback)
  assert.deepStrictEqual(handback.decision, { retry: true, delay: 1000 })

  // 原生重试用 B，失败后从 B 的下一个继续轮换
  const bRetry = requestEvent({ headers: { authorization: "Bearer B" } })
  await env.retry.request(bRetry)
  assert.strictEqual(authOf(bRetry), "Bearer B")
  await env.retry.response(responseEvent(bRetry, new Response("err", { status: 500 })))
  await env.retry.retry(retryEvent({ attempt: 4 }))

  t.mock.timers.tick(2100)
  const c = requestEvent({ headers: { authorization: "Bearer C" } })
  await env.retry.request(c)
  assert.strictEqual(authOf(c), "Bearer C")
})

test("列表外 key 的 401：本轮接管但不持久隔离", async () => {
  const env = await makeEnv(["A", "B", "C"])

  const x = requestEvent({ headers: { authorization: "Bearer X" } })
  await env.retry.request(x)
  await env.retry.response(responseEvent(x, new Response("err", { status: 401 })))
  await env.retry.retry(retryEvent({ error: { status: 401 } }))

  const rotated = requestEvent({ headers: { authorization: "Bearer X" } })
  await env.retry.request(rotated)
  assert.strictEqual(authOf(rotated), "Bearer A", "从列表第一个开始")
  assert.strictEqual(env.isolation.has("p", "X"), false)
})

test("取消信号：立即放行未改写的请求", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] })
  const env = await makeEnv(["A", "B", "C"])

  let attempt = 2
  for (const key of ["A", "B", "C"]) {
    const event = requestEvent({ headers: { authorization: `Bearer ${key}` } })
    await env.retry.request(event)
    await env.retry.response(responseEvent(event, new Response("err", { status: 500 })))
    await env.retry.retry(retryEvent({ attempt, error: { status: 500 } }))
    attempt += 1
    t.mock.timers.tick(2100)
  }

  // 全池冷却，原生调度等待中；等待窗口内请求带着已取消的信号到来
  t.mock.timers.tick(2700)
  const controller = new AbortController()
  controller.abort()
  const aborted = requestEvent({
    headers: { authorization: "Bearer A" },
    signal: controller.signal,
  })
  await env.retry.request(aborted)
  assert.strictEqual(authOf(aborted), "Bearer A")
})

test("Retry-After 按服务端给出的值使用，不套退避上限", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] })
  const warns = captureWarn(t.mock)
  const env = await makeEnv(["A", "B"])

  const a = requestEvent({ headers: { authorization: "Bearer A" } })
  await env.retry.request(a)
  await env.retry.response(
    responseEvent(a, new Response("err", { status: 429, headers: { "retry-after": "7200" } })),
  )
  await env.retry.retry(retryEvent({ error: { status: 429 } }))

  t.mock.timers.tick(2100)
  const b = requestEvent({ headers: { authorization: "Bearer B" } })
  await env.retry.request(b)
  await env.retry.response(responseEvent(b, new Response("err", { status: 500 })))
  const decision = retryEvent({ attempt: 3, error: { status: 500 } })
  await env.retry.retry(decision)
  assert.deepStrictEqual(decision.decision, { retry: true, delay: 4500 }, "等待到 B 的 4.5s，不是 A 的 2h")
  assert.ok(
    warns.some((line) => line.includes("#1 7198.9s left") && line.includes("#2 4.5s left")),
    `上限只作用于回退退避，不截断 Retry-After: ${warns.join(" | ")}`,
  )

  await drain(t, 4800)
  const retried = requestEvent({ headers: { authorization: "Bearer B" } })
  await env.retry.request(retried)
  assert.strictEqual(authOf(retried), "Bearer B")
})

test("非 primary 请求与未注册 provider 完全不受影响", async () => {
  const env = await makeEnv(["A", "B"])

  for (const kind of ["compaction", "title", "generate"] as const) {
    const event = requestEvent({ headers: { authorization: "Bearer A" }, kind })
    await env.retry.request(event)
    await env.retry.response(responseEvent(event, new Response("err", { status: 500 })))
    await env.retry.retry(retryEvent({ attempt: 2 }))
    assert.strictEqual(authOf(event), "Bearer A")
  }

  const other = requestEvent({ headers: { authorization: "Bearer A" }, providerID: "other" })
  await env.retry.request(other)
  await env.retry.response(responseEvent(other, new Response("err", { status: 500 })))
  await env.retry.retry(retryEvent({ providerID: "other", attempt: 2 }))
  assert.strictEqual(authOf(other), "Bearer A")
})
