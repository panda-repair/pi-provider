import { createHash, createHmac } from "node:crypto";
import routingBackendGrants from "./routing-backend-grants.json" with { type: "json" };
import { modelDefinitions } from "./catalog.js";
import { boundedJSON, describeError } from "./errors.js";
import { pandaStream } from "./request.js";

export const defaultBaseUrl = "https://app.panda.repair/v1";

export function normalizeBaseUrl(value = defaultBaseUrl) {
  let url;
  try { url = new URL(value); } catch { /* Only local wording may reach Pi. */ }
  if (!url || !["http:", "https:"].includes(url.protocol) || url.search || url.hash || url.username || url.password) {
    throw new Error("Panda requires an HTTP(S) API base URL without credentials, a query or a fragment.");
  }
  return url.href.replace(/\/+$/, "");
}

function inferenceToken(value) {
  const token = typeof value === "string" ? value.trim() : "";
  return /^pnd_it_[^\s]+$/.test(token) ? token : undefined;
}

// Match Pi's non-command models.json templates without evaluating a credential command.
export function configuredToken(spec, env) {
  if (typeof spec !== "string" || spec.startsWith("!")) return;
  let missing = false;
  const value = spec.replace(/\$\$|\$!|\$\{[^}]*\}|\$[A-Za-z_]\w*/g, part => {
    if (part === "$$" || part === "$!") return part[1];
    const name = part.startsWith("${") ? part.slice(2, -1) : part.slice(1);
    if (!/^[A-Za-z_]\w*$/.test(name)) return part;
    const bound = env(name);
    if (!bound) missing = true;
    return bound ?? "";
  });
  return missing ? undefined : inferenceToken(value);
}

// Discovery grants access to the underlying backends separately from access to the routers.
export function permittedModels(data, url) {
  if (!Array.isArray(data)) throw new Error("Panda model discovery returned an invalid model list.");
  const raw = new Set(data.map(entry => entry?.id));
  const direct = routingBackendGrants.some(id => raw.has(id));
  const codingRoute = direct || raw.has("panel:panda");
  return modelDefinitions(url).filter(model => raw.has(model.id) &&
    (!model.id.startsWith("auto") || (model.id === "auto:cost" ? direct : codingRoute)));
}

function grantTag(url, token, models) {
  return "panda-v2-" + createHmac("sha256", token).update(JSON.stringify([url, models.map(model => model.id)])).digest("hex");
}

export function createPandaProvider({ baseUrl, streams, fetchImpl = fetch, pickerKey, ...transport }) {
  let endpoint = baseUrl;
  let hostEndpoint;
  let effective;
  let resolvedDefault;
  let checkedDefault;
  let commandRefresh;
  let verifiedCommand;
  let cached;
  let discoveryFailure;
  let granted = [];

  function restore(url, entry) {
    endpoint = url;
    hostEndpoint = url;
    cached = Array.isArray(entry?.models) && /^panda-v[12]-[a-f0-9]{64}$/.test(entry.etag) ? entry.etag : undefined;
    granted = [];
    checkedDefault = undefined;
    commandRefresh = undefined;
    verifiedCommand = undefined;
    if (!cached) return;
    if (cached.startsWith("panda-v1-")) {
      // Versions with a seven-model catalog stored backend entitlements as model rows.
      const prior = entry.models.filter(model => model?.provider === "panda" && model.api === "openai-completions" &&
        (model.type ?? "chat") === "chat" && model.baseUrl === url);
      granted = permittedModels(prior, url);
    } else {
      const saved = new Set(entry.models.map(model => model?.id));
      granted = modelDefinitions(url).filter(model => saved.has(model.id));
    }
  }

  function expectedTag(token) {
    if (!token) return;
    if (cached?.startsWith("panda-v1-")) {
      return "panda-v1-" + createHash("sha256").update(endpoint).update("\0").update(token).digest("hex");
    }
    return grantTag(endpoint, token, granted);
  }

  async function resolveKey({ credential, ctx, signal }) {
    const token = inferenceToken(credential?.key ?? await ctx.env("PANDA_API_TOKEN"));
    signal.throwIfAborted();
    effective = expectedTag(token);
    if (effective !== cached) verifiedCommand = undefined;
    // A request can resolve a different key while Pi is fetching the command's catalog.
    if (commandRefresh?.signal === signal) commandRefresh.credentialTag = effective;
    else if (commandRefresh?.credentialTag && commandRefresh.credentialTag !== effective) commandRefresh = undefined;
    checkedDefault = credential ? undefined : effective;
    const configured = pickerKey?.();
    resolvedDefault = configured?.defaultEnv ? expectedTag(inferenceToken(configured.key)) : undefined;
    if (token) return { auth: { apiKey: token, ...(hostEndpoint && { baseUrl: hostEndpoint }) }, source: credential?.key ? "stored Panda token" : "PANDA_API_TOKEN" };
  }

  function assertAvailable(model, key) {
    if (model.api !== "openai-completions" || normalizeBaseUrl(model.baseUrl) !== endpoint || !cached ||
        expectedTag(inferenceToken(key)) !== cached ||
        !granted.some(entry => entry.id === model.id)) {
      throw new Error("This Panda credential has no cached grant for the selected model at this endpoint. Refresh in an interactive Pi session.");
    }
  }

  function filterModels(models, credential) {
    const configured = credential?.key ? undefined : pickerKey?.();
    const local = configured ? expectedTag(inferenceToken(configured.key)) : undefined;
    const identity = credential?.key ? expectedTag(inferenceToken(credential.key)) :
      configured?.command ? (!credential && verifiedCommand?.command === configured.command &&
        verifiedCommand.runtime === configured.runtime ? cached : undefined) :
      configured?.unbound ? checkedDefault :
      !configured || (configured.defaultEnv && effective && local === resolvedDefault) ? effective : local;
    if (!cached || identity !== cached) return [];
    const allowed = new Set(granted.map(model => model.id));
    return models.filter(model => model.provider === "panda" && model.api === "openai-completions" &&
      (model.type ?? "chat") === "chat" && model.baseUrl === endpoint && allowed.has(model.id));
  }

  const definitions = modelDefinitions(baseUrl);
  return {
    id: "panda", name: "Panda", baseUrl,
    discoveryError: () => discoveryFailure,
    acceptsTarget(model) {
      return model.api === "openai-completions" && (!hostEndpoint || normalizeBaseUrl(model.baseUrl) === hostEndpoint);
    },
    auth: { apiKey: {
      name: "Panda inference token",
      async login(interaction) {
        const raw = await interaction.prompt({ type: "secret", message: "Paste your Panda inference token (pnd_it_…)" });
        interaction.signal.throwIfAborted();
        const key = inferenceToken(raw);
        if (!key) throw new Error("Enter a Panda inference token beginning with pnd_it_.");
        return { type: "api_key", key };
      },
      resolve: resolveKey,
    } },
    // Pi's models.json composer selects the native transport by API, even when a user
    // explicitly types an unlisted model. Keep that transport reachable on an empty grant.
    getModels: () => cached && effective === cached ? (granted.length ? granted : definitions.slice(0, 1)) : definitions,
    getAllModels: () => cached && effective === cached ? granted : definitions,
    filterModels,
    filterAllModels: filterModels,
    async refreshModels({ credential, allowNetwork, baseUrl: override, stored, publish, signal }) {
      const url = normalizeBaseUrl(override ?? baseUrl);
      const key = inferenceToken(credential?.key);
      if (signal.aborted) return;
      if (!allowNetwork) {
        await publish({ update() {
          discoveryFailure = undefined;
          restore(url, stored);
          effective = expectedTag(key);
          // Pi uses one signal for both phases. Only the first phase reveals
          // whether a stored credential took precedence over the configured command.
          const source = !credential && pickerKey?.();
          commandRefresh = source?.command ? { source, signal, url } : undefined;
        } });
        return;
      }
      if (!key) {
        await publish({ persist: null, update() { effective = undefined; restore(url); } });
        return;
      }
      try {
        const response = await fetchImpl(url + "/models", { headers: { Authorization: "Bearer " + key }, signal, redirect: "error" });
        if (response.redirected || (response.url && response.url !== url + "/models")) {
          void response.body?.cancel().catch(() => {});
          throw new Error();
        }
        if (!response.ok) {
          const error = describeError(response.status, await boundedJSON(response), response.headers);
          void response.body?.cancel().catch(() => {});
          const { code, param, requestId } = error.details;
          const fields = [code && "Code: " + code + ".", param && "Parameter: " + param + ".",
            requestId && "Panda request ID: " + requestId + "."].filter(Boolean);
          throw new DiscoveryError(["Panda model discovery failed (HTTP " + response.status + ").", ...fields].join(" "));
        }
        const body = await boundedJSON(response, 512 * 1024, 10_000);
        void response.body?.cancel().catch(() => {});
        const models = permittedModels(body?.data, url);
        const entry = { etag: grantTag(url, key, models), models, checkedAt: Date.now() };
        await publish({ persist: entry, update() {
          const source = commandRefresh?.signal === signal && commandRefresh.url === url ? commandRefresh.source : undefined;
          restore(url, entry);
          effective = entry.etag;
          verifiedCommand = source;
        } });
      } catch (error) {
        if (signal.aborted) return;
        const message = error instanceof DiscoveryError ? error.message : "Could not read the Panda model catalog. Check your endpoint and credentials.";
        await publish({ persist: null, update() { effective = undefined; restore(url); discoveryFailure = message; } });
        throw new Error(message);
      }
    },
    stream: pandaStream(streams.stream, assertAvailable, transport),
    streamSimple: pandaStream(streams.streamSimple, assertAvailable, transport),
  };
}

class DiscoveryError extends Error {}
