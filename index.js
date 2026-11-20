import { openAICompletionsApi } from "@earendil-works/pi-ai/compat";
import { readStoredCredential } from "@earendil-works/pi-coding-agent";
import { createPandaProvider, normalizeBaseUrl } from "./src/provider.js";
import { createRequestKeys } from "./src/request.js";

export default async function pandaExtension(pi) {
  const keys = createRequestKeys();
  const provider = createPandaProvider({
    baseUrl: normalizeBaseUrl(process.env.PANDA_BASE_URL),
    streams: openAICompletionsApi(),
    envToken: () => process.env.PANDA_API_TOKEN,
    keys,
  });
  pi.on("before_agent_start", (_event, ctx) => keys.start(ctx.sessionManager));
  pi.on("agent_settled", (_event, ctx) => keys.settle(ctx.sessionManager));
  pi.on("session_shutdown", (_event, ctx) => keys.settle(ctx.sessionManager));
  pi.registerProvider(provider);

  // Pi 1.5.2 uses cache-only startup for print mode and --list-models.
  if (/^(1|true|yes)$/i.test(process.env.PI_OFFLINE ?? "")) return;
  try {
    await provider.refreshModels({
      credential: readStoredCredential("panda"),
      allowNetwork: true,
      signal: AbortSignal.timeout(10_000),
      publish: async ({ update }) => { update(); return true; },
    });
  } catch (error) {
    // Keep /login available for expired or replaced keys; do not print response bodies or tokens.
    const detail = /^Panda model discovery returned HTTP \d+\.$/.test(error?.message) ? error.message : "Could not read the Panda model list.";
    console.warn(detail + " Check PANDA_BASE_URL and your Panda token.");
  }
}
