import { AUTH_HEADERS, SCHEME } from "./shared.ts"
import type { Shape } from "./shared.ts"

const BEARER = /^Bearer\s+/i

function token(value: string): string {
  return value.replace(SCHEME, "").trim()
}

export function currentKey(headers: Headers): string | undefined {
  for (const name of AUTH_HEADERS) {
    const value = headers.get(name)
    if (value) return token(value)
  }
  return undefined
}

export function readKey(headers: Headers, keys: readonly string[]): string | undefined {
  for (const name of AUTH_HEADERS) {
    const value = headers.get(name)
    if (!value) continue
    const current = token(value)
    if (keys.includes(current)) return current
  }
  return undefined
}

export function captureShapes(headers: Headers): Shape[] {
  const shapes: Shape[] = []
  for (const name of AUTH_HEADERS) {
    const value = headers.get(name)
    if (!value) continue

    shapes.push({ name, prefix: value.match(SCHEME)?.[0] ?? "" })
  }
  return shapes
}

export function writeKey(headers: Headers, key: string, shapes: readonly Shape[]): void {
  for (const shape of shapes) {
    if (shape.name === "authorization" && BEARER.test(shape.prefix)) {
      headers.set(shape.name, `Bearer ${key}`)
      continue
    }
    headers.set(shape.name, `${shape.prefix}${key}`)
  }

  if (shapes.length === 0) headers.set("authorization", `Bearer ${key}`)
}
