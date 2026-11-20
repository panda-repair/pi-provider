import { createHash } from "node:crypto";
import { catalog, permittedModels } from "./catalog.js";
import { createRequestKeys, pandaStream } from "./request.js";

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

function scope(url, token) {
  return token ? "panda-v1-" + createHash("sha256").update(url).update("\0").update(token).digest("hex") : undefined;
}

export function createPandaProvider({ baseUrl, streams, fetchImpl = fetch, keys = createRequestKeys() }) {
  let endpoint = baseUrl;
  let effective;
  let cached;
  let granted = [];

  function visible() {
    return effective && effective === cached ? granted : [];
  }

  function restore(url, entry) {
    endpoint = url;
    cached = entry?.etag;
    granted = Array.isArray(entry?.models) ? permittedModels(entry.models, url) : [];
  }

  async function resolveKey({ credential, ctx, signal }) {
    const token = inferenceToken(credential?.key ?? await ctx.env("PANDA_API_TOKEN"));
    signal.throwIfAborted();
    effective = scope(endpoint, token);
    if (token) return { auth: { apiKey: token }, source: credential?.key ? "stored Panda token" : "PANDA_API_TOKEN" };
  }

  function assertAvailable(model, key) {
    if (normalizeBaseUrl(model.baseUrl) !== endpoint || !cached || scope(endpoint, inferenceToken(key)) !== cached ||
        !granted.some(entry => entry.id === model.id)) {
      throw new Error("This Panda credential has no cached grant for the selected model at this endpoint. Refresh in an interactive Pi session.");
    }
  }

  const definitions = permittedModels(catalog, baseUrl);
  return {
    id: "panda", name: "Panda", baseUrl,
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
    getModels: () => visible().length ? visible() : definitions,
    getAllModels: () => visible().length ? visible() : definitions,
    filterModels(models, credential) {
      const identity = credential?.key ? scope(endpoint, inferenceToken(credential.key)) : effective;
      if (!cached || identity !== cached) return [];
      const allowed = new Set(granted.map(model => model.id));
      return models.filter(model => model.provider === "panda" && model.baseUrl === endpoint && allowed.has(model.id));
    },
    async refreshModels({ credential, allowNetwork, baseUrl: override, stored, publish, signal }) {
      const url = normalizeBaseUrl(override ?? baseUrl);
      const key = inferenceToken(credential?.key);
      if (signal.aborted) return;
      if (!allowNetwork) {
        await publish({ update() {
          effective = scope(url, key);
          restore(url, stored);
        } });
        return;
      }
      if (!key) {
        await publish({ persist: null, update() { effective = undefined; restore(url); } });
        return;
      }
      const fingerprint = scope(url, key);
      try {
        const response = await fetchImpl(url + "/models", { headers: { Authorization: "Bearer " + key }, signal, redirect: "error" });
        if (response.redirected || (response.url && response.url !== url + "/models")) {
          void response.body?.cancel().catch(() => {});
          throw new Error();
        }
        if (!response.ok) {
          void response.body?.cancel().catch(() => {});
          throw new DiscoveryError("Panda model discovery returned HTTP " + response.status + ".");
        }
        const body = await response.json();
        const entry = { etag: fingerprint, models: permittedModels(body?.data, url), checkedAt: Date.now() };
        await publish({ persist: entry, update() { effective = fingerprint; restore(url, entry); } });
      } catch (error) {
        if (signal.aborted) return;
        await publish({ persist: null, update() { effective = undefined; restore(url); } });
        if (error instanceof DiscoveryError) throw error;
        throw new Error("Could not read the Panda model catalog. Check your endpoint and credentials.");
      }
    },
    stream: pandaStream(streams.stream, keys, assertAvailable),
    streamSimple: pandaStream(streams.streamSimple, keys, assertAvailable),
  };
}

class DiscoveryError extends Error {}
