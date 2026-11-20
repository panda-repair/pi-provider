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

function clean(schema, tool = "read") {
  return pandaPayload({ tools: [{ type: "function", function: { name: tool, parameters: schema } }] },
    model).tools[0].function.parameters;
}

test("all canonical root dialect URIs normalize, and other markers fail before transport", async () => {
  const definition = { type: "string", description: "original" };
  const parameters = { $defs: { field: definition }, type: "object",
    properties: { value: { $ref: "#/$defs/field", description: "annotation" } } };
  for (const scheme of ["http", "https"]) {
    for (const fragment of ["", "#"]) {
      for (const path of ["draft/2020-12", "draft/2019-09", "draft-07"]) {
        const uri = scheme + "://json-schema.org/" + path + "/schema" + fragment;
        const out = clean({ ...parameters, $schema: uri });
        assert.deepEqual(out, { type: "object", properties: {
          value: { ...definition, description: path === "draft-07" ? "original" : "annotation" },
        } }, uri);
      }
    }
  }
  const invalid = [null, 7, {}, "json-schema.org/draft-07/schema", "HTTPS://json-schema.org/draft-07/schema",
    "https://example.test/draft-07/schema", "https://json-schema.org/draft-07/schema#other",
    "https://json-schema.org/draft-07/schema##", "https://json-schema.org/draft-07/schema/"];
  for (const scheme of ["http", "https"]) {
    for (const path of ["draft-04", "draft-06"]) {
      for (const fragment of ["", "#"]) invalid.push(scheme + "://json-schema.org/" + path + "/schema" + fragment);
    }
  }
  let sends = 0;
  const invoke = pandaStream(fakeNative, createRequestKeys(), () => {});
  for (const marker of invalid) {
    const tools = [{ type: "function", function: { name: "read", parameters: { ...parameters, $schema: marker } } }];
    const stream = invoke(model, { body: { tools } }, { apiKey: "pnd_it_fixture", fetch: async () => { sends++; return new Response(); } });
    await assert.rejects(stream.result(), /unsupported root JSON Schema dialect/);
  }
  assert.equal(sends, 0);
});

test("modern and legacy root references follow each dialect's annotation rules", () => {
  const uri = "https://json-schema.org/draft/2020-12/schema";
  const examples = [{ $schema: "literal", $ref: "literal" }];
  const schema = { $schema: uri, $defs: { "a/b": { $ref: "#/definitions/x~0y" }, unused: { $ref: "https://unused.invalid" } },
    definitions: { "x~y": { type: "integer", description: "from definition" } }, type: "object",
    properties: { $schema: { $ref: "#/%24defs/a~1b", description: "local annotation", examples } } };
  const modern = { type: "object", properties: { $schema: { type: "integer", description: "local annotation", examples } } };
  assert.deepEqual(clean(schema), modern);
  assert.deepEqual(clean({ ...schema, $schema: "http://json-schema.org/draft/2019-09/schema#" }), modern);
  const { $schema, ...unmarked } = schema;
  assert.deepEqual(clean(unmarked), modern);
  assert.deepEqual(clean({ ...schema, $schema: "https://json-schema.org/draft-07/schema#" }), {
    type: "object", properties: { $schema: { type: "integer", description: "from definition" } } });
  assert.equal(schema.properties.$schema.$ref, "#/%24defs/a~1b");
  const boolean = { $defs: { always: true }, $ref: "#/$defs/always" };
  assert.equal(clean(boolean), true);
  assert.throws(() => clean({ ...boolean, title: "x" }), /object schema/);
  assert.equal(clean({ ...boolean, title: "x", $schema: "http://json-schema.org/draft-07/schema" }), true);
});

test("schema data and map names survive expansion while schema-valued positions are resolved", () => {
  const literal = { $ref: "https://example.invalid/literal", $schema: "data", $id: "data" };
  const value = { type: "string" };
  const ref = { $ref: "#/$defs/T" };
  const schema = { $defs: { T: value }, const: literal, enum: [literal], default: literal, examples: [literal],
    patternProperties: { $ref: ref }, dependentSchemas: { $schema: ref }, dependentRequired: { $defs: ["$ref"] },
    dependencies: { $id: ["$schema"] }, oneOf: [{ if: ref, then: { not: ref }, else: { items: ref } }],
    vendor: { nested: ref } };
  const out = clean(schema);
  for (const k of ["const", "enum", "default", "examples", "dependentRequired", "dependencies"]) assert.deepEqual(out[k], schema[k]);
  assert.deepEqual([out.patternProperties.$ref, out.dependentSchemas.$schema, out.oneOf[0].if, out.oneOf[0].then.not,
    out.oneOf[0].else.items, out.vendor.nested], Array(6).fill(value));
});

test("invalid references, semantics-changing siblings, scopes and unsafe expansion fail locally", () => {
  const source = { $defs: { T: { type: "string" }, "a/b": {}, "": {}, "%zz": {} } };
  for (const pointer of ["https://remote.invalid/schema", "#/properties/T", "#/$defs/missing", "#/$defs/a%2Fb", "#/$defs/a~2", "#/$defs/%FF"]) {
    assert.throws(() => clean({ ...source, $ref: pointer }), /local|Pointer|UTF-8/);
  }
  for (const pointer of ["#/$defs/", "#/$defs/%zz", "#/%24defs/a~1b"]) assert.deepEqual(clean({ ...source, $ref: pointer }), {});
  for (const dialect of ["http://json-schema.org/draft-04/schema#", "https://json-schema.org/draft-06/schema", "urn:custom"]) {
    assert.throws(() => clean({ $schema: dialect }), /dialect/);
  }
  assert.throws(() => clean({ $schema: "https://json-schema.org/draft-07/schema", ...source, $ref: "#/$defs/T", minimum: 1 }), /only annotations/);
  assert.throws(() => clean({ $defs: [] }), /must be an object/);
  for (const bad of ["$schema", "$defs", "definitions", "$id"]) assert.throws(() => clean({ properties: { a: { [bad]: {} } } }), /schema location/);
  for (const bad of ["$anchor", "$dynamicRef", "$dynamicAnchor", "$recursiveRef", "$recursiveAnchor"]) {
    assert.throws(() => clean({ ...source, properties: { a: { [bad]: "x" } } }), /scoping keyword/);
  }
  assert.throws(() => clean({ $defs: { a: { $ref: "#/definitions/b" } }, definitions: { b: { $ref: "#/$defs/a" } }, $ref: "#/$defs/a" }), /cyclic/);
  const chain = n => ({ $defs: Object.fromEntries(Array.from({ length: n }, (_, i) =>
    ["n" + i, i + 1 === n ? { type: "string" } : { $ref: "#/$defs/n" + (i + 1) }])), $ref: "#/$defs/n0" });
  assert.deepEqual(clean(chain(32)), { type: "string" });
  assert.throws(() => clean(chain(33)), /32/);
  const bulky = { $defs: { T: { examples: Array(9).fill("x".repeat(4000)) } }, $ref: "#/$defs/T" };
  assert.doesNotThrow(() => clean(bulky));
  const tools = ["one", "two"].map(name => ({ type: "function", function: { name, parameters: bulky } }));
  assert.throws(() => pandaPayload({ tools },model), /copies exceed/);
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

function retryHarness() {
  const manager = fakeManager("session");
  const keys = createRequestKeys();
  keys.start(manager);
  const sent = [];
  const observed = [];
  const invoke = pandaStream((target, responses, options) => {
    const result = (async () => {
      let stopReason = "error";
      for (const next of responses) {
        try {
          const reply = await options.fetch(target.baseUrl, { method: "POST", body: "{}" });
          observed.push({ status: reply.status, headers: reply.headers, body: await reply.text() });
          stopReason = reply.ok && !next?.cut ? "stop" : "error";
        } catch {
          stopReason = "error";
        }
      }
      return { stopReason };
    })();
    return { result: () => result };
  }, keys, () => {});
  return { sent, observed, async run(...responses) {
    let index = 0;
    return invoke(model, responses, { apiKey: "pnd_it_fixture", sessionId: manager.getSessionId(),
      fetch: async (_url, init) => {
        sent.push(init.headers.get("idempotency-key"));
        const item = responses[index++];
        if (item === null) throw new TypeError("connection lost");
        if (item.response) return item.response;
        const body = item.body ?? JSON.stringify({ error: { message: "fixture", code: item.code } });
        return new Response(body, { status: item.status, headers: item.headers });
      } }).result();
  } };
}

test("HTTP outcomes choose identical keys in transport and whole-stream retries", async () => {
  const cases = [
    [null, true], [{ status: 200, cut: true }, true], [{ status: 500 }, true],
    ...["interrupted", "outcome_unknown", "mixture_store_unavailable", "inference_upstream_unavailable"].map(code => [{ status: 503, code }, true]),
    ...["model_unavailable", "model_refused"].map(code => [{ status: 503, code }, false]),
    ...["answer_invalid", "answer_incomplete", "no_answers"].map(code => [{ status: 502, code }, false]),
    ...[400, 401, 403, 408, 429].map(status => [{ status, code: "definite" }, false]),
    ...["mixture_already_failed", "mixture_idempotency_conflict"].map(code =>
      [{ status: 409, code, headers: { "idempotency-replayed": "true" } }, false]),
    [{ status: 503, body: "gateway" }, true],
    [{ status: 502, code: "unknown_server_code" }, true], [{ status: 409, body: "" }, false],
    [{ status: 409, body: "unreadable", headers: { "idempotency-replayed": "true" } }, true],
    [{ status: 409, body: JSON.stringify({ panda: { replay: true } }) }, true],
  ];
  for (const [first, same] of cases) {
    for (const layer of ["transport", "agent"]) {
      const h = retryHarness();
      if (layer === "transport") await h.run(first, { status: 200 });
      else { await h.run(first); await h.run({ status: 200 }); }
      assert.equal(h.sent.length, 2);
      assert.equal(h.sent[0] === h.sent[1], same, JSON.stringify([first, layer]));
      if (first?.code) assert.equal(JSON.parse(h.observed[0].body).error.code, first.code);
    }
  }
});

test("concurrent definite failures allow fresh attempts while ambiguous unknown failures block", async () => {
  const h = retryHarness();
  await Promise.all([h.run({ status: 503, code: "model_unavailable" }), h.run({ status: 502, code: "no_answers" })]);
  await h.run({ status: 200 });
  assert.equal(new Set(h.sent).size, 3);
  const unknown = retryHarness();
  await Promise.all([unknown.run({ status: 500 }), unknown.run({ status: 500 })]);
  assert.equal((await unknown.run({ status: 200 })).stopReason, "error");
  assert.equal(unknown.sent.length, 2);
});

test("completed and partial receipts stop both retry layers and retain bounded error details", async () => {
  for (const status of ["completed", "partial"]) {
    const h = retryHarness();
    const code = "mixture_already_" + status;
    const receipt = { error: { code, type: "invalid_request_error" }, panda: { status, charge: { minor_units: "1" } } };
    await h.run(null, { status: 409, body: JSON.stringify(receipt), headers: {
      "x-panda-request-id": "req_123", "idempotency-replayed": "true", "x-should-retry": "true" } }, { status: 200 });
    await h.run({ status: 200 });
    assert.equal(h.sent.length, 2);
    assert.equal(h.sent[0], h.sent[1]);
    assert.equal(h.observed.length, 3);
    for (const response of h.observed) {
      assert.equal(response.status, 409);
      assert.equal(response.headers.get("x-should-retry"), "false");
      assert.equal(response.headers.get("idempotency-replayed"), "true");
      const body = JSON.parse(response.body);
      assert.deepEqual(body.panda, receipt.panda);
      assert.equal(body.error.code, code);
      assert.match(body.error.message, /finished and was charged.*response was lost.*charge again.*req_123/);
    }
  }
});

test("a running replay returns the pending receipt locally on both transport and agent re-entry", async () => {
  const h = retryHarness();
  const code = "mixture_already_running";
  const panda = { replay: true, status: "running", request_id: "req_pending", run_id: "run-pending", charge: null, held: null };
  const running = { status: 409, headers: { "idempotency-replayed": "true", "x-should-retry": "true" },
    body: JSON.stringify({ error: { type: "invalid_request_error", code }, panda }) };
  await h.run(null, running, { status: 200 });
  await h.run({ status: 200 });
  assert.equal(h.sent.length, 2);
  assert.equal(h.sent[0], h.sent[1]);
  assert.equal(h.observed.length, 3);
  for (const response of h.observed) {
    assert.equal(response.status, 409);
    assert.equal(response.headers.get("idempotency-replayed"), "true");
    assert.equal(response.headers.get("x-should-retry"), "false");
    const receipt = JSON.parse(response.body);
    assert.deepEqual(receipt.panda, panda);
    assert.equal(receipt.error.code, code);
    assert.match(receipt.error.message, /identical request is still running.*will be charged when it completes.*answer cannot be recovered.*starts and charges a second run.*req_pending/is);
  }
});

test("large or misleading error envelopes preserve the original response and the uncertain key", async () => {
  const body = JSON.stringify({ error: { code: "model_unavailable", message: "x".repeat(32_768) } });
  for (const headers of [{}, { "content-length": "20" }, { "content-length": "50000" }]) {
    const h = retryHarness();
    await h.run({ status: 503, body, headers });
    await h.run({ status: 200 });
    assert.equal(h.sent[0], h.sent[1]);
    assert.equal(h.observed[0].body, body);
  }
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
