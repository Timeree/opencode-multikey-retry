import assert from "node:assert/strict"
import test from "node:test"
import { delayMs, retryAfterMs } from "../src/shared.ts"

test("delayMs：1 × 1.2^(n-1)，上限 1200s", () => {
  assert.strictEqual(delayMs(1), 1000)
  assert.strictEqual(delayMs(2), 1200)
  assert.strictEqual(delayMs(3), 1440)
  assert.strictEqual(delayMs(4), 1728)
  assert.strictEqual(delayMs(10), 5160)
  assert.strictEqual(delayMs(15), 12839)
  assert.strictEqual(delayMs(20), 31948)
  assert.strictEqual(delayMs(38), 850562)
  assert.strictEqual(delayMs(40), 1200000)
  assert.strictEqual(delayMs(50), 1200000)
})

test("retryAfterMs：秒数与 HTTP 日期都换算为时长", () => {
  const headers = (value?: string) => (value === undefined ? new Headers() : new Headers({ "retry-after": value }))

  assert.strictEqual(retryAfterMs(headers("5")), 5000)
  assert.strictEqual(retryAfterMs(headers("0.5")), 500)

  const soon = new Date(Date.now() + 10_000).toUTCString()
  const got = retryAfterMs(headers(soon))
  assert.ok(got !== undefined && got > 9000 && got <= 10000, `HTTP 日期应换算为约 10s: ${got}`)

  assert.strictEqual(retryAfterMs(headers(undefined)), undefined)
  assert.strictEqual(retryAfterMs(headers("not-a-date")), undefined)

  const past = new Date(Date.now() - 1000).toUTCString()
  assert.strictEqual(retryAfterMs(headers(past)), undefined, "已过期的 Retry-After 回落")
})
