import assert from "node:assert/strict"
import test from "node:test"
import { readApiKeys } from "../src/config.ts"

test("少于 2 个 key 的 provider 不注册", () => {
  assert.strictEqual(readApiKeys({ p: ["A"] }).size, 0)
  assert.strictEqual(readApiKeys({ p: [] }).size, 0)
  assert.strictEqual(readApiKeys({ p: ["A", "B"] }).size, 1)
})

test("非字符串、空白与重复条目都被剔除", () => {
  const result = readApiKeys({ p: ["A", " A ", "A", "  ", "", 12, null, "B"] })
  assert.deepStrictEqual(result.get("p"), ["A", "B"])
})

test("apiKeys 结构不合法时返回空映射", () => {
  assert.strictEqual(readApiKeys(undefined).size, 0)
  assert.strictEqual(readApiKeys(null).size, 0)
  assert.strictEqual(readApiKeys([]).size, 0)
  assert.strictEqual(readApiKeys("nope").size, 0)
})

test("多个 provider 各自解析", () => {
  const result = readApiKeys({
    alpha: ["sk-1", "sk-2"],
    beta: ["sk-3", "sk-4", "sk-5"],
    tiny: ["solo"],
  })
  assert.deepStrictEqual([...result.keys()], ["alpha", "beta"])
  assert.deepStrictEqual(result.get("beta"), ["sk-3", "sk-4", "sk-5"])
})
