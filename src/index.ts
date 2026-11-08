import { Plugin } from "@opencode/plugin"
import { readApiKeys } from "./config.ts"
import { Isolation } from "./isolation.ts"
import { Retry } from "./retry.ts"
import { readState } from "./state.ts"

export default Plugin.define({
  id: "opencode-multikey-retry",
  async setup(ctx) {
    const state = readState()
    const providers = readApiKeys(state?.apiKeys ?? {})
    if (providers.size === 0) return

    const isolation = new Isolation(state?.isolated ?? {})
    const retry = new Retry(providers, isolation)
    const registrations: { dispose: () => Promise<void> }[] = []

    for (const providerID of providers.keys()) {
      registrations.push(
        await ctx.session.hook("http.request", retry.request, { providerID }),
        await ctx.session.hook("http.response", retry.response, { providerID }),
        await ctx.session.hook("retry", retry.retry, { providerID }),
      )
    }

    return async () => {
      for (const registration of registrations) {
        await registration.dispose().catch(() => {})
      }
    }
  },
})
