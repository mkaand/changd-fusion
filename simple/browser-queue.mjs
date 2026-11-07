// A single runtime owns the browser slot. Disposable browser jobs are isolated
// process groups. Capacity is NEVER released before child process exit.
import { fork } from "node:child_process";
import { randomUUID } from "node:crypto";
import path from "node:path";
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
export class BrowserQueue {
  #running=null;
  #preview=null;
  #waiting=0;
  #closed=false;
  get status(){return {capture:!!this.#running,preview:!!this.#preview,queued_previews:this.#waiting};}
  #terminate(state){
    if(!state||!state.child.pid||state.child.exitCode!==null||state.terminating)return;
    state.terminating=true;
    try{process.kill(-state.child.pid,"SIGTERM");}catch{}
    const child=state.child;
    const hard=setTimeout(()=>{
      if(child.exitCode===null)try{process.kill(-child.pid,"SIGKILL");}catch{}
    },1200);
    hard.unref();child.once("exit",()=>clearTimeout(hard));
  }
  async capture(monitor,dataDir,limits={}){
    if(this.#closed)throw Error("queue_closed");
    if(this.#preview||this.#waiting||this.#running)return {skipped:true};
    const child=fork(path.resolve(import.meta.dirname,"capture-runner.mjs"),[],{
      detached:true,stdio:["ignore","ignore","ignore","ipc"],
      env:{NODE_ENV:"production",PLAYWRIGHT_EXECUTABLE_PATH:process.env.PLAYWRIGHT_EXECUTABLE_PATH??"/usr/bin/chromium",
        PATH:process.env.PATH??"/usr/bin:/bin",HOME:process.env.HOME??"/home/node"}
    });
    const state={child,cancelled:false,terminating:false};
    this.#running=state;
    let output=null,failed=null;
    const timeout=Math.min(120000,Math.max(1000,Number(monitor.capture_timeout_ms)||Number(limits.CAPTURE_TIMEOUT_MS)||30000)+15000);
    const timer=setTimeout(()=>{failed="capture_timeout";this.#terminate(state);},timeout);
    const stuck=setTimeout(()=>{
      // If the whole subprocess group cannot be fenced, a container restart
      // is safer than admitting a second Chromium against a live orphan.
      console.error(JSON.stringify({code:"capture_subprocess_fencing_failed"}));
      process.exit(1);
    },timeout+8000);
    timer.unref();stuck.unref();
    try {
      return await new Promise(resolve=>{
        child.on("message",message=>{
          if(output!==null)return;
          output=message;
          try{child.disconnect();}catch{}
          // Successful capture must fully exit before another browser is admitted.
          setTimeout(()=>this.#terminate(state),1000).unref();
        });
        child.once("exit",()=>{
          clearTimeout(timer);clearTimeout(stuck);
          resolve(state.cancelled?{skipped:true}:failed?{failed:true,code:failed}:output??{failed:true,code:"capture_process_exit"});
        });
        child.once("error",()=>{
          failed="capture_spawn_failed";
          this.#terminate(state);
        });
        child.send({monitor,outputName:randomUUID()+".png",dataDir,limits},error=>{
          if(error){failed="capture_ipc_failed";this.#terminate(state);}
        });
      });
    } finally {
      clearTimeout(timer);clearTimeout(stuck);
      if(this.#running===state)this.#running=null;
    }
  }
  async acquirePreview({signal,waitMs=12000}={}){
    if(this.#closed)return null;
    this.#waiting++;
    try {
      if(this.#running){this.#running.cancelled=true;this.#terminate(this.#running);}
      const deadline=Date.now()+Math.max(0,waitMs);
      while(this.#running||this.#preview){
        if(this.#closed||signal?.aborted||Date.now()>=deadline)return null;
        await sleep(40);
      }
      if(this.#closed||signal?.aborted)return null;
      const token=randomUUID();
      this.#preview=token;
      return {workload:"preview",slot:1,signal,release:async()=>{
        if(this.#preview===token)this.#preview=null;
      }};
    } finally {this.#waiting--;}
  }
  close(){
    this.#closed=true;
    if(this.#running){this.#running.cancelled=true;this.#terminate(this.#running);}
    this.#preview=null;
  }
}
