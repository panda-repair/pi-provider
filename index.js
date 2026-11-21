import { realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { join } from "node:path";
import { getAgentDir, getPackageDir, VERSION } from "@earendil-works/pi-coding-agent";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import { isContextOverflow, isRetryableAssistantError, openAICompletionsApi } from "@earendil-works/pi-ai/compat";
import { configuredToken, createPandaProvider, normalizeBaseUrl } from "./src/provider.js";
import { isPandaSelector } from "./src/catalog.js";
import { settlementAccounting } from "./src/usage.js";

// Pi checks that configured variables exist when listing, but passes only stored
// credentials into filterModels. Resolve only the literal or variables explicitly
// named in Panda’s configuration. Leave credential commands to the inference path.
function pickerCredential(spec) {
  return spec === undefined ? { defaultEnv: true, key: process.env.PANDA_API_TOKEN }
    : { key: configuredToken(spec, name => process.env[name]) };
}

function isStockList() {
  try {
    return process.argv.includes("--list-models") &&
      realpathSync(process.argv[1]) === realpathSync(join(getPackageDir(), "dist", "bundle", "cli.js"));
  } catch { return false; }
}

async function stockListConfig() {
  if (VERSION !== "1.5.2" || !isStockList()) return;
  try {
    // The stock CLI exits before session_start. Use its model parser for exactly
    // the file that the stock CLI opened, including JSON comments and BOMs.
    const source = pathToFileURL(join(getPackageDir(), "dist", "core", "model-config.js"));
    const { ModelConfig } = await import(source.href);
    return await ModelConfig.load(join(getAgentDir(), "models.json"));
  } catch { return; }
}

// An SDK client can use the picker before it creates an AgentSession. At that
// point Pi supplies no registry to the extension. Bind the runtime explicitly.
export const withPandaModelRuntime = runtime => pi => pandaExtension(pi, runtime);

export default async function pandaExtension(pi, runtime) {
  const cliConfig = await stockListConfig();
  const accounting = settlementAccounting();
  const provider = createPandaProvider({
    baseUrl: normalizeBaseUrl(process.env.PANDA_BASE_URL), streams: openAICompletionsApi(),
    accounting, pickerKey() {
      if (!runtime && !cliConfig) return { unbound: true };
      // Pi 1.5.2 exposes no public provider-config accessor. Read its validated
      // runtime snapshot, including an SDK's custom modelsPath, without resolving auth.
      const config = runtime?.config ?? cliConfig;
      if (VERSION !== "1.5.2" || typeof config?.getProvider !== "function" ||
          typeof config.getError !== "function" || config.getError()) return {};
      return pickerCredential(config.getProvider("panda")?.apiKey);
    },
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
  pi.on("session_start", async (_event, ctx) => {
    accounting.bind(ctx.sessionManager);
    runtime = ctx.modelRegistry.runtime;
    await ctx.modelRegistry.refresh({ providers: ["panda"], allowNetwork: false });
  });
  pi.on("session_shutdown", () => { accounting.bind(undefined); runtime = undefined; });
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
