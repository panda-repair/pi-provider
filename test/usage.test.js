import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { catalog } from "../src/catalog.js";
import { responseUsage } from "../src/usage.js";

const count = (input_tokens,output_tokens) => ({ usage:{ input_tokens,output_tokens,cached_input_tokens:100 } });
const base = { content:[{type:"text",text:"abcd"}], usage:{input:220000,output:45,cacheRead:5000,cacheWrite:0,
  totalTokens:225045,cost:{total:0}} };
const charge={schema_version:"panda.usd-amount.v1",currency:"USD",minor_units:"13"};

test("direct and routed Panels expose one conversation to all Pi token checks and keep separate spending details", () => {
  for (const id of ["panel:panda","auto:quality","auto"]) {
    const usage=responseUsage({id});
    usage.request('{"messages":[]}');
    usage.chunk({panda:{version:"panda.chat.v1",status:"completed",mode:"panel",agents:[count(75000,15),count(74000,15)],synthesis:count(160000,15),charge}});
    usage.chunk({choices:[],usage:{prompt_tokens:225000,completion_tokens:45,total_tokens:225045}});
    const message=usage.finish(base), out=message.usage;
    assert.deepEqual([out.input,out.cacheRead,out.cacheWrite,out.output,out.totalTokens],[74900,100,0,15,75015]);
    assert.deepEqual(message.diagnostics[0].details,{input:220000,output:45,cacheRead:5000,cacheWrite:0,totalTokens:225045});
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
  const large=responseUsage({id:"panel:panda"});
  large.chunk({panda:{mode:"panel",agents:[count(250000,4)],synthesis:count(280000,15)}});
  const actual=large.finish(base).usage;
  assert.equal(actual.input+actual.cacheRead,250000);
  assert.equal(actual.totalTokens,250015);
});

test("only reported Panel aggregate counters produce spending diagnostics, including a genuine zero trailer", () => {
  const meta={version:"panda.chat.v1",status:"completed",mode:"panel",agents:[count(1200,5)],synthesis:count(1600,10),charge};
  for (const counts of [undefined,null,{}, {prompt_tokens:0,completion_tokens:0,total_tokens:0}]) {
    const incoming=responseUsage({id:"auto"});
    incoming.chunk({choices:[{finish_reason:"stop"}],panda:meta});
    if (counts!==undefined) incoming.chunk({choices:[],usage:counts});
    const result=incoming.finish({...base,usage:{input:0,cacheRead:0,cacheWrite:0,output:0,totalTokens:0,cost:{total:0}}});
    assert.equal(result.usage.totalTokens,1210);assert.equal(result.usage.cost.total,.13);
    const aggregate=result.diagnostics?.find(item=>item.type==="panda.aggregate_usage")?.details;
    if (counts?.total_tokens===0) assert.deepEqual(aggregate,{input:0,output:0,cacheRead:0,cacheWrite:0,totalTokens:0});
    else assert.equal(aggregate,undefined);
  }
});

test("the user guide states the authorization, compaction and settlement rules", () => {
  const guide = readFileSync(new URL("../README.md", import.meta.url), "utf8");
  const rows = [...guide.matchAll(/^\| ([^|`]+) \| `panda\/([^`]+)` \| ([\d,]+) \|/gm)]
    .map(([, name, id, window]) => [id, name, Number(window.replaceAll(",", ""))]);
  // The guide lists the models from Panda Mini to Panda Max, as Panda's site does; the catalog keeps its order.
  assert.deepEqual(rows.map(([id]) => id), ["auto:cost", "auto", "panel:panda", "panel:panda-quality", "auto:quality"]);
  assert.deepEqual(rows.toSorted(), catalog.map(model => [model.id, model.name, model.contextWindow]).toSorted());
  for (const text of ["token saved by `/login` takes precedence over `PANDA_API_TOKEN`", "`/logout`",
    "187,000", "170,616", "1,022 caller messages", "751,413", "requests without tools to a model with a smaller window", "total wait budget of 60 seconds", "up to three", "3/2", "once per run", "pending and may be zero",
    "ADR 0079 slice C", "httpIdleTimeoutMs", "retry.provider.timeoutMs"]) assert.ok(guide.includes(text), text);
});
