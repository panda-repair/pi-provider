import test from "node:test";
import assert from "node:assert/strict";
import { catalog } from "../src/catalog.js";
import { beforeProviderRequest, createRequestKeys, pandaPayload, pandaStream } from "../src/request.js";

const model = { provider: "panda", id: "glm-5.3", baseUrl: "http://127.0.0.1:8100/v1" };
const max = catalog.find(entry => entry.id === model.id).maxTokens;
const messages = [{ role: "developer", content: "Read requested files." }, { role: "user", content: "Hello" }];

test("payload allowlist preserves supported content, tools and usage while dropping unsupported options", () => {
  const tools = [{ type: "function", function: { name: "read", parameters: { type: "object" } } }];
  const input = { model: model.id, messages, tools, tool_choice: "auto", temperature: 0.5,
    store: false, reasoning_effort: "high", frequency_penalty: 0, presence_penalty: 0, metadata: {},
    prompt_cache_key: "a", prompt_cache_retention: "24h", surprise: 5, stream: true,
    stream_options: { include_usage: true, other: true }, response_format: { type: "json_object" }, n: 2, logprobs: true };
  assert.deepEqual(pandaPayload(input, model), { model: model.id, messages, tools,
    tool_choice: "auto", temperature: 0.5, stream: true, stream_options: { include_usage: true } });
  assert.equal(input.store, false);
  assert.deepEqual(pandaPayload({ messages, stream: false, stream_options: { include_usage: true }, tools: [] }, model),
    { messages, model: model.id, stream: false });
  assert.equal(pandaPayload(input, { ...model, provider: "other" }), input);
});

test("one integer output bound respects the smaller caller bound and the selected model cap", () => {
  assert.deepEqual(pandaPayload({ max_tokens: max + 10 }, model), { model: model.id, max_tokens: max });
  assert.deepEqual(pandaPayload({ max_completion_tokens: max + 2, max_tokens: 7 }, model),
    { model: model.id, max_completion_tokens: 7 });
  assert.deepEqual(pandaPayload({ max_tokens: -2 }, model), { model: model.id, max_tokens: 1 });
  assert.deepEqual(pandaPayload({ max_tokens: null }, model), { model: model.id });
});

test("schema adaptation removes dialect declarations without changing names, data, or reference semantics", () => {
  const uri = "https://json-schema.org/draft/2020-12/schema";
  const examples = [{ $schema: "literal", $ref: "literal" }];
  const clean = schema => pandaPayload({ tools: [{ type: "function", function: { name: "read", parameters: schema } }] },
    model).tools[0].function.parameters;
  const schema = { $schema: uri, $id: "file", $defs: { unused: { type: "string" } }, type: "object",
    properties: { $schema: { type: "string", examples }, items: { anyOf: [{ $schema: uri, type: "number" }] } } };
  assert.deepEqual(clean(schema), { type: "object", properties: {
    $schema: { type: "string", examples }, items: { anyOf: [{ type: "number" }] } } });
  assert.equal(schema.$schema, uri);
  assert.throws(() => clean({ properties: { child: { $ref: "#/$defs/child" } } }), /Inline the referenced schema/);
  assert.throws(() => clean({ $schema: "https://example.test/custom" }), /unsupported JSON Schema dialect/);
});

function fakeManager(id) {
  return { source: "user-entry", getSessionId: () => id,
    buildSessionProjection() { return { entries: [{ messages: [{}], sourceEntry: { id: this.source } }] }; } };
}

function fakeNative(model, context, options) {
  const operation = (async () => {
    const payload = await options.onPayload(context.body, model);
    let reply;
    for (let i = 0; i < (context.transports ?? 1); i++) {
      reply = await options.fetch(model.baseUrl, { method: "POST", headers: options.headers, body: JSON.stringify(payload) });
    }
    return { stopReason: reply.ok ? "stop" : "error" };
  })();
  return { result: () => operation };
}

test("failed logical requests retain their key, including when an extension changes replay bytes", async () => {
  const keys = createRequestKeys();
  const manager = fakeManager("session-one");
  keys.start(manager);
  const invoke = pandaStream(fakeNative, keys, () => {});
  async function call(status, { session = "session-one", text = "hello", token = "pnd_it_a", transports = 1, target = model } = {}) {
    const headers = [];
    await invoke(target, { body: { messages: [{ role: "user", content: text }] }, transports }, {
      apiKey: token, sessionId: session, headers: { "idempotency-key": "stale" },
      fetch: async (_url, init) => {
        const key = init.headers.get("idempotency-key");
        assert.match(key, /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/);
        assert.notEqual(key, "stale");
        headers.push(key);
        return new Response("", { status });
      },
    }).result();
    return headers;
  }
  const failed = await call(503, { transports: 2 });
  assert.equal(failed[0], failed[1]);
  assert.equal((await call(200))[0], failed[0]);
  assert.notEqual((await call(200))[0], failed[0]);
  const [original] = await call(503);
  assert.equal((await call(409, { text: "changed" }))[0], original);
  assert.notEqual((await call(200, { session: "second" }))[0], original);
  assert.notEqual((await call(200, { token: "pnd_it_b" }))[0], original);
  assert.notEqual((await call(200, { target: { ...model, id: "auto" } }))[0], original);
  manager.source = "tool-result-entry";
  assert.notEqual((await call(200))[0], original);
  manager.source = "user-entry";
  keys.settle(manager);
  keys.start(manager);
  assert.notEqual((await call(200))[0], original);
  const concurrent = await Promise.all([call(500), call(500)]);
  assert.notEqual(concurrent[0][0], concurrent[1][0]);
  await assert.rejects(call(200), /which failed request to retry/);
});

test("a nested foreign request sharing the same alias does not inherit Panda's transformations", async () => {
  const invoke = pandaStream(fakeNative, createRequestKeys(), () => {});
  const foreign = { model: model.id, messages, store: true };
  let sent;
  await invoke(model, { body: { model: model.id, messages, store: false } }, {
    apiKey: "pnd_it_a",
    onPayload: async payload => {
      assert.equal(beforeProviderRequest({ payload: foreign }), undefined);
      assert.equal(foreign.store, true);
      const normalized = beforeProviderRequest({ payload });
      assert.equal("store" in normalized, false);
      return { ...normalized, metadata: { addedAfterHook: true } };
    },
    fetch: async (_url, init) => { sent = JSON.parse(init.body); return new Response(); },
  }).result();
  assert.deepEqual(sent, { model: model.id, messages });
  assert.equal(beforeProviderRequest({ payload: foreign }), undefined);
});
