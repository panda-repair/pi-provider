import test from "node:test";
import assert from "node:assert/strict";
import { createRequestKeys, pandaStream } from "../src/request.js";

const model = { provider: "panda", id: "glm-5.3", baseUrl: "http://127.0.0.1:8100/v1" };
function fakeManager(id) {
  return { source: "user-entry", getSessionId: () => id,
    buildSessionProjection() { return { entries: [{ messages: [{}], sourceEntry: { id: this.source } }] }; } };
}

function fakeNative(model, context, options) {
  const operation = (async () => {
    const payload = await options.onPayload?.(context.body, model) ?? context.body;
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


test("ADR 0079 receives the native payload and complete replacements from peer extensions", async () => {
  const invoke = pandaStream(fakeNative, createRequestKeys(), () => {});
  const schema = { $schema: "https://json-schema.org/draft/2020-12/schema",
    $defs: { large: { description: "a".repeat(70_000) } }, properties: { name: { $ref: "#/$defs/large" } } };
  const native = { model: model.id, tools: [], tool_choice: "auto", messages: [
    { role: "assistant", reasoning_content: "prior reasoning", tool_calls: [{ id: "one", function: { name: "retired", arguments: "{}" } }] },
    { role: "tool", tool_call_id: "one", content: "prior result" },
  ] };
  const changed = { ...native, tools: [{ type: "function", function: { name: "active", parameters: schema } }],
    response_format: { type: "json_object" }, n: 2, logprobs: true, max_tokens: 0, max_completion_tokens: 80_000,
    metadata: { audit: "example" }, store: false, other_option: "requires-refusal" };
  for (const expected of [native, changed]) {
    let observed;
    await invoke(model, { body: native }, { apiKey: "fixture",
      onPayload: expected === changed ? (original, actualModel) => {
        assert.equal(original, native);
        assert.equal(actualModel, model);
        return changed;
      } : undefined,
      fetch: async (_url, init) => { observed = init.body; return new Response(); },
    }).result();
    assert.equal(observed, JSON.stringify(expected));
  }
});
