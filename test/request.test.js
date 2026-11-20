import test from "node:test";
import assert from "node:assert/strict";
import backendGrants from "../src/routing-backend-grants.json" with { type: "json" };
import { describeError, retryWait } from "../src/errors.js";
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

test("backoff observes delay, cancellation, total deadline and validated Retry-After", async () => {
  const allowed=()=>refusal(429,"throttle_workspace_rate_limited",undefined,{"Retry-After":"1"});
  const h=harness([allowed,completed]); const start=Date.now();
  assert.equal((await h.send()).stopReason,"stop"); assert.ok(Date.now()-start >= 950);
  const short=harness([allowed]); assert.equal((await short.send({timeoutMs:30})).stopReason,"error"); assert.equal(short.calls.length,1);
  const aborted=harness([allowed]); const controller=new AbortController();
  const job=aborted.send({signal:controller.signal}); setTimeout(()=>controller.abort(),10);
  assert.equal((await job).stopReason,"error"); assert.equal(aborted.calls.length,1);
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

test("valid failed settlement is counted once, and a saved session recognizes its replay after restart", async () => {
  const original=receipt("failed","3"); const paid=()=>refusal(502,"answer_invalid",original);
  const replay=()=>refusal(409,"mixture_already_failed",{...original,replay:true});
  const h=harness([paid,replay]);const first=await h.send();const dupe=await h.send();
  assert.equal(first.usage.cost.total,.03);assert.equal(dupe.usage.cost.total,0);
  assert.equal(dupe.diagnostics[0].details.panda.charge.minor_units,"3");
  const fresh=settlementAccounting();fresh.bind({getEntries:()=>[{type:"message",message:first}]});
  assert.equal((await harness([replay],{accounting:fresh}).send()).usage.cost.total,0);
  assert.equal((await harness([replay]).send()).usage.cost.total,.03);
});

test("only safe error codes, field paths, settlement, and identifiers cross to Pi", () => {
  const result=describeError(502,{error:{code:"answer_invalid",param:"tools[1].function.parameters."+privateText,message:privateText},
    panda:{...receipt("failed","3"),agents:[privateText]},metadata:privateText},
    new Headers({"x-panda-request-id":privateText,"unrelated":privateText}));
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
