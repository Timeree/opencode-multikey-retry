import type { MockTracker } from "node:test"
import type { Model } from "@opencode/schema/model"
import type { Agent } from "@opencode/schema/agent"
import type { Session } from "@opencode/schema/session"
import type {
  SessionHttpRequest,
  SessionHttpResponse,
  SessionRetry,
} from "@opencode/plugin/promise/session"
import type { SessionError } from "@opencode/schema/session-error"
import { mkdirSync, mkdtempSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { Isolation } from "../src/isolation.ts"
import { Retry } from "../src/retry.ts"
import { readState, writeState } from "../src/state.ts"

export const PROVIDER = "p"
export const MODEL = "m"

const session: Session.ID = "s" as Session.ID
const agent: Agent.ID = "agent" as Agent.ID

export const ref = (providerID = PROVIDER, id = MODEL): Model.Ref => ({ providerID, id } as Model.Ref)

export const requestEvent = (options?: {
  headers?: Record<string, string>
  kind?: SessionHttpRequest["kind"]
  signal?: AbortSignal
  providerID?: string
}): SessionHttpRequest => {
  const headers = options?.headers ?? {}
  return {
    sessionID: session,
    agent,
    model: ref(options?.providerID),
    kind: options?.kind ?? "primary",
    request: new Request("https://provider/v1/chat/completions", {
      method: "POST",
      headers,
      body: "{}",
      signal: options?.signal,
    }),
  }
}

export const responseEvent = (
  request: SessionHttpRequest,
  response: Response,
): SessionHttpResponse => ({
  sessionID: request.sessionID,
  agent: request.agent,
  model: request.model,
  kind: request.kind,
  request: request.request,
  response,
})

export const retryEvent = (options?: {
  error?: Partial<SessionError.Error>
  attempt?: number
  providerID?: string
  native?: SessionRetry["decision"]
}): SessionRetry => ({
  sessionID: session,
  agent,
  model: ref(options?.providerID),
  error: { type: "provider.http", message: "failed", status: 500, ...options?.error },
  attempt: options?.attempt ?? 2,
  decision: options?.native ?? { retry: false },
})

export interface Env {
  readonly retry: Retry
  readonly isolation: Isolation
  readonly file: string
}

/** 状态写进临时文件，隔离记录随真实文件持久化。 */
export const makeEnv = (keys: string[], options?: { isolated?: string[]; providerID?: string }): Env => {
  const providerID = options?.providerID ?? PROVIDER
  mkdirSync(path.join(os.tmpdir(), "opencode"), { recursive: true })
  const file = path.join(mkdtempSync(path.join(os.tmpdir(), "opencode", "multikey-")), "state.json")
  const isolated = options?.isolated ? { [providerID]: options.isolated } : {}
  writeState({ apiKeys: { [providerID]: [...keys] }, isolated }, file)

  const state = readState(file) ?? { apiKeys: {}, isolated: {} }
  const isolation = new Isolation(state.isolated, file)
  return {
    retry: new Retry(new Map([[providerID, [...keys]]]), isolation),
    isolation,
    file,
  }
}

/** 捕获插件的 warn 输出，断言时只允许出现序号与时间。 */
export const captureWarn = (mock: MockTracker, target: string[] = []): string[] => {
  mock.method(console, "warn", (message: string) => target.push(message))
  return target
}
