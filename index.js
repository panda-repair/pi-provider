import { realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { join } from "node:path";
import { getAgentDir, getPackageDir, VERSION } from "@earendil-works/pi-coding-agent";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import { isContextOverflow, isRetryableAssistantError, openAICompletionsApi } from "@earendil-works/pi-ai/compat";
import { configuredToken, createPandaProvider, normalizeBaseUrl } from "./src/provider.js";
import { isPandaSelector } from "./src/catalog.js";
import { settlementAccounting } from "./src/usage.js";

const verifiedPickerHost = ["1.5.2", "1.6.0"].includes(VERSION);

// Picker lookups can read literals and named variables. Only Pi may run a command.
function pickerCredential(spec, runtime) {
  if (typeof spec === "string" && spec.startsWith("!")) {
    if (typeof runtime?.getProviderAuthStatus === "function" && typeof runtime.getRegisteredProviderConfig === "function" &&
        runtime.getProviderAuthStatus("panda")?.source === "models_json_command" &&
        runtime.getRegisteredProviderConfig("panda")?.apiKey === undefined) {
      return { command: spec, runtime };
    }
    return {};
  }
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

export default async function pandaExtension(pi, callerRuntime) {
  let runtime = callerRuntime;
  const stockList = verifiedPickerHost && isStockList();
  const cliConfig = stockList ? await stockListConfig() : undefined;
  const accounting = settlementAccounting();
  const provider = createPandaProvider({
    baseUrl: normalizeBaseUrl(process.env.PANDA_BASE_URL), streams: openAICompletionsApi(),
    accounting, pickerKey() {
      if (!verifiedPickerHost) return {};
      if (!runtime && !stockList) return { unbound: true };
      // These Pi versions expose no public provider-config accessor. Read the validated
      // runtime snapshot, including an SDK's custom modelsPath, without resolving auth.
      const config = runtime ? runtime.config : cliConfig;
      if (typeof config?.getProvider !== "function" ||
          typeof config.getError !== "function" || config.getError()) return {};
      return pickerCredential(config.getProvider("panda")?.apiKey, runtime);
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
  pi.on("session_shutdown", () => { accounting.bind(undefined); runtime = callerRuntime; });
  pi.on("session_before_compact", (event, ctx) => {
    accounting.endSplit();
    if (!guardTarget(ctx)) return { cancel: true };
    if (event.reason !== "manual") {
      const last = event.branchEntries.findLast(entry => entry.type === "message")?.message;
      if (last?.provider === "panda" && (last.stopReason === "error" ||
          (event.willRetry && last.stopReason === "length"))) return { cancel: true };
    }
    if (event.preparation.isSplitTurn && event.preparation.messagesToSummarize.length && event.preparation.turnPrefixMessages.length) {
      accounting.beginSplit(event.signal);
    }
  });
  pi.on("before_provider_headers", event => accounting.agentHeaders(event.headers));
  pi.on("session_compact_failed", () => accounting.endSplit());
  pi.on("session_compact", (event, ctx) => {
    const entry = !event.fromExtension && ctx.sessionManager.getEntries().findLast(row => row.type === "compaction");
    accounting.endSplit(entry, pi.appendEntry);
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
