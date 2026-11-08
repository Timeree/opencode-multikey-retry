import { readState, statePath, writeState } from "./state.ts"

export class Isolation {
  private readonly sets = new Map<string, Set<string>>()
  private readonly file: string

  constructor(isolated: Record<string, string[]>, file: string = statePath()) {
    this.file = file
    for (const [providerID, keys] of Object.entries(isolated)) {
      this.sets.set(providerID, new Set(keys))
    }
  }

  has(providerID: string, key: string): boolean {
    return this.sets.get(providerID)?.has(key) === true
  }

  async add(providerID: string, key: string): Promise<void> {
    const set = this.sets.get(providerID) ?? new Set<string>()
    if (set.has(key)) return
    set.add(key)
    this.sets.set(providerID, set)

    const state = readState(this.file)
    if (state === undefined) return
    state.isolated[providerID] = [...set]
    writeState(state, this.file)
  }
}
