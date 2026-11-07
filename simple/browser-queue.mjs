// The only browser owner is this process. No database leases or cross-container locks.
// Scheduled captures are disposable subprocess groups; previews are interactive priority.
import { fork } from "node:child_process";
import { randomUUID } from "node:crypto";
import path from "node:path";

const SLEEP=ms=>new Promise(resolve=>setTimeout(resolve,ms));
export class BrowserQueue {
  #capture=null;
  #preview=null;
  #waiters=[];
  #closed=false;
  get status(){return {capture:!!this.#capture,preview:!!this.#preview,queued_previews:this.#waiters.length};}
  async capture(monitor,dataDir,limits={}){
    if(this.#closed) throw Error("queue_closed");
    if(this.#preview||this.#waiters.length||this.#capture) return {skipped:true};
    const outputName=randomUUID()+".png";
    const runner=path.resolve(import.meta.dirname,"capture-runner.mjs");
    const child=fork(runner,[],{detached:true,stdio:["ignore","ignore","ignore","ipc"],env:{
      NODE_ENV:"production",PLAYWRIGHT_EXECUTABLE_PATH:process.env.PLAYWRIGHT_EXECUTABLE_PATH??"/usr/bin/chromium",
      PATH:process.env.PATH??"/usr/bin:/bin",HOME:process.env.HOME??"/home/node",
    }});
    const state={child,cancelled:false,done:false};
    this.#capture=state;
    const hardLimit=Math.min(120000,Math.max(1000,Number(monitor.capture_timeout_ms)||Number(limits.CAPTURE_TIMEOUT_MS)||30000)+15000);
    try {
      return await new Promise(resolve=>{
        let settled=false;
        const finish=value=>{if(settled)return;settled=true;clearTimeout(timer);resolve(value);};
        const timer=setTimeout(()=>{
          state.cancelled=true;
          this.#terminate(state);
          finish({failed:true,code:"capture_timeout"});
        },hardLimit);
        child.on("message",message=>finish(message));
        child.on("exit",()=>finish(state.cancelled?{skipped:true}:{failed:true,code:"capture_process_exit"}));
        child.on("error",()=>finish({failed:true,code:"capture_spawn_failed"}));
        child.send({monitor,outputName,dataDir,limits},error=>{
          if(error)finish({failed:true,code:"capture_ipc_failed"});
        });
      });
    } finally {
      state.done=true;
      if(this.#capture===state)this.#capture=null;
      this.#wake();
      // A finished response is not evidence that the child process tree exited.
      // A child is never reused, and a remaining process group is reaped.
      if(child.exitCode===null) this.#terminate(state);
    }
  }
  #terminate(state){
    if(!state||state.child.exitCode!==null||state.child.pid===undefined)return;
    try {process.kill(-state.child.pid,"SIGTERM");} catch {}
    const child=state.child;
    const cleanup=setTimeout(()=>{
      if(child.exitCode===null)try{process.kill(-child.pid,"SIGKILL");}catch{}
    },1500);
    cleanup.unref();
    child.once("exit",()=>clearTimeout(cleanup));
  }
  #wake(){const next=this.#waiters.shift();next?.();}
  async acquirePreview({signal,waitMs=12000}={}){
    if(this.#closed) return null;
    if(this.#capture){
      this.#capture.cancelled=true;
      this.#terminate(this.#capture);
    }
    const started=Date.now();
    while(this.#capture||this.#preview){
      if(this.#closed||signal?.aborted||Date.now()-started>=waitMs)return null;
      await Promise.race([
        new Promise(resolve=>{
          const wake=()=>resolve();
          this.#waiters.push(wake);
          setTimeout(()=>{const i=this.#waiters.indexOf(wake);if(i>=0)this.#waiters.splice(i,1);resolve();},Math.min(500,waitMs));
        }),
        SLEEP(Math.min(500,waitMs)),
      ]);
    }
    const token=randomUUID();
    this.#preview=token;
    return {workload:"preview",slot:1,signal,release:async()=>{
      if(this.#preview===token){this.#preview=null;this.#wake();}
    }};
  }
  close(){
    this.#closed=true;
    if(this.#capture){this.#capture.cancelled=true;this.#terminate(this.#capture);}
    this.#preview=null;
    while(this.#waiters.length)this.#wake();
  }
}
