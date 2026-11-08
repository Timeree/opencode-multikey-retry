import assert from "node:assert/strict"
import test from "node:test"
import { mkdtempSync, rmSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import plugin from "../src/index.ts"
import { statePath, writeState } from "../src/state.ts"

interface Registered {
  readonly name: string
  readonly options: Record<string, unknown> | undefined
}

const setup = async () => {
  const hooks: Registered[] = []
  const ctx = {
    session: {
      hook: async (name: string, _callback: unknown, options?: Record<string, unknown>) => {
        hooks.push({ name, options })
        return { dispose: async () => {} }
      },
    },
  }

  const cleanup = await plugin.setup(ctx as never)
  return { hooks, cleanup }
}

const xdg = mkdtempSync(path.join(os.tmpdir(), "opencode", "multikey-index-"))
process.env.XDG_CONFIG_HOME = xdg

test.after(() => {
  delete process.env.XDG_CONFIG_HOME
  rmSync(xdg, { recursive: true, force: true })
})

test("apiKeys 从独立配置文件读取：为每个 provider 注册三个钩子", async () => {
  writeState({ apiKeys: { alpha: ["A", "B"], beta: ["C", "D"] }, isolated: {} }, statePath())

  const { hooks, cleanup } = await setup()
  assert.deepStrictEqual(
    hooks.map((hook) => [hook.name, hook.options?.providerID]),
    [
      ["http.request", "alpha"],
      ["http.response", "alpha"],
      ["retry", "alpha"],
      ["http.request", "beta"],
      ["http.response", "beta"],
      ["retry", "beta"],
    ],
  )

  await cleanup?.()
})

test("隔离记录里的 key 从池中剔除，不影响钩子注册", async () => {
  writeState(
    { apiKeys: { alpha: ["A", "B", "C"], beta: ["C", "D"] }, isolated: { alpha: ["C"] } },
    statePath(),
  )

  const { hooks } = await setup()
  assert.deepStrictEqual(
    hooks.map((hook) => hook.options?.providerID),
    ["alpha", "alpha", "alpha", "beta", "beta", "beta"],
  )
})

test("没有配置文件或 key 不足 2 个时不注册任何钩子", async () => {
  const empty = mkdtempSync(path.join(os.tmpdir(), "opencode", "multikey-none-"))
  try {
    process.env.XDG_CONFIG_HOME = empty
    assert.strictEqual((await setup()).hooks.length, 0, "配置文件缺失")

    writeState({ apiKeys: { p: ["A"] }, isolated: {} }, statePath())
    const { hooks, cleanup } = await setup()
    assert.deepStrictEqual(hooks, [])
    assert.strictEqual(cleanup, undefined)
  } finally {
    process.env.XDG_CONFIG_HOME = xdg
    rmSync(empty, { recursive: true, force: true })
  }
})
