import test from "node:test";
import assert from "node:assert/strict";
import { catalog, compat, permittedModels } from "../src/catalog.js";
import { createPandaProvider, defaultBaseUrl, normalizeBaseUrl } from "../src/provider.js";

const baseUrl = "http://127.0.0.1:8100/v1";
const ids = ["glm-5.3", "deepseek-v4.1-flash", "auto", "auto:cost", "auto:quality", "panel:panda", "panel:panda-quality"];
const signal = new AbortController().signal;

function rig() {
  let key = "pnd_it_local";
  let response = () => Response.json({ data: [{ id: "auto" }, { id: "glm-5.3" }, { id: "foreign" }] });
  const requests = [];
  const streams = { stream() { throw new Error("Transport called"); }, streamSimple() { throw new Error("Transport called"); } };
  const provider = createPandaProvider({ baseUrl, streams, envToken: () => key,
    fetchImpl: async (url, options) => { requests.push({ url, ...options }); return response(); } });
  const refresh = (options = {}) => provider.refreshModels({
    allowNetwork: true, signal, publish: async ({ update }) => { update(); return true; }, ...options,
  });
  return { provider, refresh, requests, key: value => { key = value; }, respond: fn => { response = fn; } };
}

test("the seven allowed, text-only models use the Panda adapter and their per-selector compaction windows", () => {
  const windows = {
    "glm-5.3": 258_000, "deepseek-v4.1-flash": 258_000, "auto:cost": 258_000,
    "panel:panda": 224_000, "panel:panda-quality": 224_000, auto: 224_000, "auto:quality": 224_000,
  };
  assert.deepEqual(catalog.map(model => model.id), ids);
  const models = permittedModels([...ids.map(id => ({ id })), { id: "auto" }, { id: "unknown" }], baseUrl);
  assert.deepEqual(models.map(model => model.id), ids);
  for (const [index, model] of models.entries()) {
    assert.equal(model.api, "openai-completions");
    assert.equal(model.provider, "panda");
    assert.equal(model.baseUrl, baseUrl);
    assert.deepEqual(model.input, ["text"]);
    assert.equal(model.reasoning, false);
    assert.equal(model.contextWindow, windows[model.id], model.id);
    assert.equal(model.maxTokens, 16_384, model.id);
    assert.deepEqual(model.compat, {
      supportsStore: false, supportsReasoningEffort: false, promptCacheKeyMode: "disabled",
      supportsLongCacheRetention: false, supportsDeveloperRole: true, supportsUsageInStreaming: true,
    });
    assert.ok(Object.values(model.cost).every(cost => index < 2 ? cost > 0 : cost === 0));
    assert.notStrictEqual(model.compat, compat);
  }
  assert.throws(() => permittedModels({}, baseUrl), /invalid model list/);
});

test("endpoint normalization includes the default and preserves an overridden API path", () => {
  assert.equal(normalizeBaseUrl(), defaultBaseUrl);
  assert.equal(normalizeBaseUrl(baseUrl + "//"), baseUrl);
  for (const bad of ["file:///etc", "https://example.test/v1?token=x", "https://secret@example.test/v1"]) {
    assert.throws(() => normalizeBaseUrl(bad));
  }
});

test("native API-key login masks and validates the pasted token, with stored credentials preferred over environment", async () => {
  const { provider } = rig();
  const { apiKey } = provider.auth;
  const credential = await apiKey.login({ signal, prompt: async prompt => {
    assert.equal(prompt.type, "secret");
    return "  pnd_it_stored  ";
  } });
  assert.deepEqual(credential, { type: "api_key", key: "pnd_it_stored" });
  const ctx = { env: async name => name === "PANDA_API_TOKEN" ? "pnd_it_env" : undefined };
  assert.equal((await apiKey.resolve({ ctx, credential, signal })).auth.apiKey, "pnd_it_stored");
  assert.equal((await apiKey.resolve({ ctx, signal })).auth.apiKey, "pnd_it_env");
  assert.equal(await apiKey.resolve({ ctx: { env: async () => undefined }, signal }), undefined);
  await assert.rejects(apiKey.login({ signal, prompt: async () => "wrong" }), /pnd_it_/);
});

test("authorized discovery intersects the static catalog, filters composed rows and gates explicit ID fallbacks", async () => {
  const { provider, refresh, requests } = rig();
  assert.deepEqual(provider.getModels(), []);
  await refresh();
  assert.equal(requests[0].headers.Authorization, "Bearer pnd_it_local");
  assert.equal(requests[0].url, baseUrl + "/models");
  assert.equal(requests[0].signal, signal);
  assert.equal(requests[0].redirect, "error");
  assert.deepEqual(provider.getModels().map(m => m.id), ["glm-5.3", "auto"]);
  const allowed = provider.getModels()[0];
  const unavailable = { ...allowed, id: "auto:quality" };
  const unknown = { ...allowed, id: "other" };
  assert.deepEqual(provider.filterModels([allowed, unknown, unavailable], undefined), [allowed]);
  assert.deepEqual(provider.filterModels([allowed], { key: "pnd_it_other" }), []);
  for (const entry of [unavailable, unknown, { ...allowed, baseUrl: "https://another.test/v1" }]) {
    assert.throws(() => provider.streamSimple(entry, {}, { apiKey: "pnd_it_local" }), /does not list/);
  }
  assert.throws(() => provider.stream(allowed, {}, { apiKey: "pnd_it_another" }), /does not list/);
  assert.throws(() => provider.stream(allowed, {}, { apiKey: "pnd_it_local" }), /Transport called/);
});

test("failed, switched, or removed credentials cannot retain a previous model grant", async () => {
  const { provider, refresh, requests, key, respond } = rig();
  await refresh();
  await refresh({ allowNetwork: false });
  assert.equal(requests.length, 1);
  assert.equal(provider.getModels().length, 2);
  key("pnd_it_new");
  await refresh({ allowNetwork: false });
  assert.deepEqual(provider.getModels(), []);
  respond(() => Response.json({ data: [{ id: "panel:panda" }] }));
  await refresh();
  assert.deepEqual(provider.getModels().map(m => m.id), ["panel:panda"]);
  respond(() => new Response("private error detail", { status: 403 }));
  await assert.rejects(refresh(), { message: "Panda model discovery returned HTTP 403." });
  assert.deepEqual(provider.getModels(), []);
  key(undefined);
  const previous = requests.length;
  await refresh();
  assert.equal(requests.length, previous);
});

test("a rejected generation cannot overwrite the current catalog", async () => {
  const { provider, refresh, respond } = rig();
  await refresh();
  respond(() => Response.json({ data: [{ id: "panel:panda-quality" }] }));
  await refresh({ publish: async () => false });
  assert.deepEqual(provider.getModels().map(m => m.id), ["glm-5.3", "auto"]);
});
