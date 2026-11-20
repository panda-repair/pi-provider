import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { responseUsage } from "../src/usage.js";
import { pandaStream, createRequestKeys } from "../src/request.js";

const count = (input_tokens,output_tokens) => ({ usage:{ input_tokens,output_tokens,cached_input_tokens:100 } });
const base = { content:[{type:"text",text:"abcd"}], usage:{input:220000,output:45,cacheRead:5000,cacheWrite:0,
  totalTokens:225045,cost:{total:0}} };
const charge={schema_version:"panda.usd-amount.v1",currency:"USD",minor_units:"13"};

test("direct and routed Panels preserve aggregate components and price but compact on one conversation", () => {
  for (const id of ["panel:panda","auto:quality","auto"]) {
    const usage=responseUsage({id});
    usage.request('{"messages":[]}');
    usage.chunk({panda:{mode:"panel",agents:[count(75000,15),count(74000,15)],synthesis:count(160000,15),charge}});
    const out=usage.finish(base).usage;
    assert.equal(out.totalTokens,75015); assert.equal(out.input+out.output+out.cacheRead+out.cacheWrite,225045);
    assert.equal(out.cost.total,0.13); assert.equal(out.cost.totalFromProvider,true);
  }
  const partial=responseUsage({id:"panel:panda"});
  partial.chunk({panda:{mode:"panel",agents:[count(100,20),count(120,30)]}});
  assert.equal(partial.finish(base).usage.totalTokens,121);
  const synthesisOnly = responseUsage({id:"auto"});
  synthesisOnly.chunk({panda:{mode:"panel",synthesis:count(160000,15)}});
  assert.equal(synthesisOnly.finish(base).usage.totalTokens,160015);
  const missing=responseUsage({id:"panel:panda"});
  missing.request("12345678"); assert.equal(missing.finish(base).usage.totalTokens,3);
  const single=responseUsage({id:"auto"});
  single.chunk({panda:{mode:"single"}}); assert.deepEqual(single.finish(base),base);
  assert.equal(base.usage.totalTokens,225045);
});

test("Panel transport honors explicit short and long timeouts and a ten-minute standalone default", async () => {
  for (const [given,expected] of [[undefined,600000],[15000,15000],[300000,300000],[650000,650000]]) {
    let timeout;
    const stream=pandaStream((_m,_c,options)=>{
      timeout=options.timeoutMs;
      return {result:async()=>({stopReason:"stop"})};
    },createRequestKeys(),()=>{});
    await stream({id:"panel:panda"},{},{timeoutMs:given}).result();
    assert.equal(timeout,expected);
  }
});

test("the user guide states the authorization, compaction and settlement rules", () => {
  const guide = readFileSync(new URL("../README.md", import.meta.url), "utf8");
  for (const text of ["token saved by `/login` takes precedence over `PANDA_API_TOKEN`", "`/logout`",
    "187,000", "170,616", "up to three", "3/2", "once per run", "pending and may be zero",
    "ADR 0079 slice C", "httpIdleTimeoutMs", "retry.provider.timeoutMs"]) assert.ok(guide.includes(text), text);
});
