import { usd } from "./errors.js";

const tokenCount = value => Number.isSafeInteger(value) && value >= 0 && value <= 16_777_216;

function callTokens(call) {
  const usage = call?.usage;
  if (!tokenCount(usage?.input_tokens)) return;
  return { input: usage.input_tokens, output: tokenCount(usage.output_tokens) ? usage.output_tokens : undefined };
}

// Pi 1.5.2 sums the component fields for accounting and reads totalTokens for compaction.
export function responseUsage(model) {
  let mode, prompt, charge;
  let incomingEstimate = 0;
  return {
    request(body) { incomingEstimate = typeof body === "string" ? Math.ceil(body.length / 4) : 0; },
    chunk(data) {
      const panda = data?.panda;
      if (panda?.mode !== "panel" && panda?.mode !== "single") return;
      mode = panda.mode;
      charge = usd(panda.charge);
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
      prompt = largest ? { input: largest.input, output: synthesis?.output } : synthesis;
    },
    finish(message) {
      if (!message.usage) return message;
      const usage = { ...message.usage };
      if (charge) usage.cost = { ...usage.cost, total: Number(charge.minor_units) / 100, totalFromProvider: true };
      if (mode === "panel" || (!mode && (model.id.startsWith("panel:") || ["auto", "auto:quality"].includes(model.id)))) {
        const visible = message.content?.map(block => block.text ?? JSON.stringify(block.arguments ?? "")).join("") ?? "";
        const output = prompt?.output ?? Math.ceil(visible.length / 4);
        usage.totalTokens = Math.max(1, (prompt?.input ?? incomingEstimate) + output);
      }
      return { ...message, usage };
    },
  };
}

// Keep receipt accounting separate from request identity. The short cache covers
// concurrent streams and standalone calls. Saved Pi messages cover older session receipts.
export function settlementAccounting() {
  const recent = new Set();
  let history, evicted = false;
  return {
    bind(manager) { history = manager; },
    apply(message, receipt, key, responseId) {
      const charge = receipt?.charge;
      if (!charge) return message;
      const id = receipt.run_id ?? responseId ?? receipt.request_id ?? key;
      const duplicate = recent.has(id) || (receipt.replay && (!receipt.run_id || evicted || history?.getEntries().some(entry =>
        entry.type === "message" && entry.message?.provider === "panda" &&
        entry.message.diagnostics?.some(item => item.type === "panda.settlement" && item.details?.runId === id))));
      recent.add(id);
      if (recent.size > 1024) {
        recent.delete(recent.values().next().value);
        evicted = true;
      }
      const total = duplicate ? 0 : Number(charge.minor_units) / 100;
      return { ...message, usage: { ...message.usage, cost: { ...message.usage.cost, total, totalFromProvider: true } },
        diagnostics: [...(message.diagnostics ?? []), { type: "panda.settlement", timestamp: message.timestamp,
          details: { ...(receipt.run_id && { runId: receipt.run_id }), usdCents: charge.minor_units, counted: !duplicate } }] };
    },
  };
}
