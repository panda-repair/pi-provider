import test from "node:test";
import assert from "node:assert/strict";
import backendGrants from "../src/routing-backend-grants.json" with { type: "json" };
import { catalog, compat, modelDefinitions } from "../src/catalog.js";
import { createHash } from "node:crypto";
import { configuredToken, createPandaProvider, defaultBaseUrl, normalizeBaseUrl, permittedModels } from "../src/provider.js";

const baseUrl = "http://127.0.0.1:8100/v1";
const ids = ["auto", "auto:cost", "auto:quality", "panel:panda", "panel:panda-quality"];
const signal = new AbortController().signal;

function rig(pickerKey) {
  let key = "pnd_it_local";
  let stored;
  let response = () => Response.json({ data: [{ id: "auto" }, { id: "auto:cost" }, { id: backendGrants[0] }, { id: "foreign" }] });
  const requests = [];
  const streams = { stream() { throw new Error("Transport called"); }, streamSimple() { throw new Error("Transport called"); } };
  const provider = createPandaProvider({ baseUrl, streams, pickerKey,
    fetchImpl: async (url, options) => { requests.push({ url, ...options }); return response(); } });
  const refresh = (options = {}) => provider.refreshModels({
    allowNetwork: true, credential: key ? { type: "api_key", key } : undefined, stored, signal,
    publish: async ({ update, persist }) => { if (persist !== undefined) stored = persist; update(); return true; }, ...options,
  });
  return { provider, refresh, requests, key: value => { key = value; }, respond: fn => { response = fn; }, cached: () => stored };
}

test("the five allowed, text-only models use the Panda adapter and their per-selector compaction windows", () => {
  const windows = {
    "auto:cost": 258_000,
    "panel:panda": 224_000, "panel:panda-quality": 224_000, auto: 224_000, "auto:quality": 187_000,
  };
  assert.deepEqual(catalog.map(model => model.id), ids);
  const models = permittedModels([...ids, ...backendGrants, "auto", "unknown"].map(id => ({id})), baseUrl);
  assert.deepEqual(models.map(model => model.id), ids);
  for (const model of models) {
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
    assert.ok(Object.values(model.cost).every(cost => cost === 0));
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

test("native API-key login requests secret input and validates the pasted token, with stored credentials preferred over environment", async () => {
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
  assert.deepEqual(provider.filterModels(provider.getModels(), undefined), []);
  await refresh();
  assert.equal(requests[0].headers.Authorization, "Bearer pnd_it_local");
  assert.equal(requests[0].url, baseUrl + "/models");
  assert.equal(requests[0].signal, signal);
  assert.equal(requests[0].redirect, "error");
  assert.deepEqual(provider.filterModels(provider.getModels(), undefined).map(m => m.id), ["auto", "auto:cost"]);
  const allowed = provider.filterModels(provider.getModels(), undefined)[0];
  const unavailable = { ...allowed, id: "auto:quality" };
  const unknown = { ...allowed, id: "other" };
  assert.deepEqual(provider.filterModels([allowed, unknown, unavailable], undefined), [allowed]);
  assert.deepEqual(provider.filterModels([allowed], { key: "pnd_it_other" }), []);
  for (const entry of [unavailable, unknown, { ...allowed, baseUrl: "https://another.test/v1" }]) {
    assert.throws(() => provider.streamSimple(entry, {}, { apiKey: "pnd_it_local" }), /no cached grant/);
  }
  assert.throws(() => provider.stream(allowed, {}, { apiKey: "pnd_it_another" }), /no cached grant/);
  assert.throws(() => provider.stream(allowed, {}, { apiKey: "pnd_it_local" }), /Transport called/);
});

test("failed, switched, or removed credentials cannot retain a previous model grant", async () => {
  const { provider, refresh, requests, key, respond } = rig();
  await refresh();
  await refresh({ allowNetwork: false });
  assert.equal(requests.length, 1);
  assert.equal(provider.filterModels(provider.getModels(), undefined).length, 2);
  key("pnd_it_new");
  await refresh({ allowNetwork: false });
  assert.deepEqual(provider.filterModels(provider.getModels(), undefined), []);
  respond(() => Response.json({ data: [{ id: "panel:panda" }] }));
  await refresh();
  assert.deepEqual(provider.filterModels(provider.getModels(), undefined).map(m => m.id), ["panel:panda"]);
  respond(() => new Response("private error detail", { status: 403 }));
  await assert.rejects(refresh(), { message: "Panda model discovery failed (HTTP 403)." });
  assert.deepEqual(provider.filterModels(provider.getModels(), undefined), []);
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
  assert.deepEqual(provider.filterModels(provider.getModels(), undefined).map(m => m.id), ["auto", "auto:cost"]);
});

test("router IDs require a listed coding route and the router's own grant", () => {
  const routers = ["auto", "auto:cost", "auto:quality"];
  assert.equal(new Set(backendGrants).size, 2);
  assert.ok(backendGrants.every(id => typeof id === "string" && !ids.includes(id)));
  const get = ids => permittedModels(ids.map(id => ({ id })), baseUrl).map(row => row.id);
  assert.deepEqual(get([...routers, "gemma-4-26b", "panel:panda-quality"]), ["panel:panda-quality"]);
  assert.deepEqual(get(backendGrants), []);
  for (const id of [...backendGrants, "panel:panda"]) {
    for (const router of routers) assert.equal(get([router, id]).includes(router), id !== "panel:panda" || router !== "auto:cost");
  }
});

test("host-only discovery binds cached grants to resolved endpoint, scoped credential and rotation", async () => {
  const { provider, refresh, requests, cached } = rig();
  await refresh({ allowNetwork: false, credential: undefined });
  assert.equal(requests.length, 0);
  const override = "http://localhost:4999/staging/v1";
  let scoped = "pnd_it_staging";
  const auth = () => provider.auth.apiKey.resolve({ signal, ctx: { env: async () => scoped } });
  await auth();
  await refresh({ baseUrl: override, credential: { key: scoped } });
  assert.equal(requests[0].url, override + "/models");
  assert.equal((await auth()).auth.baseUrl, override);
  assert.equal(provider.acceptsTarget({ api: "openai-completions", baseUrl: override }), true);
  assert.equal(provider.acceptsTarget({ api: "openai-responses", baseUrl: override }), false);
  assert.equal(provider.acceptsTarget({ api: "openai-completions", baseUrl }), false);
  const snapshot = cached();
  assert.ok(!JSON.stringify(snapshot).includes(scoped));
  await refresh({ allowNetwork: false, baseUrl: override, credential: undefined });
  await auth();
  assert.equal(provider.filterModels(snapshot.models, undefined).length, 2);
  scoped = "pnd_it_rotated";
  await auth();
  assert.deepEqual(provider.filterModels(snapshot.models, undefined), []);
  scoped = undefined;
  await auth();
  assert.deepEqual(provider.filterModels(snapshot.models, undefined), []);
  await refresh({ allowNetwork: false, baseUrl, credential: { key: "pnd_it_staging" } });
  assert.deepEqual(provider.filterModels(snapshot.models, { key: "pnd_it_staging" }), []);
  assert.equal(requests.length, 1);
});

test("discovery failures expose no upstream body or transport details", async () => {
  const { refresh, respond, provider } = rig();
  for (const supply of [() => new Response("private-marker"), () => { throw Error("private-marker"); }]) {
    respond(supply);
    await assert.rejects(refresh(), { message: "Could not read the Panda model catalog. Check your endpoint and credentials." });
    assert.deepEqual(provider.filterModels(provider.getModels(), undefined), []);
  }
});

test("an authenticated empty grant stays empty in both registered and available inventories", async () => {
  const { provider, refresh, respond } = rig();
  assert.equal(provider.getModels().length, 5);
  respond(() => Response.json({ data: ["auto","auto:cost","auto:quality","gemma-4-26b"].map(id=>({id})) }));
  await refresh();
  assert.deepEqual(provider.getModels().map(model => model.api), ["openai-completions"]);
  assert.deepEqual(provider.getAllModels(), []);
  assert.deepEqual(provider.filterModels([{ ...catalog[0], provider: "panda", baseUrl }], undefined), []);
});

test("authenticated snapshots retain route eligibility across restarts and exclude injected selectors", async () => {
  const original = rig();
  const cold = original.provider.getModels().map(model => model.id);
  assert.deepEqual(cold, ids);
  original.respond(() => Response.json({ data: ["auto:cost", backendGrants[1], "other"].map(id => ({id})) }));
  await original.refresh();
  const snapshot = original.cached();
  assert.match(snapshot.etag, /^panda-v2-[a-f0-9]{64}$/);
  assert.deepEqual(snapshot.models.map(model => model.id), ["auto:cost"]);
  const fresh = rig();
  await fresh.refresh({ allowNetwork: false, stored: snapshot });
  assert.deepEqual(fresh.provider.getAllModels().map(model => model.id), ["auto:cost"]);
  assert.equal(fresh.provider.filterAllModels([...modelDefinitions(baseUrl), {...snapshot.models[0], type:"image"}]).length, 1);
  for (const id of backendGrants) {
    assert.throws(() => fresh.provider.streamSimple({...snapshot.models[0], id}, {}, {apiKey:"pnd_it_local"}), /no cached grant/);
  }
  const injected = { ...snapshot, models: [...snapshot.models, ...modelDefinitions(baseUrl)] };
  await fresh.refresh({ allowNetwork: false, stored: injected });
  assert.deepEqual(fresh.provider.filterModels(modelDefinitions(baseUrl)), []);
  assert.equal(fresh.requests.length, 0);
});

test("old scoped snapshots migrate underlying grants without exposing retired or unknown IDs", async () => {
  const old = (models, token = "pnd_it_local") => ({
    etag: "panda-v1-" + createHash("sha256").update(baseUrl).update("\0").update(token).digest("hex"),
    models: models.map(id => ({ id, provider: "panda", api: "openai-completions", baseUrl })),
  });
  for (const [raw, expected] of [
    [[...ids, ...backendGrants, "foreign"], ids],
    [["auto:cost", backendGrants[0]], ["auto:cost"]],
    [["auto:cost", backendGrants[1]], ["auto:cost"]],
    [["auto:cost", "auto", "auto:quality", "panel:panda"], ["auto", "auto:quality", "panel:panda"]],
    [["auto:cost", "auto:quality", "panel:panda-quality"], ["panel:panda-quality"]],
    [backendGrants, []],
  ]) {
    const fresh = rig();
    const stored = old(raw);
    await fresh.refresh({ allowNetwork: false, stored });
    assert.deepEqual(fresh.provider.getAllModels().map(model => model.id), expected);
    assert.deepEqual(fresh.provider.filterModels(modelDefinitions(baseUrl)).map(model => model.id), expected);
    assert.equal(fresh.requests.length, 0);
    const injected = old(["auto:cost", backendGrants[0]]);
    injected.models[1].provider = "another-provider";
    await fresh.refresh({ allowNetwork: false, stored: injected });
    assert.deepEqual(fresh.provider.filterModels(modelDefinitions(baseUrl)), []);
    fresh.key("pnd_it_changed");
    await fresh.refresh({ allowNetwork: false, stored });
    assert.deepEqual(fresh.provider.filterModels(modelDefinitions(baseUrl)), []);
  }
});


test("cache-only picker resolves only the scoped credential and detects rotation without a refresh", async () => {
  const names = [];
  const env = key => { names.push(key); return { A:"local", B:"fixture" }[key]; };
  assert.equal(configuredToken("pnd_it_saved",env),"pnd_it_saved");
  assert.equal(configuredToken("OTHER_KEY",env),undefined);
  assert.equal(configuredToken("!secret-command",env),undefined);
  assert.deepEqual(names,[]);
  assert.equal(configuredToken("pnd_it_${A}-$B-$$-$!",env),"pnd_it_local-fixture-$-!");
  assert.deepEqual(names,["A","B"]);
  assert.equal(configuredToken("pnd_it_$MISSING",env),undefined);
  let key = "pnd_it_local";
  for (const defaultEnv of [true, false]) {
    const setup = rig(() => ({defaultEnv, key}));
    await setup.refresh();
    await setup.provider.auth.apiKey.resolve({ctx:{env: () => key},signal});
    const rows = setup.provider.getModels();
    assert.equal(setup.provider.filterModels(rows).length, 2);
    key = "pnd_it_replaced";
    assert.equal(setup.provider.filterModels(rows).length, 0);
    assert.equal(setup.provider.filterModels(rows,{key:"pnd_it_local"}).length, 2);
    key = undefined;
    assert.equal(setup.provider.filterModels(rows).length, 0);
    key = "pnd_it_local";
  }
});
