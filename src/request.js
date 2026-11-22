import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { boundedJSON, describeError, maxAnswerBytes, retryWait, unknownOutcome } from "./errors.js";
import { pandaEventStream } from "./stream.js";
import { responseUsage } from "./usage.js";

// Pi uses the largest Node timer for an SDK timeout of zero. Our transport
// handles the real idle limit while the SDK waits for the entire custom fetch.
const sdkTimeout = 2_147_483_647;

function idleWatch(timeoutMs, callerSignal) {
  const controller = new AbortController();
  const signal = callerSignal ? AbortSignal.any([callerSignal, controller.signal]) : controller.signal;
  let timer;
  function stop() {
    clearTimeout(timer);
    signal.removeEventListener("abort", stop);
  }
  function reset() {
    clearTimeout(timer);
    if (timeoutMs > 0 && !signal.aborted) {
      timer = setTimeout(() => controller.abort(), Math.min(timeoutMs, sdkTimeout));
    }
  }
  signal.addEventListener("abort", stop, { once: true });
  return { signal, reset, stop };
}

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
    const timeoutMs = options.timeoutMs ?? 600_000;
    const retries = options.maxRetries === undefined ? 2 : Math.min(2, Math.max(0, Math.floor(options.maxRetries) || 0));

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
      // Keep the SDK's wire hint accurate and preserve an explicitly supplied header.
      if (headers.get("x-stainless-timeout") === String(Math.trunc(sdkTimeout / 1000)) &&
          !new Headers(model.headers).has("x-stainless-timeout") && !new Headers(options.headers).has("x-stainless-timeout")) {
        if (timeoutMs > 0) headers.set("x-stainless-timeout", String(Math.trunc(timeoutMs / 1000)));
        else headers.delete("x-stainless-timeout");
      }
      usage.request(init.body);
      const signals = [init.signal, options.signal].filter(Boolean);
      const signal = signals.length ? AbortSignal.any(signals) : undefined;
      const request = { ...init, headers, redirect: "manual" };
      let remainingWait = 60_000, prehold;
      for (let attempt = 0; ; attempt++) {
        const idle = idleWatch(timeoutMs, signal);
        let streaming = false;
        try {
          signal?.throwIfAborted();
          // Once another POST starts, its outcome is independent of the previous refusal.
          prehold = undefined;
          state.sent = true;
          idle.reset();
          const response = await send(input, { ...request, signal: idle.signal });
          idle.signal.throwIfAborted();
          idle.reset();
          if (response.redirected || (response.status >= 300 && response.status < 400) || (response.url && response.url !== target)) {
            void response.body?.cancel().catch(() => {});
            return stop({ message: "Panda refused an unexpected response endpoint or redirect. " + unknownOutcome });
          }
          if (response.ok && response.body && response.headers.get("content-type")?.toLowerCase().includes("text/event-stream")) {
            const result = pandaEventStream(response, state, canDisplay, idle, usage);
            streaming = true;
            return result;
          }
          const error = describeError(response.status, await boundedJSON(response, maxAnswerBytes, 0, idle.signal, idle.reset),
            response.headers, canDisplay);
          idle.stop();
          void response.body?.cancel().catch(() => {});
          const wait = retryWait(response.headers.get("retry-after"), attempt);
          const maxWait = Math.min(remainingWait, options.maxRetryDelayMs > 0 ? options.maxRetryDelayMs : Infinity);
          if (!error.retry || attempt >= retries || wait > maxWait || (timeoutMs > 0 && wait >= timeoutMs)) return stop(error);
          prehold = error;
          remainingWait -= wait;
          await delay(wait, undefined, { signal });
        } catch {
          return stop(prehold ?? { message: state.sent ? unknownOutcome : "Panda did not send this request. No charge was incurred." });
        } finally {
          if (!streaming) idle.stop();
        }
      }
    }
    function finish(original) {
      const aborted = options.signal?.aborted || original.stopReason === "aborted";
      if (state.failure || state.callbackFailed || aborted || original.stopReason === "error" || state.finish === "content_filter") {
        const settled = state.failure?.details?.panda ?? state.settled;
        let failure = state.failure;
        if (!failure) {
          let message;
          if (aborted) message = settled ? "Panda returned a settlement before this call was cancelled." :
            state.sent ? unknownOutcome : "Panda did not send this request. No charge was incurred.";
          else if (state.callbackFailed) message = "The response callback stopped processing the Panda result." +
            (settled ? " Panda returned a settlement." : " " + unknownOutcome);
          else if (state.finish === "content_filter") message = "Panda declined to provide an answer.";
          else message = state.key ? unknownOutcome : "Panda could not prepare the selected request.";
          failure = { message };
        }
        const details = { ...failure.details, ...(state.supportId && { requestId: state.supportId }), ...(settled && { panda: settled }) };
        if (Object.keys(details).length) failure = { ...failure, details };
        const message = errorMessage(model, failure, aborted);
        if (state.finish === "content_filter") message.rawStopReason = "content_filter";
        return accounting?.apply(message, settled, options) ?? message;
      }
      let message = original;
      // Pi's agent invokes these three callbacks on foreground turns. Its native
      // summaries omit them and require length to reject an incomplete checkpoint.
      if (state.foreground && state.settled && state.finish === "length") {
        message = { ...message, stopReason: "stop", rawStopReason: "length", content: [
          ...message.content.filter(block => block.type !== "toolCall"),
          { type: "text", text: "\n[Panda reached the output limit. This answer is incomplete.]" },
        ] };
      }
      const result = usage.finish(message);
      return accounting?.apply(result, state.settled, options) ?? result;
    }

    const callback = fn => fn && (async (...args) => {
      try { return await fn(...args); }
      catch { state.callbackFailed = true; state.cancelBody?.(); throw new Error("Panda response callback failed."); }
    });
    const native = () => stream(model, context, {
      ...options, timeoutMs: sdkTimeout, maxRetries: 0, fetch: dispatch,
      async onPayload(payload, target) {
        if (foreground) state.foreground = true;
        return options.onPayload?.(payload, target);
      },
      onResponse: callback(options.onResponse),
      onProviderStreamEvent: callback(options.onProviderStreamEvent),
    });
    if (observe) return observe(native, finish);
    const result = native().result().then(finish, () => finish({ stopReason: "error" }));
    return { result: () => result };
  };
}
