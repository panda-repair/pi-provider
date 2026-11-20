import assert from "node:assert/strict";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const [dist, mode, id] = process.argv.slice(2);
const pi = await import(pathToFileURL(join(dist, "index.js")));
const signal = AbortSignal.timeout(30_000);
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

if (mode === "summary" || mode === "branch") {
  const summarize = () => mode === "summary"
    ? pi.generateSummaryWithUsage([user], model, undefined, undefined, undefined, signal, undefined,
        undefined, undefined, stream, undefined, retry, undefined, options.sessionId)
    : pi.generateBranchSummary([{ type: "message", id: "test", message: user }], { model, signal, streamFn: stream, retry });
  try { await summarize(); } catch { /* A truncated or disconnected first response loses the answer. */ }
  const next = await summarize();
  assert.match(next.text ?? next.summary, /Read a scratch fixture/);
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
} else if (["usage", "timeout", "malformed", "stream-error"].includes(mode)) {
  const message = await stream(model, { messages: [user] }, {
    ...options, timeoutMs: mode === "timeout" ? 15_000 : undefined,
  }).result();
  if (mode === "usage") {
    const { input, output, cacheRead, cacheWrite, totalTokens, cost } = message.usage;
    assert.equal(input + output + cacheRead + cacheWrite, 310045);
    assert.equal(totalTokens, 75015);
    assert.equal(cost.total, 0.13);
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
