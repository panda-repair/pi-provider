import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { boundedJSON, describeError, retryWait, unknownOutcome } from "./errors.js";
import { pandaEventStream } from "./stream.js";
import { responseUsage } from "./usage.js";

function errorMessage(model, failure, aborted) {
  return { role: "assistant", content: [], api: model.api, model: model.id, provider: "panda",
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    timestamp: Date.now(), stopReason: aborted ? "aborted" : "error", errorMessage: failure.message,
    ...(failure.details && { diagnostics: [{ type: "panda.error", timestamp: Date.now(), details: failure.details }] }) };
}

function stopResponse(failure) {
  const { code, param, requestId, panda, replay } = failure.details ?? {};
  // The SDK may stringify any part of this envelope or attach it to its own error.
  return Response.json({ error: { message: failure.message, ...(code && { code }), ...(param && { param }) },
    ...(requestId && { request_id: requestId }), ...(panda && { panda }) }, {
    status: failure.details?.status >= 400 ? failure.details.status : 400,
    headers: { "x-should-retry": "false", ...(requestId && { "x-panda-request-id": requestId }),
      ...(replay && { "idempotency-replayed": "true" }) },
  });
}

export function pandaStream(stream, assertAvailable, { observe, accounting, canDisplay = () => true } = {}) {
  return (model, context, options = {}) => {
    assertAvailable(model, options.apiKey);
    const state = {};
    const usage = responseUsage(model);
    const foreground = options.onPayload && options.onResponse && options.onProviderStreamEvent;
    const send = options.fetch ?? globalThis.fetch;
    const panel = model.id.startsWith("panel:") || ["auto", "auto:quality"].includes(model.id);
    const timeoutMs = options.timeoutMs ?? (panel ? 600_000 : undefined);
    const deadline = timeoutMs > 0 ? Date.now() + timeoutMs : Infinity;

    function stop(failure) {
      state.failure = failure;
      return stopResponse(failure);
    }

    async function dispatch(input, init) {
      if (state.key) return stop(state.failure ?? { message: "Panda has already submitted this call. " + unknownOutcome });
      const target = typeof input === "string" ? input : input instanceof URL ? input.href : input?.url;
      const headers = new Headers(init?.headers ?? input?.headers);
      if (target !== model.baseUrl.replace(/\/+$/, "") + "/chat/completions" ||
          headers.get("authorization") !== "Bearer " + options.apiKey) {
        return stop({ message: "Panda refused a request with a mismatched endpoint or credential." });
      }
      let wireModel;
      try { wireModel = JSON.parse(init?.body)?.model; } catch { /* The selected target must be identifiable. */ }
      if (wireModel !== model.id) return stop({ message: "Panda refused a request whose model differs from the selected Auto or Panel." });
      state.key = randomUUID();
      headers.set("Idempotency-Key", state.key);
      usage.request(init.body);
      const signals = [init.signal, options.signal].filter(Boolean);
      const signal = signals.length ? AbortSignal.any(signals) : undefined;
      const request = { ...init, headers, redirect: "manual", signal };
      let remainingWait = 60_000;
      for (let attempt = 0; ; attempt++) {
        try {
          signal?.throwIfAborted();
          const response = await send(input, request);
          if (response.redirected || (response.status >= 300 && response.status < 400) || (response.url && response.url !== target)) {
            void response.body?.cancel().catch(() => {});
            return stop({ message: "Panda refused an unexpected response endpoint or redirect. " + unknownOutcome });
          }
          if (response.ok && response.body && response.headers.get("content-type")?.toLowerCase().includes("text/event-stream")) {
            return pandaEventStream(response, state, canDisplay);
          }
          const error = describeError(response.status, await boundedJSON(response), response.headers, canDisplay);
          void response.body?.cancel().catch(() => {});
          const wait = retryWait(response.headers.get("retry-after"), attempt);
          const maxWait = Math.min(remainingWait, options.maxRetryDelayMs > 0 ? options.maxRetryDelayMs : Infinity);
          if (!error.retry || attempt >= 2 || wait > maxWait || Date.now() + wait >= deadline) return stop(error);
          remainingWait -= wait;
          await delay(wait, undefined, { signal });
        } catch {
          return stop({ message: unknownOutcome });
        }
      }
    }
    function finish(original) {
      const aborted = original.stopReason === "aborted";
      if (state.failure || ((original.stopReason === "error" || aborted) && !state.settled)) {
        const failure = state.failure ?? { message: state.key ? unknownOutcome : "Panda could not prepare the selected request." };
        const message = errorMessage(model, failure, aborted);
        return accounting?.apply(message, failure.details?.panda, state.key, failure.details?.requestId) ?? message;
      }
      let message = original;
      if (state.finish === "content_filter") {
        message = { ...original, stopReason: "stop", rawStopReason: "content_filter",
          content: [{ type: "text", text: "Panda declined to provide an answer." }] };
        delete message.errorMessage;
      } else if (state.settled && (aborted || original.stopReason === "error")) {
        const reason = { length: "length", tool_calls: "toolUse", function_call: "toolUse", stop: "stop" }[state.finish];
        if (reason) {
          message = { ...original, stopReason: reason };
          delete message.errorMessage;
        }
      }
      // Pi's agent invokes these three callbacks on foreground turns. Its native
      // summaries omit them and require length to reject an incomplete checkpoint.
      if (state.foreground && state.settled && state.finish === "length") {
        message = { ...message, stopReason: "stop", rawStopReason: "length", content: [
          ...message.content.filter(block => block.type !== "toolCall"),
          { type: "text", text: "\n[Panda reached the output limit. This answer is incomplete.]" },
        ] };
      }
      const result = usage.finish(message);
      return accounting?.apply(result, state.settled, state.key) ?? result;
    }

    const native = () => stream(model, context, {
      ...options, timeoutMs, maxRetries: 0, fetch: dispatch,
      async onPayload(payload, target) {
        if (foreground) state.foreground = true;
        return options.onPayload?.(payload, target);
      },
      async onProviderStreamEvent(chunk, target) {
        usage.chunk(chunk);
        await options.onProviderStreamEvent?.(chunk, target);
      },
    });
    if (observe) return observe(native, finish);
    const result = native().result().then(finish, () => finish({ stopReason: "error" }));
    return { result: () => result };
  };
}
