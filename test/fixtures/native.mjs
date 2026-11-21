import assert from "node:assert/strict";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const [dist, mode, id] = process.argv.slice(2);
const pi = await import(pathToFileURL(join(dist, "index.js")));
const signal = AbortSignal.timeout(30_000);
if (mode === "sdk-picker") {
  const { checkSdkPicker } = await import("./sdk-picker.mjs");
  await checkSdkPicker(pi, signal, dist);
  process.exit(0);
}
if (mode.startsWith("saved-")) {
  const { checkSavedUsage } = await import("./saved-usage.mjs");
  await checkSavedUsage(pi, signal, mode);
  process.exit(0);
}
const services = await pi.createAgentSessionServices({
  cwd: process.cwd(), agentDir: process.env.PI_CODING_AGENT_DIR, modelRuntimeSignal: signal,
});
const runtime = services.modelRuntime;
const refresh = await runtime.refresh({ providers: ["panda"], signal });
assert.equal(refresh.errors.size, 0);
const model = (await runtime.getAvailable("panda", { signal })).find(row => row.id === id);
assert.ok(model);
const user = { role: "user", content: [{ type: "text", text: "A repeatable fixture conversation." }], timestamp: 1 };
const options = { signal, sessionId: "fixture-routing-id", maxRetries: 0 };
const stream = (target, context, config) => runtime.streamSimple(target, context, { ...config, maxRetries: 0 });
const retry = { enabled: true, maxRetries: 1, baseDelayMs: 1, maxDelayMs: 5 };

if (["summary", "branch", "summary-length", "branch-length"].includes(mode)) {
  const summarize = () => mode.startsWith("summary")
    ? pi.generateSummaryWithUsage([user], model, undefined, undefined, undefined, signal, undefined,
        undefined, undefined, stream, undefined, retry, undefined, options.sessionId)
    : pi.generateBranchSummary([{ type: "message", id: "test", message: user }], { model, signal, streamFn: stream, retry });
  const first = await summarize().catch(error => ({ error: error.message }));
  assert.match(first.error, mode.endsWith("length") ? /incomplete/ : /may have run and been charged/);
  if (!mode.endsWith("length")) {
    const next = await summarize();
    assert.match(next.text ?? next.summary, /Read a scratch fixture/);
  }
} else if (["refused-manual","refused-branch","panel-context","routed-context","oversized-context","paid-compaction","paid-branch"].includes(mode)) {
  const paid=mode.startsWith("paid-");
  services.settingsManager.applyOverrides({compaction:{enabled:true,reserveTokens:16384,keepRecentTokens:paid?1:16}});
  const saved=join(process.cwd(),mode);
  const manager=paid?pi.SessionManager.create(process.cwd(),saved):pi.SessionManager.inMemory(process.cwd());
  const users=[];
  for(let i=0;i<6;i++) {
    users.push(manager.appendMessage({...user,content:"Earlier request ".repeat(32)+i,timestamp:i}));
    if (paid) manager.appendMessage({role:"assistant",provider:"panda",api:model.api,model:model.id,timestamp:i,
      stopReason:"stop",content:[{type:"text",text:"Earlier answer ".repeat(24)}],
      usage:{input:10,output:10,cacheRead:0,cacheWrite:0,totalTokens:20,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}}});
  }
  const {session}=await pi.createAgentSessionFromServices({services,model,sessionManager:manager,noTools:"all"});
  try {
    await session.bindExtensions({mode:"print"});
    const checkpoints=()=>manager.getEntries().filter(entry=>["compaction","branch_summary"].includes(entry.type));
    if (paid) {
      if (mode==="paid-compaction") await session.compact();
      else await session.navigateTree(users[0],{summarize:true});
      const entries=pi.SessionManager.open(manager.getSessionFile(),saved,process.cwd()).getEntries();
      const checkpoint=entries.find(e=>e.type===(mode==="paid-compaction"?"compaction":"branch_summary"));
      const record=entries.find(e=>e.type==="custom"&&e.customType==="panda.checkpoint_receipts"&&e.data.checkpointId===checkpoint.id);
      const runs=checkpoint.usage.cost.pandaRunIds??record?.data.runIds;
      assert.equal(new Set(runs).size,mode==="paid-compaction"?2:1);
      assert.equal(checkpoint.usage.cost.total,runs.length*.03);
    } else if (mode.startsWith("refused-")) {
      const leaf=manager.getLeafId();
      await assert.rejects(mode==="refused-manual" ? session.compact() : session.navigateTree(users[0],{summarize:true}),/Panda declined/);
      assert.equal(manager.getLeafId(),leaf);
      assert.equal(manager.buildSessionProjection().messages.filter(m=>m.role==="user").length,6);
      assert.equal(checkpoints().length,0);
    } else {
      await session.prompt("Answer the next request."); await session.waitForIdle();
      const message=manager.getEntries().find(entry=>entry.type==="message" && entry.message.role==="assistant").message;
      const large=mode==="oversized-context";
      assert.equal(message.usage.input+message.usage.cacheRead,large?250000:75000);
      assert.equal(message.usage.totalTokens,large?250015:75015);
      assert.equal(message.diagnostics.find(d=>d.type==="panda.aggregate_usage").details.totalTokens,310045);
      assert.equal(message.usage.cost.total,.13); assert.equal(checkpoints().length,large?1:0);
    }
  } finally {session.dispose();}
} else if (mode === "standalone") {
  const { session } = await pi.createAgentSessionFromServices({
    services, model, sessionManager: pi.SessionManager.inMemory(process.cwd()), tools: [],
  });
  try {
    await session.bindExtensions({mode:"print"});
    const ctx = session.extensionRunner.createContext();
    const results = await Promise.all([1, 2].map(() => ctx.modelRegistry.complete(model, { messages: [user] })));
    assert.ok(results.every(message => message.stopReason === "stop"));
  } finally { session.dispose(); }
} else if (["virtual", "large-failed-turn", "settled-length"].includes(mode)) {
  let selection = model;
  const routes = [];
  if (mode === "virtual") {
    runtime.registerVirtualModel({ provider:"fixture", id:"switch-panel", name:"Fixture router", thinkingLevels:["off"],
      route(request) {
        routes.push(request.reason);
        return { model:runtime.getModel("panda",request.reason === "retry" ? "panel:panda-quality" : "panel:panda"), thinkingLevel:"off" };
      } });
    selection = runtime.getModel("fixture","switch-panel");
  }
  const manager = pi.SessionManager.inMemory(process.cwd());
  const { session } = await pi.createAgentSessionFromServices({ services, model:selection, sessionManager:manager, tools:[] });
  try {
    await session.bindExtensions({mode:"print"});
    await session.prompt(mode === "large-failed-turn" ? "A".repeat(900000) : "Verify the fixture response.");
    const last=session.state.messages.at(-1);
    if (mode === "settled-length") {
      assert.equal(last.stopReason,"stop"); assert.equal(last.rawStopReason,"length");
      assert.match(JSON.stringify(last.content),/paid partial answer/); assert.match(JSON.stringify(last.content),/incomplete/);
      assert.equal(last.usage.cost.total,.03);
      assert.ok(manager.buildSessionProjection().entries.some(entry => entry.messages.some(m=> m.rawStopReason==="length")));
    } else {
      assert.equal(last.stopReason,"error");
      if (mode === "virtual") { assert.deepEqual(routes,["user"]); assert.equal(session.getSessionStats().cost,.03); }
    }
  } finally { session.dispose(); }
} else if (mode === "rewritten-target") {
  const result = await stream(model, { messages: [user] }, {
    ...options, onPayload: payload => ({ ...payload, model: process.env.PANDA_FIXTURE_REPLACEMENT }),
  }).result();
  assert.equal(result.stopReason, "error");
  assert.match(result.errorMessage, /differs from the selected/);
} else if (mode === "retired") {
  const { session } = await pi.createAgentSessionFromServices({
    services, model, sessionManager: pi.SessionManager.inMemory(process.cwd()), tools: ["read"],
  });
  try {
    await session.prompt("Read capture-fixture.txt and tell me its first line.");
    session.setActiveToolsByName([]);
    await session.prompt("Continue the same conversation.");
  } finally { session.dispose(); }
} else if (mode.startsWith("aggregate-")) {
  const result=await stream(model,{messages:[user]},options).result();
  assert.equal(result.stopReason,"stop");assert.equal(result.usage.totalTokens,1210);assert.equal(result.usage.cost.total,.03);
  const aggregate=result.diagnostics?.find(item=>item.type==="panda.aggregate_usage");
  if (mode==="aggregate-present") assert.equal(aggregate.details.totalTokens,3024);
  else if (mode==="aggregate-zero") assert.equal(aggregate.details.totalTokens,0);
  else assert.equal(aggregate,undefined);
} else if (["usage", "timeout", "malformed", "stream-error", "settled-cut", "content-filter",
    "support-cut", "settled-abort", "settled-callback", "large-receipt"].includes(mode)) {
  const controller=new AbortController(); let responseHeaders;
  const source = stream(model, { messages: [user] }, {
    ...options, signal:AbortSignal.any([signal,controller.signal]), timeoutMs: mode === "timeout" ? 15_000 : undefined,
    onResponse(response) {responseHeaders=response.headers;},
    onProviderStreamEvent(chunk) {
      if (chunk.choices?.[0]?.finish_reason) {
        if (mode==="settled-abort") controller.abort();
        if (mode==="settled-callback") throw new Error("private-marker-callback");
      }
    },
  });
  const retained = [];
  for await (const event of source) retained.push(event);
  const message = await source.result();
  assert.doesNotMatch(JSON.stringify(retained), /private-marker/);
  if (mode === "usage") {
    const { input, output, cacheRead, cacheWrite, totalTokens, cost } = message.usage;
    assert.equal(input + output + cacheRead + cacheWrite, 75015);
    assert.equal(cacheRead,1200);
    assert.equal(message.diagnostics.find(d=>d.type==="panda.aggregate_usage").details.totalTokens,310045);
    assert.equal(totalTokens, 75015);
    assert.equal(cost.total, 0.13);
  } else if (mode === "settled-cut") {
    assert.equal(message.stopReason,"stop"); assert.match(JSON.stringify(message.content),/paid partial answer/);
    assert.equal(message.usage.cost.total,.03);
  } else if (mode === "content-filter") {
    assert.equal(message.stopReason,"error"); assert.equal(message.rawStopReason,"content_filter");
    assert.match(message.errorMessage,/declined/); assert.equal(message.usage.cost.total,0);
  } else if (mode==="support-cut") {
    assert.equal(responseHeaders["x-panda-request-id"],"fixture.502.trace");
    assert.deepEqual(Object.keys(responseHeaders).sort(),["content-type","x-panda-request-id"]);
    assert.equal(message.stopReason,"error");assert.equal(message.diagnostics[0].details.requestId,"fixture.502.trace");
  } else if (mode==="settled-callback" || mode==="settled-abort") {
    assert.equal(message.stopReason,mode==="settled-abort"?"aborted":"error");assert.equal(message.usage.cost.total,.03);
  } else if (mode==="large-receipt") {
    assert.equal(message.stopReason,"error");assert.equal(message.usage.cost.total,.03);
    assert.equal(message.diagnostics[0].details.code,"answer_invalid");
  } else if (mode === "timeout") {
    assert.equal(message.stopReason, "stop");
  } else {
    assert.equal(message.stopReason, "error");
    assert.doesNotMatch(JSON.stringify(message), /private-marker/);
    if (mode === "stream-error") assert.match(message.errorMessage, /answer_invalid/);
  }
} else {
  const dialect = "https://json-schema.org/draft/2020-12/schema";
  const functionTool = (name, parameters, description = "") => ({
    type: "function", function: { name, description, parameters },
  });
  const schemas = {
    "malformed-pointer": { $defs: { "%zz": { type: "string" } }, $ref: "#/$defs/%zz" },
    "null-target": { $defs: { value: null }, $ref: "#/$defs/value" },
    "boolean-root": { $defs: { value: true }, $ref: "#/$defs/value" },
    "prefix-and-items": { $schema: dialect, prefixItems: [{ type: "string" }], items: false },
    "patterns-and-additional": { $schema: dialect, patternProperties: { "^a": {} }, additionalProperties: false },
  };
  const cases = {
    count: { n: 2 },
    format: { response_format: { type: "json_object" } },
    logprobs: { logprobs: true },
    zero: { max_tokens: 0 },
    unequal: { max_tokens: 12, max_completion_tokens: 15 },
    neutral: { tools: [], tool_choice: "auto", store: false, max_tokens: 60000 },
    history: { tools: [], tool_choice: "auto", messages: [
      { role: "user", content: "Earlier turn." },
      { role: "assistant", content: null, reasoning_content: "Earlier thinking.",
        tool_calls: [{ id: "c1", type: "function", function: { name: "retired", arguments: "{}" } }] },
      { role: "tool", tool_call_id: "c1", content: "Result." }, { role: "user", content: "Continue." },
    ] },
    large: { tools: Array.from({ length: 10 }, (_, index) => functionTool("tool" + index, {
      $schema: dialect, type: "object", $defs: { v: { type: "string" } }, properties: { v: { $ref: "#/$defs/v" } },
    }, "x".repeat(7200))) },
  };
  const requested = schemas[mode] ? { tools: [functionTool("fixture", schemas[mode])] } : cases[mode];
  assert.ok(requested);
  const message = await stream(model, { messages: [user] }, {
    ...options,
    onPayload(payload) {
      const { max_completion_tokens, max_tokens, ...rest } = payload;
      return { ...rest, ...requested };
    },
  }).result();
  if (schemas[mode] || ["count", "format", "logprobs", "zero", "unequal"].includes(mode)) {
    assert.equal(message.stopReason, "error");
    assert.match(message.errorMessage, /unsupported_parameter|conflicting_parameters|invalid_request/);
    assert.match(message.errorMessage, /Parameter:/);
  } else {
    assert.equal(message.stopReason, "stop");
  }
}
console.log(JSON.stringify({ mode, passed: true }));
