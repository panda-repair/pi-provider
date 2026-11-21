import assert from "node:assert/strict";
import { join } from "node:path";

const target = "panel:panda";
const context = text => ({ messages: [{ role: "user", content: text, timestamp: 1 }] });

export async function checkSavedUsage(pi, signal, mode) {
  const cwd = process.cwd();
  const folder = join(cwd, mode + "-history");
  const agentDir = process.env.PI_CODING_AGENT_DIR;
  const branch = mode === "saved-custom-branch";
  const custom = branch || mode === "saved-custom-manual";
  const split = mode === "saved-default-decoy";
  let selected, discarded;
  const customize = extension => {
    extension.on(branch ? "session_before_tree" : "session_before_compact", async (event, ctx) => {
      const model = ctx.modelRegistry.find("panda", target);
      const ask = (text, signal) => ctx.modelRegistry.complete(model, context(text), { signal, maxRetries: 0 });
      const extra = await ask("An auxiliary call.", event.signal);
      [discarded] = extra.usage.cost.pandaRunIds;
      if (split) return;
      const included = await ask("Build this checkpoint.", AbortSignal.timeout(5000));
      [selected] = included.usage.cost.pandaRunIds;
      const usage = JSON.parse(JSON.stringify(included.usage));
      const summary = "Retain the original fixture conversation.";
      if (branch) return { summary: { summary, usage } };
      const { firstKeptEntryId, tokensBefore } = event.preparation;
      return { compaction: { summary, usage, firstKeptEntryId, tokensBefore } };
    });
  };
  async function start(manager, handlers = []) {
    const services = await pi.createAgentSessionServices({
      cwd, agentDir, modelRuntimeSignal: signal, resourceLoaderOptions: { extensionFactories: handlers },
    });
    services.settingsManager.applyOverrides({ compaction: { enabled: true, keepRecentTokens: 1 } });
    const { modelRuntime } = services;
    const approval = await modelRuntime.refresh({ providers: ["panda"], signal });
    assert.equal(approval.errors.size, 0);
    const model = modelRuntime.getModel("panda", target);
    const { session } = await pi.createAgentSessionFromServices({ services, model, sessionManager: manager, noTools: "all" });
    await session.bindExtensions({ mode: "print" });
    return { session, model, modelRuntime };
  }
  const manager = pi.SessionManager.create(cwd, folder);
  const users = [];
  for (let index = 0; index < 6; index++) {
    users.push(manager.appendMessage({ role: "user", content: "Earlier request ".repeat(32) + index, timestamp: index }));
    manager.appendMessage({ role: "assistant", provider: "panda", api: "openai-completions", model: target,
      stopReason: "stop", content: [{ type: "text", text: "Earlier answer ".repeat(24) }], timestamp: index,
      usage: { input: 10, output: 10, cacheRead: 0, cacheWrite: 0, totalTokens: 20,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } });
  }
  const { session, model, modelRuntime } = await start(manager, custom || split ? [customize] : []);
  const file = manager.getSessionFile();
  try {
    if (custom || split) {
      if (branch) await session.navigateTree(users[0], { summarize: true });
      else await session.compact();
      const entries = pi.SessionManager.open(file, folder, cwd).getEntries();
      const checkpoint = entries.find(entry => entry.type === (branch ? "branch_summary" : "compaction"));
      assert.equal(checkpoint.fromHook, custom);
      const cost = checkpoint.usage.cost;
      if (split) {
        const marker = entries.find(entry => entry.customType === "panda.checkpoint_receipts" && entry.data.checkpointId === checkpoint.id);
        assert.equal(cost.total, .06);
        assert.equal(marker.data.runIds.length, 2);
        assert.ok(!marker.data.runIds.includes(discarded));
        [selected] = marker.data.runIds;
      } else {
        assert.deepEqual(cost.pandaRunIds, [selected]);
        assert.equal(cost.total, .03);
      }
    } else {
      const result = await modelRuntime.complete(model, context("An extension checks a fixture."), { signal, maxRetries: 0 });
      [selected] = result.usage.cost.pandaRunIds;
      assert.equal(result.usage.cost.total, .03);
      assert.equal(session.getSessionStats().cost, 0);
      if (mode === "saved-explicit") manager.appendUsage("fixture", "panda", target, structuredClone(result.usage));
      if (mode === "saved-tool") manager.appendMessage({ role: "toolResult", toolCallId: "fixture", toolName: "fixture",
        content: [{ type: "text", text: "Saved." }], timestamp: Date.now(), isError: false, usage: structuredClone(result.usage) });
      if (mode === "saved-standalone") {
        await session.prompt("FIXTURE_RECEIPT_" + selected);
        assert.equal(session.getSessionStats().cost, .03);
      }
    }
  } finally { session.dispose(); }
  const reopened = pi.SessionManager.open(file, folder, cwd);
  const second = await start(reopened);
  try {
    const prior = split ? .06 : .03;
    assert.equal(second.session.getSessionStats().cost, prior);
    // A second caller opens the receipt without sharing a response object or an operation signal.
    const replay = async (id, amount) => {
      const result = await second.modelRuntime.complete(second.model, context("FIXTURE_RECEIPT_" + id), { signal, maxRetries: 0 });
      assert.equal(result.stopReason, "error");
      assert.equal(result.usage.cost.total, amount);
      reopened.appendMessage(result);
    };
    await replay(selected, 0);
    if (discarded) {
      await replay(discarded, .03);
      await replay(discarded, 0);
    }
    assert.equal(second.session.getSessionStats().cost, discarded ? prior + .03 : prior);
  } finally { second.session.dispose(); }
  console.log(JSON.stringify({ mode, passed: true }));
}
