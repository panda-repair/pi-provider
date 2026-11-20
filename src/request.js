import { createHash, randomUUID } from "node:crypto";

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
    });
    void events.result().then(message => attempt?.finish(message.stopReason), () => attempt?.finish("error"));
    return events;
  };
}
