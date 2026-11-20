import { createHash, randomUUID } from "node:crypto";
import { catalog } from "./catalog.js";

const accepted = new Set([
  "model", "messages", "temperature", "top_p", "stop", "stream", "seed", "user",
  "tools", "tool_choice", "parallel_tool_calls",
]);

const knownDialects = new Set([
  "http://json-schema.org/draft-04/schema#",
  "http://json-schema.org/draft-06/schema#",
  "http://json-schema.org/draft-07/schema#",
  "https://json-schema.org/draft/2019-09/schema",
  "https://json-schema.org/draft/2020-12/schema",
]);
const schemaMaps = new Set(["properties", "patternProperties", "dependentSchemas", "dependencies"]);
const schemaValues = new Set([
  "items", "prefixItems", "allOf", "anyOf", "oneOf", "not", "if", "then", "else",
  "contains", "propertyNames", "additionalProperties", "additionalItems",
  "unevaluatedProperties", "unevaluatedItems", "contentSchema",
]);

function cleanSchema(schema, tool) {
  if (!schema || typeof schema !== "object") return schema;
  if (Array.isArray(schema)) return schema.map(child => cleanSchema(child, tool));
  if (Object.hasOwn(schema, "$ref")) {
    throw new Error("Panda tool " + tool + " uses a JSON Schema $ref. Inline the referenced schema before sending it.");
  }
  if (Object.hasOwn(schema, "$schema") && !knownDialects.has(schema.$schema)) {
    throw new Error("Panda tool " + tool + " uses an unsupported JSON Schema dialect.");
  }
  const result = { ...schema };
  // A reference in the active schema is an error. Unreferenced definitions and identifiers
  // have no effect on validation. Property names and constant/default/example data stay intact.
  for (const annotation of ["$schema", "$id", "$defs", "definitions"]) delete result[annotation];
  for (const [keyword, value] of Object.entries(result)) {
    if (schemaMaps.has(keyword) && value && typeof value === "object") {
      result[keyword] = Object.fromEntries(Object.entries(value).map(([name, child]) => [name, cleanSchema(child, tool)]));
    } else if (schemaValues.has(keyword)) {
      result[keyword] = cleanSchema(value, tool);
    }
  }
  return result;
}

export function pandaPayload(payload, model) {
  const definition = catalog.find(entry => entry.id === model.id);
  if (!definition || model.provider !== "panda" || !payload || typeof payload !== "object") return payload;
  const body = Object.fromEntries(Object.entries(payload).filter(([key]) => accepted.has(key)));
  body.model = model.id;
  if (Array.isArray(body.tools)) {
    body.tools = body.tools.map(tool => {
      if (!tool?.function?.parameters) return tool;
      const fn = tool.function;
      return { ...tool, function: { ...fn, parameters: cleanSchema(fn.parameters, fn.name) } };
    });
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

// Only a failed attempt in an unsettled Pi user run is eligible when Pi starts another stream.
// Panda rejects changed bytes under the same key. Issuing a fresh key in that case could bill twice.
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
      const ticket = { key: previous?.key ?? randomUUID(), bodyHash, failed: false };
      group.add(ticket);
      run.attempts.set(identity, group);
      return {
        key: ticket.key,
        finish(reason) {
          if (reason === "error") ticket.failed = true;
          else group.delete(ticket);
          if (!group.size) run.attempts.delete(identity);
        },
      };
    },
  };
}

export function pandaStream(stream, keys, assertAvailable) {
  return (model, context, options = {}) => {
    assertAvailable(model, options.apiKey);
    let attempt;
    const send = options.fetch ?? globalThis.fetch;
    const events = stream(model, context, {
      ...options,
      async fetch(input, init) {
        // Pi's OpenAI transport supplies serialized JSON here. One stream can make
        // several HTTP attempts. AgentSession can also reopen the same failed stream.
        attempt ??= keys.reserve(options.sessionId, model, options.apiKey, init?.body);
        const headers = new Headers(init?.headers ?? input?.headers);
        headers.set("Idempotency-Key", attempt.key);
        return send(input, { ...init, headers });
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
