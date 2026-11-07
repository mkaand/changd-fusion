// Isolated disposable browser subprocess: one capture per process.
// No database access, no persistent browser lease, and no auth secrets.
import { capture } from "../server/dist/capture.js";
import { openSync,writeFileSync,closeSync,renameSync,unlinkSync,mkdirSync } from "node:fs";
import path from "node:path";

let started=false;
process.on("message",async message=>{
  if(started) return;
  started=true;
  const {monitor,outputName,dataDir,limits}=message??{};
  if(typeof dataDir!=="string"||!path.isAbsolute(dataDir)||!/^[a-f0-9-]{36}\.png$/.test(outputName??"")){
    process.send?.({ok:false,code:"invalid_capture_job"}); return;
  }
  const cfg={
    NODE_ENV:"production",DATABASE_URL:"unused",JWT_SECRET:"unused",CHANNEL_KEY:"unused",
    PORT:8000,PUBLIC_URL:"http://127.0.0.1",DATA_DIR:dataDir,REGISTRATION_ENABLED:"false",
    HISTORY_DAYS:90,CAPTURE_TIMEOUT_MS:30000,CHROMIUM_CONCURRENCY:1,
    PREVIEW_CAPACITY_WAIT_MS:0,MAX_CAPTURE_WIDTH:4096,MAX_CAPTURE_HEIGHT:8192,
    MAX_CAPTURE_PIXELS:8000000,PLAYWRIGHT_EXECUTABLE_PATH:process.env.PLAYWRIGHT_EXECUTABLE_PATH??"/usr/bin/chromium",
    LOG_LEVEL:"warn",...limits,
  };
  const artifacts=path.join(dataDir,"artifacts");
  const target=path.join(artifacts,outputName),temporary=target+".part";
  try {
    const result=await capture(monitor,cfg);
    if(result.screenshot){
      mkdirSync(artifacts,{recursive:true,mode:0o700});
      const fd=openSync(temporary,"wx",0o600);
      try { writeFileSync(fd,result.screenshot); } finally { closeSync(fd); }
      renameSync(temporary,target);
    }
    process.send?.({ok:true,text:result.text,screenshot:result.screenshot?outputName:null,http_status:result.http_status??null,warning:result.warning??null,timings:result.timings??{}});
  } catch(error){
    try { unlinkSync(temporary); } catch {}
    process.send?.({ok:false,code:typeof error?.code==="string" ? error.code : "capture_failed",stage:typeof error?.stage==="string"?error.stage:"unknown"});
  } finally {
    setTimeout(()=>process.exit(0),150).unref();
  }
});
