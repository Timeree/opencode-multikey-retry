import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import path from "node:path"
import { log } from "./shared.ts"

export interface State {
  apiKeys: Record<string, string[]>
  isolated: Record<string, string[]>
}

export function statePath(): string {
  const base = process.env.XDG_CONFIG_HOME || path.join(homedir(), ".config")
  return path.join(base, "opencode", "opencode-multikey-retry.json")
}

function groups(raw: unknown, field: string): Record<string, string[]> {
  const out: Record<string, string[]> = {}
  const value = raw && typeof raw === "object" ? (raw as Record<string, unknown>)[field] : undefined
  if (!value || typeof value !== "object") return out

  for (const [providerID, list] of Object.entries(value)) {
    if (!Array.isArray(list)) continue
    const keys = list.filter((entry): entry is string => typeof entry === "string")
    if (keys.length > 0) out[providerID] = keys
  }
  return out
}

/** 文件缺失视为空配置；损坏返回 undefined，避免把坏文件覆盖成空配置。 */
export function readState(file: string = statePath()): State | undefined {
  let raw: unknown
  try {
    raw = JSON.parse(readFileSync(file, "utf8"))
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      log(`读取配置文件失败：${String(error)}`)
      return undefined
    }
    return { apiKeys: {}, isolated: {} }
  }
  return { apiKeys: groups(raw, "apiKeys"), isolated: groups(raw, "isolated") }
}

export function writeState(state: State, file: string = statePath()): void {
  try {
    mkdirSync(path.dirname(file), { recursive: true })
    writeFileSync(file, `${JSON.stringify(state, null, 2)}\n`)
  } catch (error) {
    log(`写入配置文件失败：${String(error)}`)
  }
}
