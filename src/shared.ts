export const ID = "opencode-multikey-retry"

export const POLL_MS = 300
export const ROUND_TTL_MS = 30 * 60_000
export const MAX_ROUNDS = 512

/** 每次退避时，池中其它 key 冷却顺延的毫秒数。 */
export const BUMP_MS = 1_000

/** 端点级 TPM/RPM 429：没有 Retry-After 时，等待一个分钟窗口再重试。 */
export const RATE_LIMIT_WINDOW_MS = 65_000

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
