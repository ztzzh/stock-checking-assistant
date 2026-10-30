// 首张立即审核，后续数量/期限成批；1—32路独立批次，共享去重队列。
export function reviewWorkers(value=1){const n=Number(value);if(!['string','number'].includes(typeof value)||!Number.isInteger(n)||n<1||n>32)throw Error('审核路数仅支持1—32的整数');return n;}
export class ReviewQueue {
 constructor({process,onState=()=>{},signal,pause,workers=1,batchSize=3,maxWaitMs=10000,clock={now:Date.now,schedule:setTimeout,cancel:clearTimeout}}){
  if(!Number.isInteger(batchSize)||batchSize<1||!Number.isFinite(maxWaitMs)||maxWaitMs<0)throw Error('审核队列参数无效');
  Object.assign(this,{process,onState,signal,pause,workers:reviewWorkers(workers),batchSize,maxWaitMs,clock});this.pending=[];this.enqueuedAt=new Map();this.seen=new Set();this.jobs=new Map();this.closed=false;this.error=null;this.worker=null;this.timer=null;this.force=false;this.started=0;this.batches=0;this.completed=0;
  this.listening=false;this.onAbort=()=>{this.clearTimer();this.error??=signal.reason||Error('审核已停止');this.onState(this.state());};
  let requested=pause?.requested;this.unsubscribePause=pause?.subscribe(state=>{if(state.requested===requested)return;requested=state.requested;this.clearTimer();this.onState(this.state());if(!requested)this.start();});
 }
 get active(){return [...this.jobs.values()].flatMap(j=>j.codes);}
 state(){return{status:this.error?'failed':this.pause?.requested?(this.jobs.size?'pausing':'paused'):this.jobs.size?'running':this.closed&&!this.pending.length?'completed':'waiting',queued:this.pending.length,active:this.active.length,workers:this.workers,activeWorkers:this.jobs.size,lanes:[...this.jobs.values()].map(j=>({id:j.lane,batch:j.batch,codes:[...j.codes]})),completed:this.completed,batches:this.batches,batchSize:this.batchSize,maxWaitSeconds:this.maxWaitMs/1000,error:this.error?.message||''};}
 clearTimer(){if(this.timer!==null){this.clock.cancel(this.timer);this.timer=null;}}
 waitRemaining(){return this.pending.length?Math.max(0,this.maxWaitMs-(this.clock.now()-this.enqueuedAt.get(this.pending[0]))):0;}
 ready(){return this.pending.length&&(this.started===0||this.pending.length>=this.batchSize||this.closed||this.force||this.waitRemaining()===0);}
 add(codes,{flush=false}={}){
  if(this.closed)throw Error('审核队列已关闭');for(const code of codes)if(!this.seen.has(code)){this.seen.add(code);this.enqueuedAt.set(code,this.clock.now());this.pending.push(code);}if(this.pending.length&&!this.listening){this.signal?.addEventListener('abort',this.onAbort,{once:true});this.listening=true;}this.force ||= flush;this.onState(this.state());this.start();
 }
 start(){
  this.clearTimer();if(this.error)return;if(this.signal?.aborted){this.onAbort();return;}if(this.pause?.requested)return;
  while(this.jobs.size<this.workers&&this.ready()){
   let lane=1;while(this.jobs.has(lane))lane++;
   const codes=this.pending.splice(0,this.started===0?1:this.batchSize);for(const code of codes)this.enqueuedAt.delete(code);this.force=false;const job={lane,codes,batch:++this.started};this.jobs.set(lane,job);
   if(!this.worker)this.worker=new Promise(resolve=>this.resolveIdle=resolve);this.onState(this.state());
   this.work(job).catch(error=>{this.error??=error;this.clearTimer();}).finally(()=>{this.jobs.delete(lane);this.onState(this.state());this.start();if(!this.jobs.size){const resolve=this.resolveIdle;this.worker=null;this.resolveIdle=null;resolve?.();}});
  }
  if(this.pending.length&&this.jobs.size<this.workers&&!this.ready())this.timer=this.clock.schedule(()=>{this.timer=null;this.start();},this.waitRemaining());
 }
 async work(job){this.signal?.throwIfAborted();await this.process([...job.codes],{lane:job.lane,batch:job.batch});this.signal?.throwIfAborted();this.completed+=job.codes.length;this.batches++;}
 async finish(){
  this.closed=true;this.clearTimer();this.start();
  try{
   while(this.worker||this.pending.length&&!this.error){if(this.worker)await this.worker;else{await this.pause?.wait(this.signal);this.signal?.throwIfAborted();this.start();}}
   this.onState(this.state());if(this.error)throw this.error;this.signal?.throwIfAborted();
  }finally{this.clearTimer();this.signal?.removeEventListener('abort',this.onAbort);this.unsubscribePause?.();}
 }
}
