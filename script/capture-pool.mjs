// 浏览器页面独立；共享名单分配、人工验证和有界待审队列。不重试个股，不处理验证码。
export function captureWorkers(value=6){const n=Number(value);if(!['string','number'].includes(typeof value)||!Number.isInteger(n)||n<1||n>6)throw Error('采图路数仅支持1—6的整数');return n;}
async function abortable(promise,signal){
 signal?.throwIfAborted();let abort;
 try{return await Promise.race([promise,new Promise((_,reject)=>{abort=()=>reject(signal.reason);signal?.addEventListener('abort',abort,{once:true});if(signal?.aborted)abort();})]);}
 finally{signal?.removeEventListener('abort',abort);}
}
export class CaptureCoordinator {
 constructor({signal,pause,onBudgetState=()=>{},backlogLimit=6,now=Date.now}={}){
  Object.assign(this,{signal,pause,onBudgetState,backlogLimit,now});this.lanes=[];this.claimed=new Set();this.listeners=new Set();this.waiters=new Set();this.version=0;this.gates=0;this.gateTail=Promise.resolve();this.manualTotal=0;this.manualStart=null;this.error=null;this.running=false;this.finished=false;
 }
 get manualWaitMs(){return this.manualTotal+(this.manualStart===null?0:this.now()-this.manualStart);}
 subscribe(fn){this.listeners.add(fn);return()=>this.listeners.delete(fn);}
 wake(){this.version++;for(const wake of [...this.waiters])wake();}
 state(){return{workers:this.lanes.length,active:this.lanes.filter(l=>l.status==='running').length,waitingForManual:this.gates>0,waitingForReview:this.lanes.filter(l=>l.status==='waiting-review').length,lanes:this.lanes.map(l=>({...l})),backlogLimit:this.backlogLimit};}
 publish(){this.wake();const s=this.state();this.onBudgetState(this.gates>0||this.finished||this.running&&s.active===0&&(s.waitingForReview>0||this.lanes.some(l=>l.status==='waiting-manual')));for(const fn of this.listeners)fn(s);}
 async changed(version){
  if(this.version!==version)return;this.signal?.throwIfAborted();let wake;
  try{await abortable(new Promise(resolve=>{wake=resolve;this.waiters.add(wake);if(this.version!==version)resolve();}),this.signal);}
  finally{this.waiters.delete(wake);}
 }
 halt(error){this.error??=error;this.wake();}
 async ready(lane,{queue,hasWork=()=>true,startItem=false}={}){
  for(;;){
   this.signal?.throwIfAborted();if(this.error)throw this.error;if(!hasWork())return;
   if(startItem&&this.pause?.requested){lane.status='paused';this.publish();await this.pause.wait(this.signal);continue;}
   const state=queue?.state(),backlog=state&&!state.error&&state.status!=='failed'&&state.queued>=this.backlogLimit;
   if(!this.gates&&!backlog){if(lane.status!=='running'){lane.status='running';this.publish();}return;}
   const waiting=this.gates?'waiting-manual':'waiting-review';if(lane.status!==waiting){lane.status=waiting;this.publish();}const version=this.version;await this.changed(version);
  }
 }
 async beforeStage(lane){await this.ready(lane);}
 async verification(task,laneId){
  if(this.gates++===0)this.manualStart=this.now();this.publish();
  const previous=this.gateTail;let release;this.gateTail=new Promise(resolve=>release=resolve);
  try{await abortable(previous,this.signal);this.signal?.throwIfAborted();return await task(laneId);}
  finally{release();if(--this.gates===0){this.manualTotal+=this.now()-this.manualStart;this.manualStart=null;}this.publish();}
 }
 async run(items,browsers,process,{queue}={}){
  if(!browsers.length||browsers.length>6||new Set(browsers).size!==browsers.length)throw Error('每路采图必须使用独立浏览器页面适配器（1—6路）');
  const pages=browsers.map(b=>b.page).filter(Boolean);if(new Set(pages).size!==pages.length)throw Error('多路采图不能共用同一页面');
  if(new Set(items.map(i=>i.code)).size!==items.length)throw Error('采图名单存在重复代码');
  this.lanes=browsers.map((_b,n)=>({id:n+1,status:'idle',code:'',name:'',detail:'准备'}));this.running=true;this.finished=false;let cursor=0;this.publish();
  const consume=async(browser,lane)=>{
   try{while(cursor<items.length&&!this.error){
    await this.ready(lane,{queue,hasWork:()=>cursor<items.length,startItem:true});const release=await this.pause?.enter(this.signal);
    try{
     if(cursor>=items.length||this.error)break;
     const item=items[cursor++];this.claimed.add(item.code);Object.assign(lane,{status:'running',code:item.code,name:item.name,detail:'准备'});this.publish();
     await process(item,browser,lane);
    }finally{lane.status='idle';this.publish();release?.();}
   }}catch(error){this.halt(error);}
   lane.status=this.error||this.signal?.aborted?'stopped':'completed';lane.detail=lane.status==='stopped'?'停止':'完成';this.publish();
  };
  try{await Promise.allSettled(browsers.map((b,n)=>consume(b,this.lanes[n])));if(this.error)throw this.error;this.signal?.throwIfAborted();}
  finally{this.running=false;this.finished=true;this.publish();}
 }
}
