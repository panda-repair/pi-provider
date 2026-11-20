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
