import { createHash, randomUUID } from "node:crypto";
import { boundedJSON, describeError, errorResponse, observeStreamErrors } from "./errors.js";
import { responseUsage } from "./usage.js";

const hash = text => createHash("sha256").update(text).digest("hex");

export function createRequestKeys() {
  const foreground = new Map();
  // Pi reuses the synthetic user message across native summary retries and creates
  // another message for a new summary, even when its text, routing ID and signal repeat.
  const standalone = new WeakMap();
  return {
    start(manager) { foreground.set(manager.getSessionId(), { manager, attempts: new Map() }); },
    settle(manager) { foreground.delete(manager.getSessionId()); },
    reserve(options, context, model, body) {
      const run = foreground.get(options.sessionId);
      let groups;
      let source;
      const message = context.messages?.at(-1);
      const entry = run?.manager.buildSessionProjection().entries.findLast(row => row.messages.length);
      const projected = entry?.messages.at(-1);
      // Foreground messages can be cloned by extensions. Native summary retries reuse
      // their own synthetic message, independent of the foreground transcript.
      const summary = run && options.cacheRetention === "none" && (!projected ||
        message?.role !== projected.role || message?.timestamp !== projected.timestamp ||
        JSON.stringify(message?.content) !== JSON.stringify(projected.content));
      if ((!run || summary) && options.sessionId && message && typeof message === "object") {
        groups = standalone.get(message) ?? new Map();
        standalone.set(message, groups);
        source = options.sessionId;
      } else if (run) {
        groups = run.attempts;
        source = entry?.sourceEntry.id;
      }
      if (!groups || !source || typeof body !== "string") {
        throw new Error("Panda could not identify this operation safely. No request was sent.");
      }
      const identity = JSON.stringify([source, model.baseUrl, model.id, hash(options.apiKey)]);
      const group = groups.get(identity) ?? new Set();
      const bodyHash = hash(body);
      const failed = [...group].filter(ticket => ticket.failed);
      const matching = failed.filter(ticket => ticket.bodyHash === bodyHash);
      const previous = matching.length ? matching : failed;
      if (previous.length > 1) throw new Error("Panda cannot identify which failed request to retry safely.");
      const prior = previous[0];
      if (prior) group.delete(prior);
      const ticket = {
        key: prior?.key ?? randomUUID(), terminal: prior?.terminal, fresh: false, failed: false, bodyHash,
        finish(reason) {
          if (reason === "error" && !ticket.fresh) ticket.failed = true;
          else group.delete(ticket);
          if (!group.size) groups.delete(identity);
        },
      };
      group.add(ticket);
      groups.set(identity, group);
      return ticket;
    },
  };
}

function safeMessage(model, original, text) {
  return { role: "assistant", content: [], api: model.api, model: model.id, provider: "panda",
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    timestamp: Date.now(), stopReason: original?.stopReason === "aborted" ? "aborted" : "error", errorMessage: text };
}

export function pandaStream(stream, keys, assertAvailable, observe) {
  return (model, context, options = {}) => {
    assertAvailable(model, options.apiKey);
    let attempt;
    let failure;
    const usage = responseUsage(model);
    const send = options.fetch ?? globalThis.fetch;
    function record(error) {
      failure = error.message;
      attempt.fresh = error.action === "fresh";
      if (error.action === "terminal") attempt.terminal = error;
      return error;
    }
    const events = stream(model, context, {
      ...options,
      ...(options.timeoutMs === undefined && (model.id.startsWith("panel:") || ["auto", "auto:quality"].includes(model.id))
        && { timeoutMs: 600_000 }),
      async onProviderStreamEvent(chunk, target) {
        usage.chunk(chunk);
        await options.onProviderStreamEvent?.(chunk, target);
      },
      async fetch(input, init) {
        const target = typeof input === "string" ? input : input instanceof URL ? input.href : input?.url;
        const headers = new Headers(init?.headers ?? input?.headers);
        if (target !== model.baseUrl.replace(/\/+$/, "") + "/chat/completions" ||
            headers.get("authorization") !== "Bearer " + options.apiKey) {
          failure = "Panda refused a request with a mismatched endpoint or credential.";
          throw new Error(failure);
        }
        // A peer extension can replace the payload after Pi selects the paid target.
        let wireModel;
        try { wireModel = JSON.parse(init?.body)?.model; } catch { /* A malformed body has no verifiable target. */ }
        if (wireModel !== model.id) {
          failure = "Panda refused a request whose model differs from the selected Auto or Panel.";
          throw new Error(failure);
        }
        if (!attempt) {
          try { attempt = keys.reserve(options, context, model, init?.body); }
          catch (error) { failure = error.message; throw error; }
        }
        if (attempt.terminal) { failure = attempt.terminal.message; return errorResponse(attempt.terminal); }
        if (attempt.fresh) attempt.key = randomUUID();
        attempt.fresh = false;
        failure = undefined;
        usage.request(init?.body);
        headers.set("Idempotency-Key", attempt.key);
        let response;
        try {
          response = await send(input, { ...init, headers, redirect: "manual" });
        } catch {
          failure = "Panda connection error before a complete response.";
          throw new Error(failure);
        }
        if (response.redirected || (response.status >= 300 && response.status < 400) ||
            (response.url && response.url !== target)) {
          void response.body?.cancel().catch(() => {});
          const message = "Panda refused an unexpected response endpoint or redirect.";
          return errorResponse(record({ action: "terminal", status: 400, message,
            body: JSON.stringify({ error: { message } }), headers: { "content-type": "application/json", "x-should-retry": "false" } }));
        }
        if (response.ok) return observeStreamErrors(response, data => {
          // HTTP 200 already began. A stream error without a validated settlement may have run.
          record(describeError(500, data, response.headers));
        });
        const data = await boundedJSON(response);
        void response.body?.cancel().catch(() => {});
        return errorResponse(record(describeError(response.status, data, response.headers)));
      },
    });
    function finish(message) {
      attempt?.finish(message.stopReason);
      if (message.stopReason === "error" || message.stopReason === "aborted") {
        return safeMessage(model, message, failure ?? (message.stopReason === "aborted"
          ? "Panda request aborted." : "Panda connection error before a complete response."));
      }
      return usage.finish(message);
    }
    // The native event stream is consumed by Pi once. Transform its final event before
    // either the transcript consumer or .result() receives it.
    if (observe) return observe(events, finish);
    const result = events.result().then(finish, error => { attempt?.finish("error"); throw error; });
    return { result: () => result };
  };
}
