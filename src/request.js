import { createHash, randomUUID } from "node:crypto";
import { catalog } from "./catalog.js";

const accepted = new Set([
  "model", "messages", "temperature", "top_p", "stop", "stream", "seed", "user",
  "tools", "tool_choice", "parallel_tool_calls",
]);

const definitionTables = ["$defs", "definitions"];
const schemaMaps = new Set(["properties", "patternProperties", "dependentSchemas", "dependentRequired", "dependencies"]);
const literalKeywords = new Set(["const", "enum", "default", "examples"]);
const refAnnotations = new Set(["description", "title", "default", "examples", "deprecated", "readOnly", "writeOnly", "$comment"]);
const scopeKeywords = new Set(["$anchor", "$dynamicRef", "$dynamicAnchor", "$recursiveRef", "$recursiveAnchor"]);
const copyBudget = 65_536;

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function cleanSchema(schema, tool, budget) {
  if (!isObject(schema)) return schema;
  const root = { ...schema };
  const error = message => new Error("Panda tool " + tool + ": " + message);
  const definitions = new Map();
  let normalizing = false;
  let draft07 = false;
  let scopeKeyword;
  if (Object.hasOwn(root, "$schema")) {
    const dialect = typeof root.$schema === "string" && root.$schema.replace(/^https?:\/\//, "").replace(/#$/, "");
    if (typeof root.$schema !== "string" || !/^https?:\/\//.test(root.$schema) ||
        !["json-schema.org/draft/2020-12/schema", "json-schema.org/draft/2019-09/schema", "json-schema.org/draft-07/schema"].includes(dialect)) {
      throw error("unsupported root JSON Schema dialect.");
    }
    draft07 = dialect === "json-schema.org/draft-07/schema";
    delete root.$schema;
    normalizing = true;
  }
  for (const table of definitionTables) {
    if (!Object.hasOwn(root, table)) continue;
    if (!isObject(root[table])) throw error(table + " must be an object at the schema root.");
    definitions.set(table, root[table]);
    delete root[table];
    normalizing = true;
  }

  function expand(reference, stack) {
    const { $ref, ...siblings } = reference;
    if (Object.keys(siblings).some(key => !refAnnotations.has(key))) throw error("only annotations can accompany a $ref.");
    if (typeof $ref !== "string" || !$ref.startsWith("#")) throw error("only local references to root definitions are supported.");
    let fragment;
    try {
      fragment = decodeURIComponent($ref.slice(1).replace(/%(?![\da-f]{2})/gi, "%25"));
    } catch {
      throw error("invalid UTF-8 in a local $ref.");
    }
    const pointer = fragment.split("/");
    if (pointer.length !== 3 || pointer[0] !== "" || !definitionTables.includes(pointer[1]) || /~(?![01])/.test(pointer[2])) {
      throw error("a $ref must name one root definition using a JSON Pointer token.");
    }
    const name = pointer[2].replaceAll("~1", "/").replaceAll("~0", "~");
    const table = definitions.get(pointer[1]);
    if (!table || !Object.hasOwn(table, name)) throw error("missing local definition for " + $ref + ".");
    const target = pointer[1] + "/" + name;
    if (stack.includes(target) || stack.length >= 32) throw error("cyclic local reference or more than 32 reference levels.");
    const value = table[name];
    budget.used += Buffer.byteLength(JSON.stringify(value));
    if (budget.used > copyBudget) throw error("local reference copies exceed the request's 65,536-byte allowance.");
    const copied = visit(value, [...stack, target]);
    if (draft07 || !Object.keys(siblings).length) return copied;
    if (!isObject(copied)) throw error("reference annotations need an object schema.");
    return { ...copied, ...siblings };
  }

  function visit(value, stack) {
    if (Array.isArray(value)) return value.map(child => visit(child, stack));
    if (!isObject(value)) return value;
    if (Object.hasOwn(value, "$ref")) {
      normalizing = true;
      return expand(value, stack);
    }
    return Object.fromEntries(Object.entries(value).map(([key, child]) => {
      if (key === "$schema" || key === "$id" || definitionTables.includes(key)) throw error("unsupported schema location for " + key + ".");
      if (scopeKeywords.has(key)) scopeKeyword = key;
      if (literalKeywords.has(key)) return [key, child];
      if (schemaMaps.has(key) && isObject(child)) {
        return [key, Object.fromEntries(Object.entries(child).map(([name, nested]) => [name, visit(nested, stack)]))];
      }
      return [key, visit(child, stack)];
    }));
  }

  let result;
  try {
    result = visit(root, []);
  } catch (cause) {
    if (cause instanceof RangeError) throw error("schema nesting exceeds the local parser limit.");
    throw cause;
  }
  if (normalizing && scopeKeyword) throw error("unsupported reference scoping keyword " + scopeKeyword + ".");
  return normalizing ? result : schema;
}

export function pandaPayload(payload, model) {
  const definition = catalog.find(entry => entry.id === model.id);
  if (!definition || model.provider !== "panda" || !payload || typeof payload !== "object") return payload;
  const body = Object.fromEntries(Object.entries(payload).filter(([key]) => accepted.has(key)));
  body.model = model.id;
  if (Array.isArray(body.tools)) {
    const budget = { used: 0 };
    body.tools = body.tools.map(tool => {
      if (!tool?.function?.parameters) return tool;
      const fn = tool.function;
      return { ...tool, function: { ...fn, parameters: cleanSchema(fn.parameters, fn.name, budget) } };
    });
    if (budget.used && Buffer.byteLength(JSON.stringify(body.tools)) > copyBudget) {
      throw new Error("Panda tools exceed 65,536 bytes after local reference expansion.");
    }
    if (!body.tools.length) delete body.tools;
  }

  const limits = [payload.max_completion_tokens, payload.max_tokens].filter(Number.isFinite);
  if (limits.length) {
    const field = Number.isFinite(payload.max_completion_tokens) ? "max_completion_tokens" : "max_tokens";
    body[field] = Math.max(1, Math.floor(Math.min(definition.maxTokens, ...limits)));
  }
  if (payload.stream === true && typeof payload.stream_options?.include_usage === "boolean") {
    body.stream_options = { include_usage: payload.stream_options.include_usage };
  }
  if (payload.n === 1 || payload.n === null) body.n = payload.n;
  if (payload.logprobs === false || payload.logprobs === null) body.logprobs = payload.logprobs;
  if (payload.top_logprobs === null) body.top_logprobs = null;
  if (payload.response_format?.type === "text") body.response_format = { type: "text" };
  if (model.id.startsWith("panel:") && typeof payload.panda?.synthesizer_model === "string") {
    body.panda = { synthesizer_model: payload.panda.synthesizer_model };
  }
  return body;
}

// The event identifies the payload, while ctx.model only identifies the session selection.
// A nested request from another provider can use the same model name.
const requestModels = new WeakMap();

export function beforeProviderRequest({ payload }) {
  const model = requestModels.get(payload);
  if (model) return pandaPayload(payload, model);
}

// An outer agent retry reopens the stream. Keep the last HTTP outcome alongside
// its key so both the new stream and a retry within one stream make the same decision.
export function createRequestKeys() {
  const runs = new Map();
  return {
    start(manager) { runs.set(manager.getSessionId(), { manager, attempts: new Map() }); },
    settle(manager) { runs.delete(manager.getSessionId()); },
    reserve(sessionId, model, token, body) {
      const run = runs.get(sessionId);
      const last = run?.manager.buildSessionProjection().entries.findLast(entry => entry.messages.length);
      if (!last || typeof body !== "string") return { key: randomUUID(), finish() {} };
      const tokenHash = createHash("sha256").update(token).digest("hex");
      const identity = JSON.stringify([last.sourceEntry.id, model.baseUrl, model.id, tokenHash]);
      const group = run.attempts.get(identity) ?? new Set();
      const bodyHash = createHash("sha256").update(body).digest("hex");
      const failed = [...group].filter(attempt => attempt.failed);
      const matching = failed.filter(attempt => attempt.bodyHash === bodyHash);
      const candidates = matching.length ? matching : failed;
      if (candidates.length > 1) {
        throw new Error("Panda cannot identify which failed request to retry safely.");
      }
      const previous = candidates[0];
      if (previous) group.delete(previous);
      const ticket = {
        key: previous?.key ?? randomUUID(), fresh: previous?.fresh, receipt: previous?.receipt,
        bodyHash, failed: false,
        finish(reason) {
          if (reason === "error" && !ticket.fresh) ticket.failed = true;
          else group.delete(ticket);
          if (!group.size) run.attempts.delete(identity);
        },
      };
      group.add(ticket);
      run.attempts.set(identity, group);
      return ticket;
    },
  };
}

// Inspect only the machine envelope. Canceling a tee branch can wait for the
// SDK's untouched branch; never await that cancellation here.
async function boundedError(response) {
  const limit = 16_384;
  if (!response.body || response.bodyUsed || response.body.locked || Number(response.headers.get("content-length")) > limit) return;
  const reader = response.clone().body.getReader();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    void reader.cancel().catch(() => {});
  }, 1000);
  const decoder = new TextDecoder();
  let text = "";
  let bytes = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (timedOut) return;
      if (done) return JSON.parse(text + decoder.decode());
      bytes += value.byteLength;
      if (bytes > limit) return;
      text += decoder.decode(value, { stream: true });
    }
  } catch {
    return;
  } finally {
    clearTimeout(timer);
    void reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

function receiptResponse(receipt) {
  return new Response(receipt.body, { status: 409, headers: receipt.headers });
}

async function classifyResponse(attempt, response) {
  const { status, headers } = response;
  // Until the native parser finishes, a 200 can still be an interrupted SSE stream.
  // A dropped connection, HTTP 500 or unfamiliar server failure can also have run.
  if (status >= 400 && status < 500 && status !== 409) attempt.fresh = true;
  if (status !== 409 && status !== 502 && status !== 503) return response;
  const data = await boundedError(response);
  const code = data?.error?.code;
  if (status === 409 && ["mixture_already_running", "mixture_already_completed", "mixture_already_partial"].includes(code)) {
    const requestId = headers.get("x-panda-request-id") ?? data.panda?.request_id;
    const id = typeof requestId === "string" && /^[a-zA-Z0-9_.:/-]{1,128}$/.test(requestId) ? requestId : undefined;
    const explanation = code === "mixture_already_running"
      ? "The earlier identical request is still running and will be charged when it completes. Its answer cannot be recovered. Resubmitting starts and charges a second run."
      : "The earlier Panda request finished and was charged. Its response was lost. Submitting again will charge again.";
    const message = explanation + (id ? " Panda request ID: " + id + "." : "");
    const safeHeaders = new Headers(headers);
    for (const name of ["content-length", "content-encoding", "transfer-encoding"]) safeHeaders.delete(name);
    safeHeaders.set("content-type", "application/json");
    safeHeaders.set("x-should-retry", "false");
    attempt.receipt = { body: JSON.stringify({ ...data, error: { ...data.error, message } }), headers: safeHeaders };
    void response.body?.cancel().catch(() => {});
    return receiptResponse(attempt.receipt);
  }
  // A plain 409 is definite. If Panda explicitly marks a replay and the bounded
  // envelope cannot identify its outcome, keep the key so an original charge survives.
  const markedReplay = headers.get("idempotency-replayed")?.toLowerCase() === "true" || data?.panda?.replay === true;
  const definiteReplay = ["mixture_already_failed", "mixture_idempotency_conflict"].includes(code);
  attempt.fresh = (status === 409 && (!markedReplay || definiteReplay)) ||
    (status === 502 && ["answer_invalid", "answer_incomplete", "no_answers"].includes(code)) ||
    (status === 503 && ["model_unavailable", "model_refused"].includes(code));
  return response;
}

export function pandaStream(stream, keys, assertAvailable) {
  return (model, context, options = {}) => {
    assertAvailable(model, options.apiKey);
    let attempt;
    const send = options.fetch ?? globalThis.fetch;
    const events = stream(model, context, {
      ...options,
      async fetch(input, init) {
        attempt ??= keys.reserve(options.sessionId, model, options.apiKey, init?.body);
        if (attempt.receipt) return receiptResponse(attempt.receipt);
        if (attempt.fresh) attempt.key = randomUUID();
        attempt.fresh = false;
        const headers = new Headers(init?.headers ?? input?.headers);
        headers.set("Idempotency-Key", attempt.key);
        const response = await send(input, { ...init, headers });
        return classifyResponse(attempt, response);
      },
      async onPayload(payload, actualModel) {
        requestModels.set(payload, model);
        try {
          const result = await options.onPayload?.(payload, actualModel);
          // Direct API calls may have no runner; later extensions can replace the hook's result.
          return pandaPayload(result ?? payload, model);
        } finally {
          requestModels.delete(payload);
        }
      },
    });
    void events.result().then(message => attempt?.finish(message.stopReason), () => attempt?.finish("error"));
    return events;
  };
}
