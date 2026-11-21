import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

export async function checkSdkPicker(pi, signal) {
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
}
