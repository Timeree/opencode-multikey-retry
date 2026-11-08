export function readApiKeys(raw: unknown): Map<string, string[]> {
  const result = new Map<string, string[]>()

  if (!raw || typeof raw !== "object") return result

  for (const [providerID, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!Array.isArray(value)) continue

    const keys = [
      ...new Set(
        value
          .filter((entry): entry is string => typeof entry === "string")
          .map((entry) => entry.trim())
          .filter((entry) => entry.length > 0),
      ),
    ]

    if (keys.length >= 2) result.set(providerID, keys)
  }

  return result
}
