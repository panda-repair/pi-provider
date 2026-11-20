import { closeSync, constants, fstatSync, openSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import { isContextOverflow, isRetryableAssistantError, openAICompletionsApi } from "@earendil-works/pi-ai/compat";
import { configuredToken, createPandaProvider, normalizeBaseUrl } from "./src/provider.js";
import { isPandaSelector } from "./src/catalog.js";
import { settlementAccounting } from "./src/usage.js";

// Pi checks that configured variables exist when listing, but passes only stored
// credentials into filterModels. Resolve only the literal or variables explicitly
// named in Panda’s configuration. Leave credential commands to the inference path.
function configuredPickerKey() {
  let fd;
  try {
    fd = openSync(join(getAgentDir(), "models.json"), constants.O_RDONLY | constants.O_NONBLOCK);
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > 4 * 1024 * 1024) return {};
    const config = JSON.parse(readFileSync(fd, "utf8")).providers?.panda?.apiKey;
    if (config === undefined) return { defaultEnv: true, key: process.env.PANDA_API_TOKEN };
    return { key: configuredToken(config, name => process.env[name]) };
  } catch (error) {
    return error.code === "ENOENT" ? { defaultEnv: true, key: process.env.PANDA_API_TOKEN } : {};
  } finally { if (fd !== undefined) closeSync(fd); }
}

export default function pandaExtension(pi) {
  const accounting = settlementAccounting();
  const provider = createPandaProvider({
    baseUrl: normalizeBaseUrl(process.env.PANDA_BASE_URL), streams: openAICompletionsApi(),
    accounting, pickerKey: configuredPickerKey,
    canDisplay(text) {
      const failure = { stopReason: "error", errorMessage: text };
      return !isRetryableAssistantError(failure) && !isContextOverflow(failure);
    },
    observe(open, finish) {
      const output = createAssistantMessageEventStream();
      void (async () => {
        try {
          for await (const event of open()) {
            if (event.type === "error" || event.type === "done") {
              const message = finish(event.error ?? event.message);
              const reason = message.stopReason;
              output.push(reason === "error" || reason === "aborted" ?
                { type: "error", reason, error: message } : { type: "done", reason, message });
            } else {
              // Native Pi mutates this object to attach its exception after publishing
              // partials. Keep the public message envelope independent of that mutation.
              const { errorMessage, diagnostics, ...partial } = event.partial;
              output.push({ ...event, partial });
            }
          }
        } catch {
          const error = finish({ stopReason: "error" });
          output.push({ type: "error", reason: error.stopReason, error });
        } finally { output.end(); }
      })();
      return output;
    },
  });
  function notify(ctx, message) {
    if (ctx.hasUI) ctx.ui.notify(message, "error");
    else process.stderr.write(message + "\n");
  }
  function guardTarget(ctx) {
    if (ctx.model?.provider !== "panda") return true;
    const supported = isPandaSelector(ctx.model.id);
    if (supported && provider.acceptsTarget(ctx.model)) return true;
    notify(ctx, supported
      ? "Panda requires the openai-completions protocol and the configured provider endpoint. Check the selected model in models.json."
      : "Select one of Panda's Auto or Panel models in Pi.");
    return false;
  }
  pi.on("session_start", (_event, ctx) => accounting.bind(ctx.sessionManager));
  pi.on("session_shutdown", () => accounting.bind(undefined));
  pi.on("session_before_compact", (event, ctx) => {
    if (!guardTarget(ctx)) return { cancel: true };
    if (event.reason !== "manual") {
      const last = event.branchEntries.findLast(entry => entry.type === "message")?.message;
      if (last?.provider === "panda" && (last.stopReason === "error" ||
          (event.willRetry && last.stopReason === "length"))) return { cancel: true };
    }
  });
  pi.on("session_before_tree", (event, ctx) => {
    if (event.preparation.userWantsSummary && !guardTarget(ctx)) return { cancel: true };
  });
  pi.on("before_agent_start", async (_event, ctx) => {
    if (!guardTarget(ctx)) { ctx.abort(); return; }
    if (ctx.model?.provider === "panda") {
      const result = await ctx.modelRegistry.refresh({ providers: ["panda"] });
      const failure = result.errors.get("panda");
      if (failure) {
        notify(ctx, provider.discoveryError() ?? "Could not refresh the Panda model catalog.");
        ctx.abort();
      }
    }
  });
  pi.registerProvider(provider);
}
