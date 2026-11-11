export const ID = "opencode-multikey-retry"

export const POLL_MS = 300
export const ROUND_TTL_MS = 30 * 60_000
export const MAX_ROUNDS = 512

/** 每次退避时，池中其它 key 冷却顺延的毫秒数。 */
export const BUMP_MS = 1_000

const BASE_S = 1
const FACTOR = 1.2
const CAP_S = 1200

export const AUTH_HEADERS = [
  "authorization",
  "x-api-key",
  "api-key",
  "x-goog-api-key",
  "anthropic-api-key",
  "x-stainless-api-key",
] as const

export const SCHEME = /^[A-Za-z][A-Za-z0-9_-]*\s+/

export const TRANSPORT = new Set(["provider.transport", "provider.timeout"])

/** 连续第几次 429 后，伪造一个“空指令” tool call，避免走到 12 次的原生重试上限。 */
export const FAKE_TOOL_CALL_AFTER = 10

/** 两次伪造空指令之间的最小间隔，防止死配额下请求洪流。 */
export const MIN_FAKE_INTERVAL_MS = 10_000

/** 一段合法的空 tool_call SSE 流：runner 走 tool_calls 路径，执行一条空指令后续跑下一轮。 */
export function fakeToolCallResponse(model: string): Response {
  const chunk = (delta: object, finish: string | null, usage?: object): string =>
    `data: ${JSON.stringify({
      id: "chatcmpl-fake",
      object: "chat.completion.chunk",
      created: 0,
      model,
      choices: [{ index: 0, delta, finish_reason: finish }],
      ...(usage ? { usage } : {}),
    })}\n\n`

  const body =
    chunk(
      {
        role: "assistant",
        content: "",
        tool_calls: [
          {
            index: 0,
            id: "call_f",
            type: "function",
            function: { name: "shell", arguments: "{\"command\":\":\"}" },
          },
        ],
      },
      null,
    ) +
    chunk({}, "tool_calls", { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 }) +
    "data: [DONE]\n\n"

  return new Response(body, {
    status: 200,
    headers: { "content-type": "text/event-stream", "cache-control": "no-cache" },
  })
}

export interface Shape {
  readonly name: string
  readonly prefix: string
}

export function delayMs(n: number): number {
  return Math.round(Math.min(CAP_S, BASE_S * FACTOR ** (n - 1)) * 1000)
}

export function retryAfterMs(headers: Headers | undefined): number | undefined {
  const raw = headers?.get("retry-after")
  if (!raw) return undefined

  const seconds = Number(raw)
  if (raw.trim() !== "" && Number.isFinite(seconds)) {
    return seconds > 0 ? Math.round(seconds * 1000) : undefined
  }

  const at = Date.parse(raw)
  if (!Number.isFinite(at) || at <= Date.now()) return undefined
  return at - Date.now()
}

export function handled(status: number): boolean {
  return status === 401 || status === 403 || status === 429 || (status >= 500 && status < 600)
}

export function log(message: string): void {
  console.warn(`[${ID}] ${message}`)
}

export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const done = (): void => {
      clearTimeout(timer)
      signal?.removeEventListener("abort", done)
      resolve()
    }
    const timer = setTimeout(done, ms)
    signal?.addEventListener("abort", done, { once: true })
  })
}
