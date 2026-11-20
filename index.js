import { openAICompletionsApi } from "@earendil-works/pi-ai/compat";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import { createPandaProvider, normalizeBaseUrl } from "./src/provider.js";
import { isPandaSelector } from "./src/catalog.js";
import { createRequestKeys } from "./src/request.js";

export default function pandaExtension(pi) {
  const keys = createRequestKeys();
  const provider = createPandaProvider({
    baseUrl: normalizeBaseUrl(process.env.PANDA_BASE_URL),
    streams: openAICompletionsApi(),
    keys,
    observe(events, finish) {
      const output = createAssistantMessageEventStream();
      void (async () => {
        try {
          for await (const event of events) {
            if (event.type === "error") {
              const error = finish(event.error);
              output.push({ type: "error", reason: error.stopReason, error });
            } else if (event.type === "done") {
              output.push({ ...event, message: finish(event.message) });
            } else {
              output.push(event);
            }
          }
        } catch {
          const error = finish({ stopReason: "error" });
          output.push({ type: "error", reason: "error", error });
        } finally { output.end(); }
      })();
      return output;
    },
  });
  function guardTarget(ctx) {
    if (ctx.model?.provider !== "panda") return true;
    const supported = isPandaSelector(ctx.model.id);
    if (supported && provider.acceptsTarget(ctx.model)) return true;
    const message = supported
      ? "Panda requires the openai-completions protocol and the configured provider endpoint. Check the selected model in models.json."
      : "Select one of Panda's Auto or Panel models in Pi.";
    if (ctx.hasUI) ctx.ui.notify(message, "error");
    else process.stderr.write(message + "\n");
    return false;
  }
  pi.on("session_before_compact", (_event, ctx) => {
    if (!guardTarget(ctx)) return { cancel: true };
  });
  pi.on("session_before_tree", (event, ctx) => {
    if (event.preparation.userWantsSummary && !guardTarget(ctx)) return { cancel: true };
  });
  pi.on("before_agent_start", async (_event, ctx) => {
    if (!guardTarget(ctx)) { ctx.abort(); return; }
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
