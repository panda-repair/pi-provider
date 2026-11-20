// Pi context estimates from Panda's coding-agent guide and ADR 0079 D5/D7 (recheck against production at publish).
const maxTokens = 16_384;
const unpriced = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

export const catalog = [
  { id: "auto", name: "Panda Auto", contextWindow: 224_000, maxTokens, cost: unpriced },
  { id: "auto:cost", name: "Panda Auto · Cost", contextWindow: 258_000, maxTokens, cost: unpriced },
  { id: "auto:quality", name: "Panda Auto · Quality", contextWindow: 187_000, maxTokens, cost: unpriced },
  { id: "panel:panda", name: "Panda Panel", contextWindow: 224_000, maxTokens, cost: unpriced },
  { id: "panel:panda-quality", name: "Panda Quality Panel", contextWindow: 224_000, maxTokens, cost: unpriced },
];

export const compat = {
  supportsStore: false,
  supportsReasoningEffort: false,
  promptCacheKeyMode: "disabled",
  supportsLongCacheRetention: false,
  supportsDeveloperRole: true,
  supportsUsageInStreaming: true,
};

export function isPandaSelector(id) {
  return catalog.some(model => model.id === id);
}

export function modelDefinitions(baseUrl) {
  return catalog.map(model => ({
    ...model,
    cost: { ...model.cost },
    type: "chat",
    provider: "panda",
    api: "openai-completions",
    baseUrl,
    input: ["text"],
    reasoning: false,
    compat: { ...compat },
  }));
}
