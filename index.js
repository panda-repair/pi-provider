import { openAICompletionsApi } from "@earendil-works/pi-ai/compat";
import { createPandaProvider, normalizeBaseUrl } from "./src/provider.js";
import { createRequestKeys } from "./src/request.js";

export default function pandaExtension(pi) {
  const keys = createRequestKeys();
  const provider = createPandaProvider({
    baseUrl: normalizeBaseUrl(process.env.PANDA_BASE_URL),
    streams: openAICompletionsApi(),
    keys,
  });
  pi.on("before_agent_start", async (_event, ctx) => {
    keys.start(ctx.sessionManager);
    if (ctx.model?.provider === "panda") {
      // An explicit inference may refresh. Pi resolves the endpoint, credential and offline policy.
      await ctx.modelRegistry.refresh({ providers: ["panda"] });
    }
  });
  pi.on("agent_settled", (_event, ctx) => keys.settle(ctx.sessionManager));
  pi.on("session_shutdown", (_event, ctx) => keys.settle(ctx.sessionManager));
  pi.registerProvider(provider);

}
