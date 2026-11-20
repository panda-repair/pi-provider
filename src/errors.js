// Error bodies can contain prior messages, tool arguments or complete Panel answers.
// Only the documented code, parameter vocabulary, identifiers and USD fields cross into Pi.
const codes = new Set((
  "invalid_request unsupported_parameter conflicting_parameters unsupported_message_order idempotency_key_invalid " +
  "mixture_model_unavailable context_length_exceeded mixture_cost_bound_exceeded request_invalid inference_request_invalid " +
  "inference_token_invalid insufficient_workspace_balance commercial_balance_correction_required mixture_model_denied " +
  "inference_authority_denied inference_personal_owner_required authority_revoked chat_completions_not_enabled model_not_found " +
  "route_not_found method_not_allowed mixture_already_running mixture_already_completed mixture_already_partial mixture_already_failed " +
  "mixture_idempotency_conflict inference_request_too_large input_too_large throttle_mixture_concurrency_exhausted " +
  "throttle_workspace_rate_limited throttle_commercial_balance_source_bound_exceeded internal_error answer_invalid " +
  "answer_incomplete no_answers model_unavailable model_refused interrupted outcome_unknown mixture_store_unavailable " +
  "inference_upstream_unavailable"
).split(" "));
const beforeAdmission = new Map([
  [400, ["invalid_request", "unsupported_parameter", "conflicting_parameters", "unsupported_message_order", "idempotency_key_invalid",
    "mixture_model_unavailable", "context_length_exceeded", "mixture_cost_bound_exceeded", "inference_request_invalid"]],
  [401, ["inference_token_invalid"]], [402, ["insufficient_workspace_balance", "commercial_balance_correction_required"]],
  [403, ["mixture_model_denied", "inference_authority_denied", "inference_personal_owner_required"]],
  [404, ["chat_completions_not_enabled", "model_not_found", "route_not_found"]], [405, ["method_not_allowed"]],
  [413, ["inference_request_too_large", "input_too_large"]],
  [429, ["throttle_mixture_concurrency_exhausted", "throttle_workspace_rate_limited", "throttle_commercial_balance_source_bound_exceeded"]],
]);
const unsuccessful = new Set(["answer_invalid", "answer_incomplete", "no_answers", "model_unavailable", "model_refused", "request_invalid", "authority_revoked"]);
const uncertain = new Set(["internal_error", "interrupted", "outcome_unknown", "mixture_store_unavailable", "inference_upstream_unavailable"]);
const statuses = new Set(["running", "completed", "partial", "failed"]);
const fields = new Set(("model messages tools tool_choice parallel_tool_calls max_tokens max_completion_tokens stream stream_options " +
  "n logprobs top_logprobs response_format temperature top_p stop user seed store metadata service_tier functions function_call " +
  "reasoning_effort prompt_cache_key prompt_cache_retention presence_penalty frequency_penalty response_format.type " +
  "stream_options.include_usage panda.synthesizer_model Idempotency-Key Authorization").split(" "));
const schemaPath = /^(tools\[\d{1,3}\]\.function\.parameters)(?:[.[].*)?$/;
const nestedField = /^(?:tools\[\d{1,3}\]\.(?:type|function(?:\.(?:name|description|strict))?)|messages\[\d{1,4}\]\.(?:role|name|tool_call_id|reasoning(?:_content|_text|_details)?|content(?:\[\d{1,4}\]\.(?:type|text))?|tool_calls(?:\[\d{1,3}\]\.(?:id|type|function\.(?:name|arguments)))?))$/;
const runId = /^(?:run[-_])?(?:[a-f0-9]{32}|[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12})$/i;
const requestId = /^req_[0-9a-f]{32}$/;
const asId = (value, pattern) => typeof value === "string" && value.length <= 64 && pattern.test(value) ? value : undefined;

function safeParam(value) {
  if (typeof value !== "string" || value.length > 128) return null;
  if (fields.has(value) || nestedField.test(value)) return value;
  return schemaPath.exec(value)?.[1] ?? null;
}

export function usd(value) {
  return value?.schema_version === "panda.usd-amount.v1" && value.currency === "USD" &&
    typeof value.minor_units === "string" && /^(?:0|[1-9][0-9]{0,11})$/.test(value.minor_units)
    ? { schema_version: "panda.usd-amount.v1", currency: "USD", minor_units: value.minor_units } : undefined;
}

export async function boundedJSON(response, limit = 16_384, timeout = 1000) {
  if (!response.body || response.bodyUsed || response.body.locked || Number(response.headers.get("content-length")) > limit) return;
  const reader = response.clone().body.getReader();
  // Cancellation of the cloned tee may wait for its other branch. Never await it.
  let expired = false;
  const timer = setTimeout(() => { expired = true; void reader.cancel().catch(() => {}); }, timeout);
  const chunks = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (expired) return;
      if (done) return JSON.parse(Buffer.concat(chunks, size).toString("utf8"));
      size += value.byteLength;
      if (size > limit) return;
      chunks.push(value);
    }
  } catch {
    return;
  } finally {
    clearTimeout(timer);
    void reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

function settlement(code, source) {
  const valid = source?.version === "panda.chat.v1" && statuses.has(source.status);
  if (!valid) return;
  const status = source.status;
  if (code?.startsWith("mixture_already_") && code !== "mixture_already_" + status) return;
  const charge = status === "running" ? null : usd(source.charge);
  const held = status === "running" ? null : usd(source.held);
  return {
    version: "panda.chat.v1", status, ...(source.replay === true && { replay: true }),
    request_id: asId(source.request_id, requestId), run_id: asId(source.run_id, runId),
    charge, held: held?.minor_units === "0" || held === null ? held : undefined,
  };
}

function moneyText(charge) {
  if (!charge) return "The settlement amount is unknown.";
  const cents = Number(charge.minor_units);
  return "The settled charge is US$" + Math.floor(cents / 100) + "." + String(cents % 100).padStart(2, "0") + ".";
}

export function describeError(status, data, headers) {
  const code = codes.has(data?.error?.code) ? data.error.code : undefined;
  const param = safeParam(data?.error?.param);
  const panda = settlement(code, data?.panda);
  const id = asId(headers.get("x-panda-request-id"), runId) ?? asId(headers.get("x-panda-request-id"), requestId) ?? panda?.request_id ?? panda?.run_id;
  const marked = headers.get("idempotency-replayed")?.toLowerCase() === "true" || data?.panda?.replay === true;
  const admitted = data?.panda != null || headers.has("x-panda-request-id");
  const zero = panda?.charge?.minor_units === "0" && panda.held?.minor_units === "0";
  const positive = panda?.charge != null && panda.charge.minor_units !== "0";
  let action = "same";
  let message = "Panda returned HTTP " + status + (code ? " (" + code + ")" : "") + ".";
  if (code === "context_length_exceeded") message += " The request exceeds the maximum context length.";
  if (param) message += " Parameter: " + param + ".";
  if (code === "mixture_idempotency_conflict") {
    action = "terminal";
    message += " The request changed after its first attempt. The original settlement is unknown.";
  } else if (code === "mixture_already_running") {
    action = "terminal";
    message += " The earlier identical request is still running. Its charge is pending and may be zero. Its answer cannot be recovered. Submitting again starts a separate, potentially billable run.";
  } else if (code === "mixture_already_completed" || code === "mixture_already_partial") {
    action = "terminal";
    message += " The earlier request finished. Its answer cannot be recovered. " + moneyText(panda?.charge) + " Submitting again starts a separate run.";
  } else if (positive || ["failed", "partial", "completed"].includes(data?.panda?.status) || code === "mixture_already_failed" ||
             unsuccessful.has(code) || (admitted && !uncertain.has(code) && !marked)) {
    action = zero ? "fresh" : "terminal";
    message += " " + moneyText(panda?.charge);
  } else if (!admitted && !marked && beforeAdmission.get(status)?.includes(code)) {
    action = "fresh";
  } else if (zero && panda.status !== "running") {
    action = "fresh";
    message += " " + moneyText(panda.charge);
  }
  if (id) message += " Panda request ID: " + id + ".";
  const cleanHeaders = { "content-type": "application/json" };
  if (id) cleanHeaders["x-panda-request-id"] = id;
  if (marked) cleanHeaders["idempotency-replayed"] = "true";
  const veto = headers.get("x-should-retry");
  if (action === "terminal" || veto === "false") cleanHeaders["x-should-retry"] = "false";
  const delay = headers.get("retry-after");
  if (delay && /^\d{1,3}$/.test(delay) && Number(delay) <= 600) cleanHeaders["retry-after"] = delay;
  const error = { message, code: code ?? "panda_request_error", param };
  return { action, message, status, headers: cleanHeaders, details: { code, param, requestId: id }, body: JSON.stringify({ error, ...(panda && { panda }) }) };
}

export function errorResponse(error) {
  return new Response(error.body, { status: error.status, headers: error.headers });
}

// The SDK consumes SSE error frames before its native chunk callback. Observe bounded
// complete frames in transit so the session can retain a safe code and settlement.
export function observeStreamErrors(response, report) {
  if (!response.body || !response.headers.get("content-type")?.toLowerCase().includes("text/event-stream")) return response;
  let pieces = [], size = 0, lineLength = 0, last = 0;
  const limit = 16_384;
  function append(piece) {
    size += piece.length;
    if (size <= limit && piece.length) pieces.push(piece);
    else if (size > limit) pieces = [];
  }
  function frame() {
    if (size <= limit) {
      const text = Buffer.concat(pieces, size).toString("utf8");
      const data = text.split(/\r?\n/).filter(line => line.startsWith("data:")).map(line => line.slice(5).trimStart()).join("\n");
      if (data.includes('"error"')) {
        try { const obj = JSON.parse(data); if (obj?.error && !obj.choices) report(obj); } catch { /* Native parser reports malformed frames. */ }
      }
    }
    pieces = []; size = 0;
  }
  const body = response.body.pipeThrough(new TransformStream({
    transform(chunk, controller) {
      let start = 0;
      for (let i = 0; i < chunk.length; i++) {
        const byte = chunk[i];
        if (byte === 10) {
          append(chunk.subarray(start, i + 1));
          if (lineLength === 0 || (lineLength === 1 && last === 13)) frame();
          lineLength = 0;
          start = i + 1;
        } else { lineLength++; }
        last = byte;
      }
      append(chunk.subarray(start));
      controller.enqueue(chunk);
    },
  }));
  return new Response(body, { status: response.status, headers: response.headers });
}
