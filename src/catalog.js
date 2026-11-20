// Pi context estimates from Panda's coding-agent guide and ADR 0079 D5/D7 (recheck against production at publish).
const maxTokens = 16_384;
const unpriced = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

// USD per million tokens, including Panda's markup. Routed requests have no fixed rate.
export const catalog = [
  { id: "glm-5.3", name: "GLM-5.3", contextWindow: 258_000, maxTokens, cost: { input: 2.10, output: 6.60, cacheRead: 0.39, cacheWrite: 2.10 } },
  { id: "deepseek-v4.1-flash", name: "DeepSeek V4.1 Flash", contextWindow: 258_000, maxTokens, cost: { input: 0.45, output: 1.80, cacheRead: 0.009, cacheWrite: 0.45 } },
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

export function permittedModels(data, baseUrl) {
  if (!Array.isArray(data)) throw new Error("Panda model discovery returned an invalid model list.");
  const allowed = new Set(data.map(entry => entry?.id));
  const direct = allowed.has("glm-5.3") || allowed.has("deepseek-v4.1-flash");
  const toolRoute = direct || allowed.has("panel:panda");
  return catalog.filter(model => allowed.has(model.id) && (!model.id.startsWith("auto") ||
    (model.id === "auto:cost" ? direct : toolRoute))).map(model => ({
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
