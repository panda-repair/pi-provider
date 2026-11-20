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

export function settlement(code, source) {
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


export const unknownOutcome = "The request may have run and been charged. Resending starts a new run and may charge you again.";
const throttles = new Set(["throttle_mixture_concurrency_exhausted", "throttle_workspace_rate_limited"]);

// Pi 1.5.2 classifies display text for retry and automatic overflow recovery.
// Machine-readable details are kept independently of that display policy.
export function describeError(status, data, headers, canDisplay = () => true) {
  const code = codes.has(data?.error?.code) ? data.error.code : undefined;
  const param = safeParam(data?.error?.param);
  const panda = settlement(code, data?.panda);
  const header = headers.get("x-panda-request-id");
  const id = asId(header, runId) ?? asId(header, requestId) ?? panda?.request_id ?? panda?.run_id;
  const replay = headers.get("idempotency-replayed")?.toLowerCase() === "true" || panda?.replay === true;
  if (panda && !panda.run_id && asId(header, runId)) panda.run_id = header;
  if (panda && replay) panda.replay = true;
  const throttle = status === 429 && throttles.has(code) && !replay && !data?.panda && !header;
  const retry = throttle && headers.get("x-should-retry")?.trim().toLowerCase() !== "false";
  const details = { status, ...(code && { code }), ...(param && { param }), ...(id && { requestId: id }),
    ...(panda && { panda }), ...(replay && { replay: true }) };
  let message = "Panda declined this request.";
  if (code === "mixture_idempotency_conflict") {
    message += " The request differs from the one previously submitted with this key. The original settlement is unknown. " + unknownOutcome;
  } else if (code === "mixture_already_running" || panda?.status === "running") {
    message += " The earlier identical request is still running. Its charge is pending and may be zero. Its answer cannot be recovered. Resending starts a separate, potentially billable run.";
  } else if (code === "context_length_exceeded" || code === "inference_request_too_large") {
    message += " The input exceeds Panda's admission limit. Shorten the conversation or compact it before submitting again.";
  } else if (panda || code?.startsWith("mixture_already_")) {
    if (replay || code?.startsWith("mixture_already_")) message += " The earlier request finished. Its answer cannot be recovered.";
    const amount = moneyText(panda?.charge);
    message += " " + (!panda?.charge || canDisplay(amount) ? amount : "The reported charge in USD is " + "USD" + (Number(panda.charge.minor_units) / 100).toFixed(2) + ".");
    message += panda?.charge ? " Resending starts a new run with its own charge." : " " + unknownOutcome;
  } else if (status >= 500 || status === 200 || status === 408 || replay || header || !code ||
             ["request_invalid", "authority_revoked", "input_too_large"].includes(code)) {
    message += " " + unknownOutcome;
  } else if (throttle) {
    message += " Panda could not admit the request within the permitted wait.";
  }
  for (const part of [code && "Code: " + code + ".", param && "Parameter: " + param + ".", id && "Panda request ID: " + id + "."]) {
    if (part && canDisplay(message + " " + part)) message += " " + part;
  }
  return { message, details, retry };
}

export function retryWait(value, attempt, now = Date.now()) {
  if (value === null) return 250 * 2 ** attempt;
  const milliseconds = /^\d+$/.test(value) ? Number(value) * 1000 :
    /^[A-Z][a-z]{2}, .+ GMT$/.test(value) ? Date.parse(value) - now : NaN;
  return Number.isFinite(milliseconds) ? Math.max(0, milliseconds) : Infinity;
}
