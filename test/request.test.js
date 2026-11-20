import test from "node:test";
import assert from "node:assert/strict";
import { describeError } from "../src/errors.js";
import { createRequestKeys, pandaStream } from "../src/request.js";

const model = { provider: "panda", id: "auto:cost", baseUrl: "http://127.0.0.1:8100/v1" };
function fakeManager(id) {
  return { source: "user-entry", getSessionId: () => id,
    buildSessionProjection() { return { entries: [{ messages: [{}], sourceEntry: { id: this.source } }] }; } };
}

function fakeNative(model, context, options) {
  const operation = (async () => {
    const payload = await options.onPayload?.(context.body, model) ?? context.body;
    let reply;
    for (let i = 0; i < (context.transports ?? 1); i++) {
      reply = await options.fetch(model.baseUrl + "/chat/completions", { method: "POST", headers: { ...options.headers, Authorization: "Bearer " + options.apiKey }, body: JSON.stringify(payload) });
    }
    return { stopReason: reply.ok ? "stop" : "error" };
  })();
  return { result: () => operation };
}

test("failed logical requests retain their key, including when an extension changes replay bytes", async () => {
  const keys = createRequestKeys();
  const manager = fakeManager("session-one");
  keys.start(manager);
  keys.start(fakeManager("second"));
  const invoke = pandaStream(fakeNative, keys, () => {});
  async function call(status, { session = "session-one", text = "hello", token = "pnd_it_a", transports = 1, target = model } = {}) {
    const headers = [];
    await invoke(target, { body: { model: target.id, messages: [{ role: "user", content: text }] }, transports }, {
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

function retryHarness(selected = model) {
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
          const reply = await options.fetch(target.baseUrl + "/chat/completions", { method: "POST", body: JSON.stringify({model:target.id}), headers: { authorization: "Bearer " + options.apiKey } });
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
    return invoke(selected, responses, { apiKey: "pnd_it_fixture", sessionId: manager.getSessionId(),
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
    ...["model_unavailable", "model_refused"].map(code => [bill(503,code,"failed",amount("0")), false]),
    ...["answer_invalid", "answer_incomplete", "no_answers"].map(code => [bill(502,code,"failed",amount("0")), false]),
    [{ status: 400, code: "unsupported_parameter" }, false],
    [{ status: 429, code: "throttle_workspace_rate_limited" }, false],
    [{ status: 503, body: "gateway" }, true],
    [{ status: 502, body: "unknown" }, true], [{ status: 409, body: "" }, true],
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
  await Promise.all([h.run(bill(503,"model_unavailable","failed",amount("0"))), h.run(bill(502,"no_answers","failed",amount("0")))]);
  await h.run({ status: 200 });
  assert.equal(new Set(h.sent).size, 3);
  const unknown = retryHarness();
  await Promise.all([unknown.run({ status: 500 }), unknown.run({ status: 500 })]);
  assert.equal((await unknown.run({ status: 200 })).stopReason, "error");
  assert.equal(unknown.sent.length, 2);
});

test("ADR 0079 receives the native payload and complete replacements from peer extensions", async () => {
  const keys = createRequestKeys();
  keys.start(fakeManager("wire"));
  const invoke = pandaStream(fakeNative, keys, () => {});
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
    await invoke(model, { body: native }, { apiKey: "fixture", sessionId: "wire",
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

test("mismatched chat destinations and Authorization overrides cannot use the granted credential", async () => {
  let sent = 0;
  for (const [target, value] of [["http://elsewhere.invalid/v1/chat/completions", "Bearer secret"],
      [model.baseUrl + "/chat/completions", "Bearer another"]]) {
    const run = pandaStream((_m, _c, options) => {
      const result = options.fetch(target, { headers: { authorization: value }, body: "{}" });
      return { result: () => result };
    }, createRequestKeys(), () => {});
    const events = run(model, {}, { apiKey: "secret", fetch: () => { sent++; } });
    await assert.rejects(events.result(), /mismatched endpoint or credential/);
  }
  assert.equal(sent, 0);
});

const amount = minor_units => ({ schema_version: "panda.usd-amount.v1", currency: "USD", minor_units });
const validId = "req_" + "1".repeat(32);
function bill(status, code, settlement, charge) {
  return { status, body: JSON.stringify({ error: { code, message: "DO_NOT_RECORD", metadata: { raw: "DO_NOT_RECORD" } },
    panda: { version: "panda.chat.v1", status: settlement, request_id: validId, agents: ["DO_NOT_RECORD"],
      charge, held: settlement === "running" ? null : amount("0") } }) };
}

test("Panel and routed failures stop both retry layers unless the settlement proves zero", async () => {
  for (const id of ["auto:cost", "panel:panda", "auto:quality"]) {
    for (const charge of [amount("3"), undefined, { ...amount("0"), currency: "other" }, amount("00"), amount("0")]) {
      for (const layer of ["agent", "provider"]) {
        const h = retryHarness({ ...model, id });
        const first = bill(502, "answer_invalid", "failed", charge);
        if (layer === "agent") { await h.run(first); await h.run({ status: 200 }); }
        else await h.run(first, { status: 200 });
        if (charge?.minor_units === "0" && charge.currency === "USD") {
          assert.equal(h.sent.length, 2);
          assert.notEqual(...h.sent);
        } else {
          assert.equal(h.sent.length, 1);
          assert.equal(h.observed[1].body, h.observed[0].body);
          assert.doesNotMatch(h.observed[0].body, /DO_NOT_RECORD/);
          assert.match(h.observed[0].body, charge?.minor_units === "3" ? /US\$0\.03/ : /amount is unknown/);
        }
      }
    }
  }
});

test("running, settled and conflicting receipts are safe and terminal at both layers", async () => {
  for (const [code, state, charge, wording] of [
    ["mixture_already_running","running",null,/still running.*may be zero/],
    ["mixture_already_partial","partial",amount("3"),/US\$0\.03/],
    ["mixture_already_completed","completed",amount("0"),/US\$0\.00/],
    ["mixture_already_failed","failed",amount("5"),/US\$0\.05/],
    ["mixture_idempotency_conflict","failed",amount("0"),/original settlement is unknown/],
  ]) {
    const h = retryHarness();
    await h.run(null, bill(409,code,state,charge), { status: 200 });
    const repeated = await h.run({ status: 200 });
    assert.equal(h.sent.length,2);
    assert.equal(h.sent[0],h.sent[1]);
    assert.match(repeated.errorMessage,wording);
    for (const res of h.observed) {
      assert.equal(res.status,409);
      assert.equal(res.headers.get("x-should-retry"),"false");
      assert.doesNotMatch(res.body,/DO_NOT_RECORD/);
      assert.equal(JSON.parse(res.body).error.code,code);
    }
  }
});

test("error redaction keeps only recognized parameters, status codes, amounts and identifiers", async () => {
  const bad = "DO_NOT_RECORD";
  const err = (code,param) => describeError(400, { error: { code,param,message:bad },
    panda: {version:"panda.chat.v1", status:"failed", request_id:bad, run_id:bad, agents:[bad]} },
    new Headers({"x-panda-request-id":bad,"x-other":bad}),model);
  assert.match(err("context_length_exceeded","messages").message,/maximum context length/);
  assert.equal(JSON.parse(err("unsupported_parameter","tools[1].function.parameters."+bad).body).error.param,"tools[1].function.parameters");
  assert.equal(JSON.parse(err(bad,bad).body).error.param,null);
  assert.doesNotMatch(err(bad,bad).body,/DO_NOT_RECORD/);
  for (const headers of [{}, {"content-length":"2"}, {"content-length":"50000"}]) {
    const h=retryHarness();
    await h.run({status:503,body:bad.repeat(4000),headers});
    await h.run({status:200});
    assert.equal(h.sent[0],h.sent[1]);
    assert.doesNotMatch(h.observed[0].body,/DO_NOT_RECORD/);
  }
});

test("summary operation references isolate converging bodies, renew after success, and fail closed without identity", () => {
  const keys=createRequestKeys(); const options={sessionId:"same-route",cacheRetention:"none",apiKey:"key"};
  const context=()=>({messages:[{role:"user",content:"same",timestamp:1}]});
  const a=context(), b=context();
  const one=keys.reserve(options,a,model,"{}"), two=keys.reserve(options,b,model,"{}");
  assert.notEqual(one.key,two.key);
  one.finish("error"); two.finish("error");
  const retry=keys.reserve(options,a,model,"different");
  assert.equal(retry.key,one.key);
  retry.finish("stop");
  assert.notEqual(keys.reserve(options,a,model,"{}").key,one.key);
  assert.equal(keys.reserve(options,b,model,"{}").key,two.key);
  assert.throws(()=>keys.reserve({}, {},model,"{}"),/identify this operation/);
});

test("fresh attempts require a proved zero settlement or the documented pre-admission status and code", () => {
  const action = (status, code, panda) => describeError(status, { error: { code }, panda }, new Headers(), model).action;
  assert.equal(action(502, "answer_invalid"), "terminal");
  for (const held of [undefined, null, amount("3"), {currency:"USD", minor_units:"0"}]) {
    assert.equal(action(502, "answer_invalid", {version:"panda.chat.v1", status:"failed", charge:amount("0"), held}), "terminal");
  }
  assert.equal(action(500, "internal_error", { version:"panda.chat.v1", status:"partial", charge:null }), "terminal");
  assert.equal(action(503, "unsupported_parameter"), "same");
  assert.equal(action(400, "unsupported_parameter"), "fresh");
  assert.equal(action(429, "throttle_workspace_rate_limited"), "fresh");
});

test("cache-disabled foreground retries use the projected entry even when Pi clones messages", () => {
  const keys = createRequestKeys();
  const user = { role: "user", content: "Keep this request.", timestamp: 1 };
  const manager = { getSessionId: () => "foreground", buildSessionProjection: () => ({
    entries: [{ messages: [user], sourceEntry: { id: "entry" } }],
  }) };
  const options = { sessionId: "foreground", cacheRetention: "none", apiKey: "fixture" };
  keys.start(manager);
  const first = keys.reserve(options, { messages: [structuredClone(user)] }, model, "{}");
  first.finish("error");
  const retry = keys.reserve(options, { messages: [structuredClone(user)] }, model, "{}");
  assert.equal(retry.key, first.key);
  const synthetic = { ...user, content: "Summarize the conversation." };
  assert.notEqual(keys.reserve(options, { messages: [synthetic] }, model, "{}").key, retry.key);
});

test("peer extensions cannot substitute the paid target and backend names remain valid in customer content", async () => {
  let dispatched = 0;
  const keys = createRequestKeys();
  keys.start(fakeManager("target"));
  const request = pandaStream(fakeNative, keys, () => {});
  const params = { model: "auto:cost", messages: [{ role: "user", content: "Compare the backend IDs." }] };
  const options = { apiKey: "fixture", sessionId: "target", fetch: async () => { dispatched++; return new Response(""); } };
  for (const replacement of ["glm-5.3", "deepseek-v4.1-flash", "panel:panda", "unknown", undefined]) {
    const events = request(model, { body: params }, { ...options, onPayload: payload => ({ ...payload, model: replacement }) });
    await assert.rejects(events.result(), /differs from the selected/);
  }
  assert.equal(dispatched, 0);
  const panel = { ...model, id: "panel:panda" };
  const literal = { model: panel.id, messages: [{ role: "user", content: "glm-5.3" }], panda: { synthesizer_model: "deepseek-v4.1-flash" } };
  await request(panel, { body: literal }, { ...options, fetch: async (_url, init) => {
    assert.equal(init.body, JSON.stringify(literal));
    dispatched++;
    return new Response("");
  } }).result();
  assert.equal(dispatched, 1);
});
