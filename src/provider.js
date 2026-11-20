import { permittedModels } from "./catalog.js";
import { createRequestKeys, pandaStream } from "./request.js";

export const defaultBaseUrl = "https://app.panda.repair/v1";

export function normalizeBaseUrl(value = defaultBaseUrl) {
  const url = new URL(value);
  if (!["http:", "https:"].includes(url.protocol) || url.search || url.hash || url.username || url.password) {
    throw new Error("PANDA_BASE_URL must be an HTTP(S) API base URL without credentials, a query or a fragment.");
  }
  return url.href.replace(/\/+$/, "");
}

function inferenceToken(value) {
  const token = typeof value === "string" ? value.trim() : "";
  return /^pnd_it_[^\s]+$/.test(token) ? token : undefined;
}

export function createPandaProvider({ baseUrl, streams, envToken, fetchImpl = fetch, keys = createRequestKeys() }) {
  let available = [];
  let owner;
  let endpoint = baseUrl;

  function storedOrEnv(credential) {
    return inferenceToken(credential?.key ?? envToken());
  }

  function replace(token, url, models) {
    owner = token;
    endpoint = url;
    available = models;
  }

  function assertAvailable(model, key) {
    if (!owner || key !== owner || normalizeBaseUrl(model.baseUrl) !== endpoint ||
        !available.some(entry => entry.id === model.id)) {
      throw new Error("The Panda catalog for this token does not list model " + model.id + ". Check your token and reload Pi.");
    }
  }

  async function discover(token, url, signal) {
    const response = await fetchImpl(url + "/models", {
      headers: { Authorization: "Bearer " + token },
      signal,
      redirect: "error",
    });
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error("Panda model discovery returned HTTP " + response.status + ".");
    }
    const list = await response.json();
    return permittedModels(list?.data, url);
  }

  const provider = {
    id: "panda",
    name: "Panda",
    baseUrl,
    auth: {
      apiKey: {
        name: "Panda inference token",
        async login(interaction) {
          const raw = await interaction.prompt({ type: "secret", message: "Paste your Panda inference token (pnd_it_…)" });
          interaction.signal.throwIfAborted();
          const key = inferenceToken(raw);
          if (!key) throw new Error("Enter a Panda inference token beginning with pnd_it_.");
          return { type: "api_key", key };
        },
        async resolve({ credential, ctx, signal }) {
          const value = credential?.key ?? await ctx.env("PANDA_API_TOKEN");
          signal.throwIfAborted();
          const apiKey = inferenceToken(value);
          if (apiKey) return { auth: { apiKey }, source: credential?.key ? "stored Panda token" : "PANDA_API_TOKEN" };
        },
      },
    },
    getModels: () => available,
    filterModels(models, credential) {
      if (!owner || owner !== storedOrEnv(credential)) return [];
      const allowed = new Set(available.map(model => model.id));
      return models.filter(model => model.provider === "panda" && allowed.has(model.id));
    },
    async refreshModels({ credential, allowNetwork, baseUrl: override, publish, signal }) {
      const key = storedOrEnv(credential);
      const url = normalizeBaseUrl(override ?? baseUrl);
      if (!key || owner !== key || endpoint !== url) {
        await publish({ update: () => replace(key, url, []) });
      }
      if (!key || !allowNetwork || signal.aborted) return;
      try {
        const models = await discover(key, url, signal);
        await publish({ update: () => replace(key, url, models) });
      } catch (error) {
        if (!signal.aborted) await publish({ update: () => replace(key, url, []) });
        throw error;
      }
    },
    stream: pandaStream(streams.stream, keys, assertAvailable),
    streamSimple: pandaStream(streams.streamSimple, keys, assertAvailable),
  };
  return provider;
}
