import assert from "node:assert/strict"
import test from "node:test"
import { existsSync, readdirSync } from "node:fs"
import path from "node:path"
import type { SessionRetryDecision } from "@opencode/plugin/promise/session"
import { makeEnv, requestEvent, responseEvent, retryEvent } from "./harness.ts"
import { readState, writeState } from "../src/state.ts"

// 这组用例覆盖审计发现的「现有测试全都通过、但行为确实错了」的空档。
// 与 retry.test.ts 的设计契约用例互补：这里只断言插件不该越权干预。

test("T1 未注册 provider 的 400：不覆盖原生重试决策", async () => {
  const env = await makeEnv(["A", "B"])
  const native: SessionRetryDecision = { retry: true, delay: 1000 }
  const event = retryEvent({ providerID: "other", error: { status: 400 }, native })
  await env.retry.retry(event)
  assert.deepStrictEqual(event.decision, native, "插件没有接管这个 provider，不该改 decision")
})

test("T1 已注册 provider 但本轮无 round 的 400：不覆盖原生重试决策", async () => {
  const env = await makeEnv(["A", "B"])
  const native: SessionRetryDecision = { retry: true, delay: 1000 }
  // 不发 request / response，直接来一个 retry 事件（round 不存在）
  const event = retryEvent({ error: { status: 400 }, native })
  await env.retry.retry(event)
  assert.deepStrictEqual(event.decision, native)
})

test("T1 对照：插件确实接管本轮时的 400 仍然放弃重试（原有设计）", async () => {
  const env = await makeEnv(["A", "B"])
  const a = requestEvent({ headers: { authorization: "Bearer A" } })
  await env.retry.request(a)
  await env.retry.response(responseEvent(a, new Response("bad", { status: 400 })))
  const event = retryEvent({ error: { status: 400 } })
  await env.retry.retry(event)
  assert.deepStrictEqual(event.decision, { retry: false })
})

test("T2 全体 2xx 都要清理本轮状态，后续 retry 不被错误接管", async () => {
  for (const status of [200, 201, 202, 204, 206]) {
    const env = await makeEnv(["A", "B"])
    const a = requestEvent({ headers: { authorization: "Bearer A" } })
    await env.retry.request(a)
    // 204/205 不允许带 body
    const body = status === 204 || status === 205 ? null : "ok"
    await env.retry.response(responseEvent(a, new Response(body, { status })))

    const native: SessionRetryDecision = { retry: false }
    const event = retryEvent({ attempt: 2, error: { status: 500 }, native })
    await env.retry.retry(event)
    assert.deepStrictEqual(
      event.decision,
      native,
      `status=${status} 后 round 未清理，新一轮被上一轮状态接管`,
    )
  }
})

test("R3 状态写入原子：目标文件始终完整可读，且不残留 .tmp", async () => {
  const env = await makeEnv(["A"])
  for (const n of [1, 2, 3]) {
    const keys = ["A", "B", "C"].slice(0, n)
    writeState({ apiKeys: { p: keys }, isolated: {} }, env.file)
    assert.deepStrictEqual(readState(env.file)?.apiKeys.p, keys)
  }
  assert.equal(existsSync(`${env.file}.${process.pid}.tmp`), false)
  const leftovers = readdirSync(path.dirname(env.file)).filter((name) => name.endsWith(".tmp"))
  assert.deepStrictEqual(leftovers, [], "临时文件必须已被 rename 或清理")
})
