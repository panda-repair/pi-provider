import test from "node:test";
import assert from "node:assert/strict";
import { getEventListeners } from "node:events";
import backendGrants from "../src/routing-backend-grants.json" with { type: "json" };
import { boundedJSON, describeError, maxAnswerBytes, retryWait } from "../src/errors.js";
import { pandaStream } from "../src/request.js";
import { settlementAccounting } from "../src/usage.js";

const model = { provider: "panda", api: "openai-completions", id: "auto:cost", baseUrl: "http://127.0.0.1:8100/v1" };
const amount = minor_units => ({ schema_version: "panda.usd-amount.v1", currency: "USD", minor_units });
const runId = "run-" + "1".repeat(32);
const receipt = (status, cents) => ({ version:"panda.chat.v1", status, run_id: runId, request_id:"req_"+"2".repeat(32),
  charge: cents == null ? null : amount(cents), held: status === "running" ? null : amount("0") });
const privateText = "DO_NOT_RECORD";
const refusal = (status,code,panda,headers) => Response.json({error:{code,message:privateText},panda}, {status,headers});
const sse = data => new Response(data, {headers:{"content-type":"text/event-stream"}});
const completed = () => sse('data: {"choices":[{"delta":{"content":"yes"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n');
const initial = { role:"assistant", content:[], stopReason:"stop", usage:{input:0,output:0,cacheRead:0,cacheWrite:0,totalTokens:0,cost:{total:0}} };

function virtualExchange(t, timeoutMs, id = "panel:panda", expectedPosts = 1, hooks = {}) {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"] });
  t.mock.method(AbortSignal, "timeout", ms => {
    const controller = new AbortController();
    setTimeout(() => controller.abort(), ms);
    return controller.signal;
  });
  let pending = Promise.withResolvers();
  const retryStarted = Promise.withResolvers();
  const caller = new AbortController();
  const wire = { posts: 0, keys: [] };
  const fetch = (_url, init) => {
    const headers = pending;
    wire.posts++;
    if (wire.posts === 2) retryStarted.resolve();
    wire.keys.push(init.headers.get("idempotency-key"));
    wire.hint = init.headers.get("x-stainless-timeout");
    wire.signal = init.signal;
    const aborted = () => headers.reject(init.signal.reason);
    init.signal?.addEventListener("abort", aborted, { once: true });
    return headers.promise.finally(() => init.signal?.removeEventListener("abort", aborted));
  };
  const request = pandaStream((_model, _context, opts) => ({ async result() {
    // The stock OpenAI SDK times the entire custom fetch, including retries and HTTP error bodies.
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? 600_000);
    let response;
    try {
      response = await opts.fetch(model.baseUrl + "/chat/completions", {
        method: "POST", signal: controller.signal, body: JSON.stringify({ model: id }),
        headers: { authorization: "Bearer fixture", "x-stainless-timeout": String(Math.trunc(opts.timeoutMs / 1000)) },
      });
    } finally {
      clearTimeout(timer);
    }
    // Pi awaits its response hook before opening the SSE iterator and each event hook before advancing it.
    await opts.onResponse?.({ status: response.status, headers: response.headers }, _model);
    wire.forwarded = "";
    for await (const bytes of response.body) {
      const frame = Buffer.from(bytes).toString();
      wire.forwarded += frame;
      if (response.ok && opts.onProviderStreamEvent && frame !== "data: [DONE]\n\n") {
        await opts.onProviderStreamEvent(JSON.parse(frame.slice(6)), _model);
      }
    }
    return { ...initial, stopReason: response.ok ? "stop" : "error" };
  } }), () => {}, { accounting: settlementAccounting() });
  const result = request({ ...model, id }, {}, { apiKey: "fixture", timeoutMs, signal: caller.signal, fetch, ...hooks }).result();
  t.after(() => { caller.abort(); assert.equal(wire.posts, expectedPosts); });
  return {
    wire, result, retryStarted: retryStarted.promise, abort: () => caller.abort(),
    headers(status = 200, extra = {}) {
      const body = new ReadableStream({
        start(controller) { wire.body = controller; },
        cancel() { wire.cancelled = true; },
      }, { highWaterMark: 0 });
      pending.resolve(new Response(body, { status, headers: {
        "content-type": status === 200 ? "text/event-stream" : "application/json", ...extra,
      } }));
      pending = Promise.withResolvers();
    },
    async advance(ms = 0) {
      t.mock.timers.tick(ms);
      await new Promise(resolve => setImmediate(resolve));
    },
    write(text) { wire.body.enqueue(Buffer.from(text)); },
    finish(panda) {
      const finish = { choices: [{ delta: { content: "ordinary reply" }, finish_reason: "stop" }], panda };
      wire.body.enqueue(Buffer.from("data: " + JSON.stringify(finish) + "\n\ndata: [DONE]\n\n"));
      wire.body.close();
    },
  };
}

test("15-second Panda keepalives carry a six-minute Panel answer past Pi's five-minute idle limit", async t => {
  const call = virtualExchange(t, 300_000);
  call.headers();
  call.write(": panda\n\n");
  await call.advance();
  for (let i = 1; i < 24; i++) {
    await call.advance(15_000);
    assert.ok(!call.wire.cancelled, "the stream closed at " + i * 15 + " seconds");
    call.write(": keepalive\n\n");
    await call.advance();
  }
  await call.advance(15_000);
  call.finish();
  assert.equal((await call.result).stopReason, "stop");
  assert.match(call.wire.forwarded, /ordinary reply/);
  assert.doesNotMatch(call.wire.forwarded, /: panda|: keepalive/);
  assert.equal(call.wire.hint, "300");
  await call.advance(600_000);
  assert.equal(call.wire.signal.aborted, false, "finished calls release their timer");
  assert.equal(getEventListeners(call.wire.signal, "abort").length, 0);
});

test("a slow response hook preserves active bytes and a settlement received before it returns", async t => {
  const hook = Promise.withResolvers();
  const call = virtualExchange(t, 240, "panel:panda", 1, { onResponse: () => hook.promise });
  call.headers();
  call.write(": panda\n\n");
  await call.advance();
  for (let i = 0; i < 3; i++) {
    await call.advance(100);
    assert.equal(call.wire.signal.aborted, false);
    call.write(": keepalive\n\n");
    await call.advance();
  }
  call.finish(receipt("completed", "3"));
  await call.advance();
  await call.advance(520);
  assert.equal(call.wire.signal.aborted, false, "EOF stops the network deadline even before the first downstream read");
  hook.resolve();
  const message = await call.result;
  assert.equal(message.stopReason, "stop");
  assert.equal(message.usage.cost.total, .03);
  assert.match(call.wire.forwarded, /ordinary reply/);
  assert.doesNotMatch(call.wire.forwarded, /keepalive/);
});

test("short successive event hooks preserve ordered frames while later bytes and EOF arrive", async t => {
  const seen = [];
  const call = virtualExchange(t, 100, "auto", 1, { async onProviderStreamEvent(chunk) {
    seen.push(chunk.choices[0].delta.content);
    await new Promise(resolve => setTimeout(resolve, 23));
  } });
  const words = Array.from({ length: 12 }, (_, i) => String(i));
  call.headers();
  call.write(words.map(content => "data: " + JSON.stringify({ choices: [{ delta: { content } }] }) + "\n\n").join(""));
  await call.advance();
  for (let i = 1; i <= words.length + 1; i++) {
    await call.advance(23);
    if (i === 3) call.write(": keepalive\n\n");
    if (i === 6) call.finish(receipt("completed", "2"));
    await call.advance();
  }
  const message = await call.result;
  assert.deepEqual(seen, [...words, "ordinary reply"]);
  assert.equal(message.stopReason, "stop");
  assert.equal(message.usage.cost.total, .02);
});

for (const cause of ["silence", "caller abort", "oversized body"]) {
  test("a pending response hook releases the network reader on " + cause, async t => {
    const hook = Promise.withResolvers();
    const call = virtualExchange(t, 240, "panel:panda", 1, { onResponse: () => hook.promise });
    call.headers();
    call.write(": panda\n\n");
    await call.advance();
    if (cause === "silence") await call.advance(241);
    if (cause === "caller abort") call.abort();
    if (cause === "oversized body") call.write("x".repeat(maxAnswerBytes));
    await call.advance();
    assert.equal(call.wire.cancelled, true, "the upstream reader closed before the hook returned");
    hook.resolve();
    const message = await call.result;
    assert.equal(message.stopReason, cause === "caller abort" ? "aborted" : "error");
    assert.match(message.errorMessage, /may have run and been charged/);
    assert.equal(getEventListeners(call.wire.signal, "abort").length, 0);
  });
}

test("a delayed hook can still read a terminal receipt received before a socket stall", async t => {
  const hook = Promise.withResolvers();
  const call = virtualExchange(t, 240, "panel:panda", 1, { onResponse: () => hook.promise });
  call.headers();
  const data = { error: { code: "answer_invalid", message: privateText }, panda: receipt("failed", "3") };
  call.write("data: " + JSON.stringify(data) + "\n\n");
  await call.advance();
  await call.advance(241);
  assert.equal(call.wire.cancelled, true);
  hook.resolve();
  const message = await call.result;
  assert.equal(message.stopReason, "error");
  assert.equal(message.diagnostics[0].details.code, "answer_invalid");
  assert.equal(message.usage.cost.total, .03);
  assert.doesNotMatch(call.wire.forwarded, /DO_NOT_RECORD/);
});

test("EOF without a finish still reports an unknown outcome after a slow response hook", async t => {
  const hook = Promise.withResolvers();
  const call = virtualExchange(t, 240, "panel:panda", 1, { onResponse: () => hook.promise });
  call.headers();
  call.write('data: {"choices":[{"delta":{"content":"partial"}}]}\n\n');
  call.wire.body.close();
  await call.advance();
  await call.advance(520);
  assert.equal(call.wire.signal.aborted, false);
  hook.resolve();
  const message = await call.result;
  assert.equal(message.stopReason, "error");
  assert.match(message.errorMessage, /may have run and been charged/);
});

test("headers and partial SSE lines each restart the idle window, and a silent stream stops", async t => {
  const call = virtualExchange(t, 300_000);
  await call.advance(290_000);
  call.headers();
  await call.advance();
  await call.advance(290_000);
  assert.ok(!call.wire.cancelled);
  call.write(": keep");
  await call.advance();
  await call.advance(290_000);
  assert.ok(!call.wire.cancelled);
  call.write("");
  await call.advance();
  await call.advance(10_001);
  assert.equal(call.wire.cancelled, true);
  const message = await call.result;
  assert.equal(message.stopReason, "error");
  assert.match(message.errorMessage, /may have run and been charged/);
});

test("Auto uses a ten-minute header timeout when the caller supplies none", async t => {
  const call = virtualExchange(t, undefined, "auto:cost");
  await call.advance(599_999);
  assert.ok(!call.wire.signal?.aborted);
  assert.equal(call.wire.hint, "600");
  await call.advance(2);
  assert.equal(call.wire.signal?.aborted, true);
  assert.match((await call.result).errorMessage, /may have run and been charged/);
});

test("an explicit longer idle window permits headers past the standalone default", async t => {
  const call = virtualExchange(t, 650_000);
  await call.advance(649_999);
  call.headers();
  call.finish();
  assert.equal((await call.result).stopReason, "stop");
  assert.equal(call.wire.hint, "650");
});

test("a zero idle timeout permits both a long header wait and silence after admission", async t => {
  const call = virtualExchange(t, 0);
  await call.advance(700_000);
  call.headers();
  await call.advance();
  await call.advance(700_000);
  assert.ok(!call.wire.cancelled);
  call.finish();
  assert.equal((await call.result).stopReason, "stop");
  assert.equal(call.wire.hint, null);
});

test("caller cancellation after admission still closes a stream with its idle limit disabled", async t => {
  const call = virtualExchange(t, 0);
  call.headers();
  call.write(": panda\n\n");
  await call.advance();
  call.abort();
  const message = await call.result;
  assert.equal(message.stopReason, "aborted");
  assert.match(message.errorMessage, /may have run and been charged/);
  assert.equal(call.wire.cancelled, true);
  assert.equal(getEventListeners(call.wire.signal, "abort").length, 0);
});

test("an error after admission and keepalives remains a single terminal receipt without DONE", async t => {
  const call = virtualExchange(t, 300_000);
  call.headers();
  call.write(": panda\n\n");
  await call.advance();
  call.write(": keepalive\n\n");
  const data = { error: { code: "answer_invalid", message: privateText }, panda: receipt("failed", "3") };
  call.write("event: error\ndata: " + JSON.stringify(data) + "\n\n");
  const message = await call.result;
  assert.equal(message.stopReason, "error");
  assert.equal(message.diagnostics[0].details.code, "answer_invalid");
  assert.match(message.errorMessage, /US\$0\.03/);
  assert.doesNotMatch(JSON.stringify(message) + call.wire.forwarded, /DO_NOT_RECORD|: keepalive/);
  assert.equal(call.wire.cancelled, true);
});

test("HTTP error receipt bytes keep a slowly arriving settled charge readable", async t => {
  const call = virtualExchange(t, 300_000);
  await call.advance(290_000);
  call.headers(502);
  const text = JSON.stringify({ error: { code: "answer_invalid" }, panda: receipt("failed", "3") });
  call.write(text.slice(0, 10));
  await call.advance();
  await call.advance(290_000);
  call.write(text.slice(10));
  call.wire.body.close();
  const message = await call.result;
  assert.equal(message.stopReason, "error");
  assert.match(message.errorMessage, /US\$0\.03/);
});

test("a confirmed throttle can retry after a long active body, with the same key and a fresh header wait", async t => {
  const call = virtualExchange(t, 300_000, "auto:quality", 2);
  await call.advance(290_000);
  call.headers(429, { "retry-after": "0" });
  call.write('{"error":');
  await call.advance();
  await call.advance(290_000);
  call.write('{"code":"throttle_workspace_rate_limited"}}');
  call.wire.body.close();
  await call.advance();
  await call.advance(1);
  await Promise.race([call.retryStarted, call.result]);
  assert.equal(call.wire.posts, 2);
  await call.advance(290_000);
  call.headers();
  call.finish();
  assert.equal((await call.result).stopReason, "stop");
  assert.equal(new Set(call.wire.keys).size, 1);
});

function open(target, context, options) {
  const task = (async () => {
    const payload = await options.onPayload?.(context, target) ?? context;
    const reply = await options.fetch(target.baseUrl + "/chat/completions", {
      method:"POST", body:JSON.stringify(payload), headers:{authorization:"Bearer "+options.apiKey, "idempotency-key":"old"},
    });
    await reply.text();
    return {...initial,stopReason:reply.ok?"stop":"error"};
  })();
  return {result:()=>task};
}

function harness(replies, opts = {}) {
  const calls = [];
  const invoke = pandaStream(open, () => {}, { accounting: opts.accounting ?? settlementAccounting() });
  return { calls, send(options = {}, body = {model:model.id,tools:[]}, selected = model) {
    return invoke(selected,body,{apiKey:"fixture",...options,fetch:async (url,init) => {
      calls.push({url,key:init.headers.get("idempotency-key"),body:init.body});
      const make = replies.shift(); assert.ok(make,"unexpected POST"); return make();
    }}).result();
  }};
}

test("only the two authorized throttles internally repeat the identical request with one key", async () => {
  const a="throttle_mixture_concurrency_exhausted", b="throttle_workspace_rate_limited";
  const h=harness([()=>refusal(429,a,undefined,{"Retry-After":"0"}),()=>refusal(429,b,undefined,{"Retry-After":"0"}),completed,completed]);
  assert.equal((await h.send()).stopReason,"stop");
  assert.equal(h.calls.length,3); assert.equal(new Set(h.calls.map(c=>c.key)).size,1);
  assert.equal(new Set(h.calls.map(c=>c.body)).size,1); assert.match(h.calls[0].key,/^[\da-f-]{36}$/);
  await h.send(); assert.notEqual(h.calls[0].key,h.calls[3].key);
  const max=harness(Array.from({length:3},()=>()=>refusal(429,a,undefined,{"Retry-After":"0"})));
  assert.equal((await max.send()).stopReason,"error"); assert.equal(max.calls.length,3);
  for (const [status,code,headers] of [[429,a,{"x-should-retry":"false"}],[429,b,{"Retry-After":"61"}],
    [429,a,{"Retry-After":"bad"}],[429,"throttle_commercial_balance_source_bound_exceeded",{}],[503,a,{}]]) {
    const h=harness([()=>refusal(status,code,undefined,headers)]);
    const failed=await h.send();assert.equal(h.calls.length,1);assert.equal(failed.stopReason,"error");
  }
});

test("backoff observes delay, cancellation, the idle limit and validated Retry-After", async () => {
  const allowed=()=>refusal(429,"throttle_workspace_rate_limited",undefined,{"Retry-After":"1"});
  const h=harness([allowed,completed]); const start=Date.now();
  assert.equal((await h.send()).stopReason,"stop"); assert.ok(Date.now()-start >= 950);
  const short=harness([allowed]); assert.equal((await short.send({timeoutMs:30})).stopReason,"error"); assert.equal(short.calls.length,1);
  const aborted=harness([allowed]); const controller=new AbortController();
  const job=aborted.send({signal:controller.signal}); setTimeout(()=>controller.abort(),10);
  const cancellation=await job;
  assert.equal(cancellation.stopReason,"aborted"); assert.equal(aborted.calls.length,1);
  assert.match(cancellation.errorMessage,/did not admit.*No charge/);
  assert.doesNotMatch(cancellation.errorMessage,/may have run/);
  const now=Date.parse("Tue, 01 Dec 2026 10:00:00 GMT");
  assert.equal(retryWait("Tue, 01 Dec 2026 10:00:01 GMT",0,now),1000);
  assert.equal(retryWait("0",0),0); assert.equal(retryWait(null,1),500);
});

test("a standalone call, concurrent identical requests and intentional resends each get new keys", async () => {
  const h=harness([()=>{throw Error(privateText);},completed,completed,completed]);
  const failed=await h.send(); assert.match(failed.errorMessage,/may have run and been charged.*Resending starts a new run/);
  assert.doesNotMatch(JSON.stringify(failed),/DO_NOT_RECORD/);
  await Promise.all([h.send(),h.send(),h.send({sessionId:"explicit"})]);
  assert.equal(new Set(h.calls.map(c=>c.key)).size,4);
});

test("paid, zero, unknown and ordinary errors stop as soon as the first result arrives", async () => {
  for(const [status,code,panda,pattern] of [
    [500,"internal_error",undefined,/may have run and been charged/],[503,"interrupted",undefined,/may have run and been charged/],
    [503,"inference_upstream_unavailable",undefined,/may have run and been charged/],
    [502,"answer_invalid",receipt("failed","3"),/US\$0.03/],[502,"answer_invalid",receipt("failed","0"),/US\$0.00/],
    [502,"no_answers",receipt("failed",null),/settlement amount is unknown.*may have run/],
    [409,"mixture_idempotency_conflict",undefined,/original settlement is unknown/],
    [409,"mixture_already_completed",receipt("completed","0"),/US\$0.00/],
    [409,"mixture_already_running",receipt("running",null),/pending and may be zero/],
    [400,"context_length_exceeded",undefined,/admission limit/],
  ]) {
    const h=harness([()=>refusal(status,code,panda)]); const message=await h.send({maxRetries:6});
    assert.equal(h.calls.length,1); assert.equal(message.stopReason,"error"); assert.match(message.errorMessage,pattern);
    assert.equal(message.diagnostics[0].details.code,code); assert.doesNotMatch(JSON.stringify(message),/DO_NOT_RECORD/);
  }
});

test("only a saved positive receipt suppresses a later contribution to session spending", async () => {
  const original=receipt("failed","3"); const paid=()=>refusal(502,"answer_invalid",original);
  const replay=()=>refusal(409,"mixture_already_failed",{...original,replay:true});
  const account=settlementAccounting(), rows=[];
  account.bind({getEntries:()=>rows});
  const h=harness([paid,replay,paid],{accounting:account});
  const standalone=await h.send(), firstSaved=await h.send();
  assert.equal(standalone.usage.cost.total,.03);assert.equal(firstSaved.usage.cost.total,.03);
  rows.push({type:"message",message:structuredClone(firstSaved)});
  const dupe=await h.send(); // The service did not mark this copy as a replay.
  assert.equal(dupe.usage.cost.total,0);
  assert.equal(dupe.diagnostics[0].details.panda.charge.minor_units,"3");
  const fresh=settlementAccounting();fresh.bind({getEntries:()=>rows});
  assert.equal((await harness([replay],{accounting:fresh}).send()).usage.cost.total,0);
  assert.equal((await harness([replay]).send()).usage.cost.total,.03);
});

test("only safe error codes, field paths, settlement, and identifiers cross to Pi", () => {
  const result=describeError(502,{error:{code:"answer_invalid",param:"tools[1].function.parameters."+privateText,message:privateText},
    panda:{...receipt("failed","3"),agents:[privateText]},metadata:privateText},
    new Headers({"x-panda-request-id":"private "+privateText,"unrelated":privateText}));
  assert.equal(result.details.param,"tools[1].function.parameters");
  assert.equal(result.details.requestId,"req_"+"2".repeat(32));
  assert.doesNotMatch(JSON.stringify(result),/DO_NOT_RECORD/);
  const unknown=describeError(500,{error:{code:privateText,param:privateText}},new Headers());
  assert.deepEqual(unknown.details,{status:500});
});

test("ADR C bodies, peer replacements, history and literal backend values are preserved exactly", async () => {
  const schema={$schema:"https://json-schema.org/draft/2020-12/schema",$defs:{type:{description:"x".repeat(70000)}},$ref:"#/$defs/type"};
  const native={model:model.id,tools:[],messages:[{role:"assistant",reasoning_content:"earlier",
    tool_calls:[{id:"old",function:{name:"retired",arguments:"{}"}}]},{role:"tool",tool_call_id:"old",content:backendGrants[0]}]};
  const changed={...native,n:2,logprobs:true,max_tokens:0,max_completion_tokens:70000,response_format:{type:"json_object"},
    tools:[{type:"function",function:{name:"fixture",parameters:schema}}],panda:{synthesizer_model:backendGrants[1]}};
  const h=harness([completed,completed]); await h.send({},native); await h.send({onPayload:()=>changed},native);
  assert.deepEqual(h.calls.map(c=>c.body),[JSON.stringify(native),JSON.stringify(changed)]);
  for (const id of [...backendGrants,"panel:panda","unknown",undefined]) {
    const error=await h.send({onPayload:()=>({...native,model:id})},native);
    assert.match(error.errorMessage,/differs from the selected/);
  }
  assert.equal(h.calls.length,2);
});

test("foreign endpoints, changed bearer values and unexpected redirects stop locally", async () => {
  for(const [url,key] of [["http://invalid.example/v1/chat/completions","good"],[model.baseUrl+"/chat/completions","wrong"]]){
    let count=0;
    const req=pandaStream((_m,_c,opts)=>({result:async()=>{
      const res=await opts.fetch(url,{headers:{authorization:"Bearer "+key},body:JSON.stringify({model:model.id})});
      return {...initial,stopReason:res.ok?"stop":"error"};
    }}),()=>{});
    const error=await req(model,{}, {apiKey:"good",fetch:()=>{count++;}}).result();
    assert.equal(count,0);assert.match(error.errorMessage,/mismatched endpoint or credential/);
  }
  const h=harness([()=>new Response(null,{status:307,headers:{location:"http://invalid.example/"+privateText}})]);
  const result=await h.send();assert.match(result.errorMessage,/unexpected response endpoint or redirect/);
  assert.doesNotMatch(JSON.stringify(result),/DO_NOT_RECORD/);
});

test("the inner SDK can only read locally constructed error JSON and selected response headers", async () => {
  let json, headers;
  const invoke = pandaStream((_m,_c,options) => ({result:async()=>{
    const response=await options.fetch(model.baseUrl+"/chat/completions", {
      headers:{authorization:"Bearer fixture"},body:JSON.stringify({model:model.id})});
    json=await response.json(); headers=response.headers;
    return {...initial,stopReason:"error"};
  }}),()=>{});
  const panda=receipt("failed","3");
  await invoke(model,{}, {apiKey:"fixture",fetch:()=>Response.json({
    error:{code:"answer_invalid",param:"messages",message:privateText,metadata:{raw:privateText}},
    panda:{...panda,agents:[privateText]},private:privateText,
  },{status:502,headers:{"x-panda-request-id":runId,private:privateText}})}).result();
  assert.equal(json.error.code,"answer_invalid");assert.equal(json.error.param,"messages");
  assert.equal(json.panda.charge.minor_units,"3");assert.equal(json.request_id,runId);
  assert.equal(headers.get("x-should-retry"),"false");assert.doesNotMatch(JSON.stringify([json,[...headers]]),/DO_NOT_RECORD/);
});

test("a caller can reduce pre-admission retries and a later in-flight loss has an unknown outcome", async () => {
  const hold=()=>refusal(429,"throttle_workspace_rate_limited",undefined,{"retry-after":"0"});
  for (const limit of [0,1,2,9]) {
    const budget=Math.min(2,limit), h=harness(Array.from({length:budget+1},()=>hold));
    const result=await h.send({maxRetries:limit});
    assert.equal(h.calls.length,budget+1); assert.equal(new Set(h.calls.map(call=>call.key)).size,1);
    assert.match(result.errorMessage,/No charge was incurred/);
  }
  const never=harness([]);
  const cancelled=await never.send({signal:AbortSignal.abort()});
  assert.equal(cancelled.stopReason,"aborted"); assert.equal(never.calls.length,0);
  assert.match(cancelled.errorMessage,/did not send.*No charge/);
  const lost=harness([hold,()=>{throw new Error(privateText);}]);
  assert.match((await lost.send({maxRetries:1})).errorMessage,/may have run and been charged/);
  assert.equal(lost.calls.length,2);
});

test("valid Panel receipts at the public byte limit retain their settlement and expose no member text", async () => {
  const raw={error:{code:"answer_invalid",message:privateText},
    panda:{...receipt("failed","3"),agents:[{response:privateText+"🟢"}]}};
  const start=JSON.stringify(raw);
  const exact=start+" ".repeat(maxAnswerBytes-Buffer.byteLength(start));
  const reply=(text,length)=>new Response(new ReadableStream({
    async start(controller) {
      const bytes=Buffer.from(text); controller.enqueue(bytes.subarray(0,4000));
      await new Promise(resolve=>setTimeout(resolve,10));
      controller.enqueue(bytes.subarray(4000)); controller.close();
    },
  }),{status:502, headers:length===undefined?{}:{"content-length":String(length)}});
  for (const [data,length,valid] of [[exact,maxAnswerBytes,true],[exact,undefined,true],[exact+" ",35,false],
    [exact.slice(0,220),undefined,false]]) {
    const result=await harness([()=>reply(data,length)]).send();
    assert.equal(result.usage.cost.total,valid?.03:0);
    assert.equal(result.diagnostics?.[0]?.details.code,valid?"answer_invalid":undefined);
    assert.doesNotMatch(JSON.stringify(result),/DO_NOT_RECORD/);
  }
  const fixture=new Response(new ReadableStream({start(controller){controller.enqueue(Buffer.from("{"));}}));
  const before=Date.now();
  assert.equal(await boundedJSON(fixture,maxAnswerBytes,25),undefined);
  assert.ok(Date.now()-before<1500);
  void fixture.body.cancel();
});

test("every Pi spending-entry type carries Panda provenance through copies and restart", () => {
  const account=settlementAccounting(), rows=[];
  const id=n=>n.toString(16).padStart(32,"0");
  const apply=(n,replay)=>account.apply({...initial,provider:"panda"},{...receipt("failed","3"),run_id:id(n),replay});
  const bind=()=>account.bind({getEntries:()=>structuredClone(rows)});
  const usage=n=>JSON.parse(JSON.stringify(apply(n,false).usage));
  bind();
  const a=usage(1), b=usage(2);
  rows.push({type:"compaction",fromHook:true,usage:{...a,cost:{...a.cost}}},
    {type:"branch_summary",fromHook:true,usage:b},{type:"usage",usage:usage(3)},
    {type:"message",message:{role:"toolResult",usage:usage(4)}},
    {type:"message",message:{role:"assistant",provider:"other",usage:usage(5)}});
  for (let n=10;n<1035;n++) rows.push({type:"usage",usage:usage(n)});
  bind();
  for (const n of [1,2,3,4,5,10,1034]) assert.equal(apply(n,true).usage.cost.total,0);
  const duplicateCost=apply(1,true).usage.cost;
  const free=account.apply(initial,{...receipt("completed","0"),run_id:id(7)});
  assert.equal(duplicateCost.pandaRunIds,undefined);
  assert.equal(free.usage.cost.pandaRunIds,undefined);
  rows.push({type:"usage",usage:{cost:{...free.usage.cost,total:.05}}});
  assert.equal(apply(7,true).usage.cost.total,.03);
  const newReceipt=apply(1035,true); assert.equal(newReceipt.usage.cost.total,.03);
  rows.push({type:"usage",usage:newReceipt.usage}); assert.equal(apply(1035,false).usage.cost.total,0);
  // A numeric-only foreign result, free legacy row, or detached marker never established this charge.
  rows.push({type:"compaction",id:"foreign",fromHook:true,usage:{cost:{total:.03}}},
    {type:"usage",usage:{cost:{total:.03,pandaRunIds:id(8)+"x"}}},
    {type:"usage",usage:{cost:{total:.03,pandaRunIds:{}}}},
    {type:"message",message:{...apply(8,true),usage:{cost:{total:0}},diagnostics:[
      {type:"panda.settlement",details:{runId:id(8),counted:false}}]}},
    {type:"custom",customType:"panda.checkpoint_receipts",data:{runIds:[id(8)],checkpointId:"missing"}},
    {type:"custom",customType:"panda.checkpoint_receipts",data:{runIds:[id(8)],checkpointId:"foreign"}});
  assert.equal(apply(8,true).usage.cost.total,.03);
  for(let i=0;i<2;i++) assert.equal(account.apply(initial,{...receipt("failed","3"),run_id:undefined,replay:true}).usage.cost.total,.03);
});

test("the idle timeout permits slow receipts and bounds an incomplete error stream", async () => {
  const text=Buffer.from(JSON.stringify({error:{code:"answer_invalid",message:privateText},panda:receipt("failed","3")}));
  const split=()=>new Response(new ReadableStream({
    async start(controller) {
      controller.enqueue(text.subarray(0,10));
      await new Promise(resolve=>setTimeout(resolve,5100));
      controller.enqueue(text.subarray(10));controller.close();
    }
  }),{status:502});
  const h=harness([split]);
  const result=await h.send({timeoutMs:10000});
  assert.equal(result.usage.cost.total,.03);assert.doesNotMatch(JSON.stringify(result),/DO_NOT_RECORD/);
  const stalled=harness([()=>new Response(new ReadableStream({start(c){c.enqueue(Buffer.from("{"));}}),{status:502})]);
  const started=Date.now();
  assert.match((await stalled.send({timeoutMs:30})).errorMessage,/may have run/);
  assert.ok(Date.now()-started<1500);
});

test("a native split records its paid Panda legs, including when another leg supplies other usage", () => {
  const account=settlementAccounting(), rows=[];
  account.bind({getEntries:()=>rows});
  const append=(type,data)=>rows.push({type:"custom",customType:type,data});
  const op=new AbortController(), agentHeaders={};
  const id=n=>n.toString(16).padStart(32,"0");
  const pay=(n,headers,cents="3")=>account.apply(initial,{...receipt("completed",cents),run_id:id(n)},{signal:op.signal,headers});
  account.beginSplit(op.signal);
  pay(8,{}); // An incidental custom extension reused the operation signal.
  account.agentHeaders(agentHeaders);
  pay(1,agentHeaders);
  pay(2,agentHeaders,"0");
  const entry={type:"compaction",id:"saved",usage:{cost:{total:.07}}}; // Includes another provider's cost.
  rows.push(entry);account.endSplit(entry,append);account.endSplit(entry,append);
  assert.deepEqual(rows[1].data,{checkpointId:"saved",runIds:[id(1)]});
  assert.equal(pay(1,{}).usage.cost.total,0);assert.equal(pay(8,{}).usage.cost.total,.03);
  account.beginSplit(op.signal);account.agentHeaders(agentHeaders);pay(9,agentHeaders);
  account.endSplit();assert.equal(pay(9,{}).usage.cost.total,.03);
});

test("the byte bound includes the whole UTF-8 SSE and allows large validated error events", async () => {
  const data=JSON.stringify({error:{code:"answer_invalid",message:privateText},panda:{...receipt("failed","3"),agents:[privateText+"🟢"]}});
  const head="event: error\r\ndata: "+data;
  const frame=head+" ".repeat(maxAnswerBytes-Buffer.byteLength(head)-4)+"\r\n\r\n";
  for(const [body,valid] of [[frame,true],[frame+" ",false]]) {
    const result=await harness([()=>sse(body)]).send();
    assert.equal(result.usage.cost.total,valid?.03:0);
    assert.doesNotMatch(JSON.stringify(result),/DO_NOT_RECORD/);
  }
});
