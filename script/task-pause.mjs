// 协作式暂停：在途工作保存后停在边界，不结束任务、不重发模型请求。
export class TaskPause {
 constructor({now=Date.now}={}){this.now=now;this.requested=false;this.active=0;this.listeners=new Set();this.waiters=new Set();this.pausedSince=null;this.pausedTotal=0;}
 get pausedMs(){return this.pausedTotal+(this.pausedSince===null?0:this.now()-this.pausedSince);}
 state(){return{requested:this.requested,status:this.requested?(this.active?'pausing':'paused'):'running',active:this.active};}
 subscribe(listener){this.listeners.add(listener);return()=>this.listeners.delete(listener);}
 publish(){const state=this.state();if(state.status==='paused'&&this.pausedSince===null)this.pausedSince=this.now();else if(state.status!=='paused'&&this.pausedSince!==null){this.pausedTotal+=this.now()-this.pausedSince;this.pausedSince=null;}for(const listener of this.listeners)listener(state);}
 pause(){if(this.requested)return;this.requested=true;this.publish();}
 resume(){if(!this.requested)return;this.requested=false;for(const wake of [...this.waiters])wake();this.publish();}
 async wait(signal){
  while(this.requested){
   signal?.throwIfAborted();let wake,abort;
   try{await new Promise((resolve,reject)=>{wake=resolve;abort=()=>reject(signal.reason);this.waiters.add(wake);signal?.addEventListener('abort',abort,{once:true});if(signal?.aborted)abort();else if(!this.requested)wake();});}
   finally{this.waiters.delete(wake);signal?.removeEventListener('abort',abort);}
  }
  signal?.throwIfAborted();
 }
 async enter(signal){
  for(;;){await this.wait(signal);if(!this.requested){this.active++;this.publish();let released=false;return()=>{if(released)return;released=true;this.active--;this.publish();};}}
 }
 async run(task,signal){const release=await this.enter(signal);try{return await task();}finally{release();}}
 bindBudget(budget){
  const key=Symbol('task-pause'),update=state=>state.status==='paused'?budget.hold(key):budget.release(key);update(this.state());const unsubscribe=this.subscribe(update);
  return()=>{unsubscribe();budget.release(key);};
 }
}
