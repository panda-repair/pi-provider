import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { registerHooks } from "node:module";
import { pathToFileURL } from "node:url";

export async function checkSdkPicker(pi, signal, dist) {
  const stock=process.env.PI_CODING_AGENT_DIR, cwd=process.cwd();
  const correct=process.env.PANDA_API_TOKEN;
  process.env.PANDA_FIXTURE_PICKER=correct;
  process.env.PANDA_API_TOKEN="pnd_it_decoy";
  for (const independent of [false,true]) {
    const agentDir=join(cwd,independent?"sdk-runtime":"sdk-agent");
    const folder=independent?join(cwd,"sdk-models"):agentDir;
    mkdirSync(agentDir,{recursive:true}); mkdirSync(folder,{recursive:true});
    const settings=JSON.parse(readFileSync(join(stock,"settings.json"),"utf8"));
    settings.packages=settings.packages.map(entry=>resolve(stock,entry));
    writeFileSync(join(agentDir,"settings.json"),JSON.stringify(settings));
    const modelsPath=join(folder,"models.json");
    writeFileSync(modelsPath,"\ufeff// Fixture configured for this runtime.\n"+JSON.stringify({providers:{panda:{apiKey:"$PANDA_FIXTURE_PICKER"}}}));
    const start=async()=>{
      const modelRuntime=independent?await pi.ModelRuntime.create({modelsPath,authPath:join(agentDir,"auth.json")}):undefined;
      return pi.createAgentSessionServices({agentDir,cwd,modelRuntime,modelRuntimeSignal:signal});
    };
    const bind=async services=>{
      const selection=services.modelRuntime.getModel("panda","auto");
      const {session}=await pi.createAgentSessionFromServices({services,model:selection,sessionManager:pi.SessionManager.inMemory(cwd),noTools:"all"});
      await session.bindExtensions({mode:"print"});
      return session;
    };
    const visible=async runtime=>(await runtime.getAvailable("panda",{signal})).map(row=>row.id);
    const services=await start(), runtime=services.modelRuntime;
    const first=await runtime.refresh({providers:["panda"],signal});
    assert.equal(first.errors.size,0);assert.deepEqual(await visible(runtime),[]);
    const session=await bind(services);
    assert.equal((await visible(runtime)).length,5);
    process.env.PANDA_FIXTURE_PICKER="pnd_it_rotated";
    assert.deepEqual(await visible(runtime),[]);
    process.env.PANDA_FIXTURE_PICKER=correct;
    session.dispose();
    const warm=await start();
    assert.deepEqual(await visible(warm.modelRuntime),[]);
    const restarted=await bind(warm);
    assert.equal((await visible(warm.modelRuntime)).length,5);
    restarted.dispose();
  }
  // The embedding SDK supplies these peers. Load the actual package export with that same host.
  const ai=resolve(dist,"../../pi-ai/dist");
  const peers=new Map([["@earendil-works/pi-coding-agent",join(dist,"index.js")],
    ["@earendil-works/pi-ai",join(ai,"index.js")],["@earendil-works/pi-ai/compat",join(ai,"compat.js")]]);
  const hooks=registerHooks({resolve(name,ctx,next){
    return peers.has(name)?{url:pathToFileURL(peers.get(name)).href,shortCircuit:true}:next(name,ctx);
  }});
  let bind;
  try { ({withPandaModelRuntime:bind}=await import("../../index.js")); } finally { hooks.deregister(); }
  const agentDir=join(cwd,"owner-runtime");
  mkdirSync(agentDir,{recursive:true});
  const modelsPath=join(agentDir,"models.json");
  writeFileSync(modelsPath,JSON.stringify({providers:{panda:{apiKey:"$PANDA_FIXTURE_PICKER"}}}));
  const owner=await pi.ModelRuntime.create({modelsPath,authPath:join(agentDir,"auth.json")});
  const services=await pi.createAgentSessionServices({cwd,agentDir,modelRuntime:owner,modelRuntimeSignal:signal,
    settingsManager:pi.SettingsManager.inMemory(),resourceLoaderOptions:{
      noExtensions:true,noContextFiles:true,noSkills:true,extensionFactories:[bind(owner)]}});
  assert.equal((await owner.refresh({providers:["panda"],signal})).errors.size,0);
  const visible=async()=>(await owner.getAvailable("panda",{signal})).map(row=>row.id);
  assert.equal((await visible()).length,5);
  const state=await pi.createAgentSessionFromServices({services,model:owner.getModel("panda","auto"),
    sessionManager:pi.SessionManager.inMemory(cwd),noTools:"all"});
  const lifecycle=new pi.AgentSessionRuntime(state.session,services,()=>{throw new Error("Unexpected session switch.");});
  await state.session.bindExtensions({mode:"print"});
  assert.equal((await visible()).length,5);
  await lifecycle.dispose();
  assert.equal((await visible()).length,5);
  process.env.PANDA_FIXTURE_PICKER="pnd_it_rotated";
  assert.deepEqual(await visible(),[]);
  process.env.PANDA_FIXTURE_PICKER=correct;
}
