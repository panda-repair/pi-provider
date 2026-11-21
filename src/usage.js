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
  let hasAggregate = false;
  let incomingEstimate = 0;
  return {
    request(body) { incomingEstimate = typeof body === "string" ? Math.ceil(body.length / 4) : 0; },
    chunk(data) {
      const counts = data?.usage ?? data?.choices?.[0]?.usage;
      if (counts != null) hasAggregate = tokenCount(counts.prompt_tokens) && tokenCount(counts.completion_tokens);
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
        let aggregate;
        if (hasAggregate) {
          aggregate = {};
          for (const field of ["input", "output", "cacheRead", "cacheWrite", "totalTokens"]) {
            if (tokenCount(usage[field])) aggregate[field] = usage[field];
          }
        }
        const input = prompt?.input ?? incomingEstimate;
        usage.cacheRead = prompt?.cacheRead ?? 0;
        // Cache writes are already in the chosen prompt. Pi's overflow test ignores
        // cacheWrite, so leave them in input and retain the aggregate split separately.
        usage.input = input - usage.cacheRead;
        usage.cacheWrite = 0;
        usage.output = prompt?.output ?? Math.ceil(visible.length / 4);
        usage.totalTokens = input + usage.output;
        return { ...message, usage, ...(aggregate && { diagnostics: [...(message.diagnostics ?? []),
          { type: "panda.aggregate_usage", timestamp: message.timestamp, details: aggregate }] }) };
      }
      return { ...message, usage };
    },
  };
}

// These are the entry types Pi 1.5.2 includes in its session spending.
function savedCost(entry) {
  if (entry.type === "message") {
    if (["assistant", "toolResult"].includes(entry.message?.role)) return entry.message.usage?.cost;
  } else if (["usage", "compaction", "branch_summary"].includes(entry.type)) return entry.usage?.cost;
}

const checkpointMarker = "panda.checkpoint_receipts";

function alreadyCounted(history, id) {
  if (!history || !id) return false;
  const entries = history.getEntries();
  return entries.some(entry => {
    const cost = savedCost(entry);
    if (Number.isFinite(cost?.total) && cost.total > 0) {
      if (Array.isArray(cost.pandaRunIds) && cost.pandaRunIds.includes(id)) return true;
      // Foreground receipts saved by earlier releases identified the run on the message.
      if (entry.type === "message" && entry.message.provider === "panda" &&
          Array.isArray(entry.message.diagnostics) && entry.message.diagnostics.some(item => item?.type === "panda.settlement" &&
            item.details?.runId === id && item.details.counted === true)) return true;
    }
    if (entry.type !== "custom" || entry.customType !== checkpointMarker ||
        !Array.isArray(entry.data?.runIds) || !entry.data.runIds.includes(id)) return false;
    const target = entries.find(row => row.id === entry.data.checkpointId);
    return ["compaction", "branch_summary"].includes(target?.type) && target.fromHook !== true && savedCost(target)?.total > 0;
  });
}

export function settlementAccounting() {
  let history, split;
  return {
    bind(manager) { history = manager; split = undefined; },
    beginSplit(signal) { split = { signal, headers: new WeakSet(), runIds: new Set() }; },
    agentHeaders(headers) { split?.headers.add(headers); },
    endSplit(entry, append) {
      const current = split;
      split = undefined;
      // Pi rebuilds Usage from numbers when combining a history and a turn-prefix
      // summary. A positively identified Panda leg can share that checkpoint with
      // an unpriced leg or a different provider.
      if (entry?.type === "compaction" && entry.usage?.cost?.total > 0 && current?.runIds.size) {
        append(checkpointMarker, { checkpointId: entry.id, runIds: [...current.runIds] });
      }
    },
    apply(message, receipt, options) {
      const charge = receipt?.charge;
      if (!charge) return message;
      const id = receipt.run_id;
      const duplicate = id ? alreadyCounted(history, id) : false;
      const cents = duplicate ? 0 : Number(charge.minor_units);
      if (id && cents > 0 && split && options?.signal === split.signal && split.headers.has(options.headers) && message.stopReason === "stop") {
        split.runIds.add(id);
      }
      // Persist the ID with the cost. Plain copies and custom producers retain it
      // whenever they keep the Panda Usage, even if no assistant message is saved.
      const cost = { ...message.usage.cost, total: cents / 100, totalFromProvider: true,
        ...(id && cents > 0 && { pandaRunIds: [id] }) };
      return { ...message, usage: { ...message.usage, cost },
        diagnostics: [...(message.diagnostics ?? []), { type: "panda.settlement", timestamp: message.timestamp,
          details: { ...(id && { runId: id }), usdCents: charge.minor_units, counted: !duplicate } }] };
    },
  };
}
