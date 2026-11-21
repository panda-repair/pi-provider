import { settlement } from "./errors.js";

const tokenCount = value => Number.isSafeInteger(value) && value >= 0 && value <= 16_777_216;

function callTokens(call) {
  const usage = call?.usage;
  if (!tokenCount(usage?.input_tokens)) return;
  const cacheRead = tokenCount(usage.cached_input_tokens) && usage.cached_input_tokens <= usage.input_tokens
    ? usage.cached_input_tokens : 0;
  return { input: usage.input_tokens, cacheRead, output: tokenCount(usage.output_tokens) ? usage.output_tokens : undefined };
}

// Pi uses totalTokens for compaction and input + cacheRead for silent overflow.
export function responseUsage(model) {
  let mode, prompt, charge;
  let incomingEstimate = 0;
  return {
    request(body) { incomingEstimate = typeof body === "string" ? Math.ceil(body.length / 4) : 0; },
    chunk(data) {
      const panda = data?.panda;
      if (panda?.mode !== "panel" && panda?.mode !== "single") return;
      mode = panda.mode;
      charge = settlement(undefined, panda)?.charge;
      if (mode !== "panel") return;
      const synthesis = callTokens(panda.synthesis);
      let largest;
      if (Array.isArray(panda.agents) && panda.agents.length <= 128) {
        for (const agent of panda.agents) {
          const member = callTokens(agent);
          if (member && (!largest || member.input > largest.input)) largest = member;
        }
      }
      // A synthesizer can see private member drafts that do not enter the next Pi turn.
      prompt = largest ? { ...largest, output: synthesis?.output } : synthesis;
    },
    finish(message) {
      if (!message.usage) return message;
      const usage = { ...message.usage };
      if (charge) usage.cost = { ...usage.cost, total: Number(charge.minor_units) / 100, totalFromProvider: true };
      if (mode === "panel" || (!mode && (model.id.startsWith("panel:") || ["auto", "auto:quality"].includes(model.id)))) {
        const visible = message.content?.map(block => block.text ?? JSON.stringify(block.arguments ?? "")).join("") ?? "";
        const aggregate = {};
        for (const field of ["input", "output", "cacheRead", "cacheWrite", "totalTokens"]) {
          if (tokenCount(usage[field])) aggregate[field] = usage[field];
        }
        const input = prompt?.input ?? incomingEstimate;
        usage.cacheRead = prompt?.cacheRead ?? 0;
        // Cache writes are already in the chosen prompt. Pi's overflow test ignores
        // cacheWrite, so leave them in input and retain the aggregate split separately.
        usage.input = input - usage.cacheRead;
        usage.cacheWrite = 0;
        usage.output = prompt?.output ?? Math.ceil(visible.length / 4);
        usage.totalTokens = input + usage.output;
        return { ...message, usage, diagnostics: [...(message.diagnostics ?? []),
          { type: "panda.aggregate_usage", timestamp: message.timestamp, details: aggregate }] };
      }
      return { ...message, usage };
    },
  };
}

// Keep receipt accounting separate from request identity. The short cache covers
// concurrent streams and standalone calls. Saved Pi messages cover older session receipts.
export function settlementAccounting() {
  const recent = new Set();
  const checkpoints = new Map();
  let history, evicted = false;
  const marker = "panda.checkpoint_receipts";

  function inHistory(id) {
    return history.getEntries().some(entry =>
      (entry.type === "message" && entry.message?.provider === "panda" &&
        entry.message.diagnostics?.some(item => item.type === "panda.settlement" && item.details?.runId === id)) ||
      (entry.type === "custom" && entry.customType === marker && Array.isArray(entry.data?.runIds) && entry.data.runIds.includes(id)));
  }
  return {
    bind(manager) { history = manager; checkpoints.clear(); },
    beginCheckpoint(kind, signal) { checkpoints.set(kind, { signal, runs: new Set() }); },
    endCheckpoint(kind, entry, append) {
      const pending = checkpoints.get(kind);
      checkpoints.delete(kind);
      if (entry?.type === kind && entry.usage?.cost.total > 0 && pending?.runs.size) {
        append(marker, { checkpointId: entry.id, runIds: [...pending.runs] });
      }
    },
    apply(message, receipt, key, responseId, signal) {
      const charge = receipt?.charge;
      if (!charge) return message;
      const id = receipt.run_id ?? responseId ?? receipt.request_id ?? key;
      let duplicate = recent.has(id);
      if (!duplicate && receipt.replay) duplicate = !receipt.run_id || (history ? inHistory(id) : evicted);
      recent.add(id);
      if (recent.size > 1024) {
        recent.delete(recent.values().next().value);
        evicted = true;
      }
      const total = duplicate ? 0 : Number(charge.minor_units) / 100;
      // Native summaries save usage and drop assistant diagnostics, including run IDs.
      // Split compaction shares one signal across both calls. Only a persisted
      // checkpoint can write the IDs into the local session's accounting history.
      if (signal && receipt.run_id && total > 0 && message.stopReason === "stop") {
        for (const pending of checkpoints.values()) {
          if (pending.signal === signal) pending.runs.add(receipt.run_id);
        }
      }
      return { ...message, usage: { ...message.usage, cost: { ...message.usage.cost, total, totalFromProvider: true } },
        diagnostics: [...(message.diagnostics ?? []), { type: "panda.settlement", timestamp: message.timestamp,
          details: { ...(receipt.run_id && { runId: receipt.run_id }), usdCents: charge.minor_units, counted: !duplicate } }] };
    },
  };
}
