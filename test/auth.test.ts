import assert from "node:assert/strict"
import test from "node:test"
import { captureShapes, currentKey, readKey, writeKey } from "../src/auth.ts"

const headers = (values: Record<string, string>): Headers => new Headers(values)

test("readKey：只认配置列表内的 key", () => {
  const keys = ["A", "B"]
  assert.strictEqual(readKey(headers({ authorization: "Bearer A" }), keys), "A")
  assert.strictEqual(readKey(headers({ "x-api-key": "B" }), keys), "B")
  assert.strictEqual(readKey(headers({ authorization: "Bearer X" }), keys), undefined)
  assert.strictEqual(readKey(headers({}), keys), undefined)
})

test("currentKey：剥掉 scheme 后返回裸 token", () => {
  assert.strictEqual(currentKey(headers({ authorization: "Bearer A" })), "A")
  assert.strictEqual(currentKey(headers({ "x-api-key": "A" })), "A")
  assert.strictEqual(currentKey(headers({})), undefined)
})

test("captureShapes：记录认证头与 scheme 前缀", () => {
  assert.deepStrictEqual(captureShapes(headers({ authorization: "Bearer A" })), [
    { name: "authorization", prefix: "Bearer " },
  ])
  assert.deepStrictEqual(captureShapes(headers({ "x-api-key": "A" })), [
    { name: "x-api-key", prefix: "" },
  ])
  assert.deepStrictEqual(captureShapes(headers({ authorization: "Token A" })), [
    { name: "authorization", prefix: "Token " },
  ])
  assert.deepStrictEqual(captureShapes(headers({})), [])
})

test("writeKey：沿用原有 scheme 改写全部认证头", () => {
  const h = headers({ authorization: "Bearer A", "x-api-key": "A" })
  writeKey(h, "B", captureShapes(h))
  assert.strictEqual(h.get("authorization"), "Bearer B")
  assert.strictEqual(h.get("x-api-key"), "B")
})

test("writeKey：非 Bearer scheme 原样保留", () => {
  const h = headers({ authorization: "Token A" })
  writeKey(h, "B", captureShapes(h))
  assert.strictEqual(h.get("authorization"), "Token B")
})
