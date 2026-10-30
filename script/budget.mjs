// 预算只计算自动执行；人工验证期间停止倒计时，总墙钟用时另行记录。
export class ActiveBudget{
  constructor(milliseconds,onExpire,{now=Date.now,schedule=setTimeout,cancel=clearTimeout}={}){
    Object.assign(this,{remaining:milliseconds,onExpire,now,schedule,cancel});this.started=null;this.timer=null;this.holds=new Set();this.shouldRun=false;this.resume();
  }
  pause(){
    this.shouldRun=false;this.stopTimer();
  }
  stopTimer(){
    if(this.started===null)return;
    this.cancel(this.timer);this.remaining=Math.max(0,this.remaining-(this.now()-this.started));this.started=null;this.timer=null;
  }
  resume(){
    this.shouldRun=true;if(this.holds.size||this.started!==null)return;this.started=this.now();
    this.timer=this.schedule(()=>{this.started=null;this.timer=null;this.shouldRun=false;this.remaining=0;this.onExpire();},this.remaining);
  }
  hold(key){this.holds.add(key);this.stopTimer();}
  release(key){this.holds.delete(key);if(!this.holds.size&&this.shouldRun)this.resume();}
  dispose(){this.pause();}
}
export const budgetError=(message,code)=>Object.assign(new Error(message),{code});
// GUI使用任务信号，不广播进程SIGINT；命令行Ctrl+C也交给本任务保存后收尾。
export function bindTaskStop(controller,{signal,message='用户已停止脚本',processEvents=process}={}){
  const stop=()=>{if(!controller.signal.aborted)controller.abort(budgetError(message,'USER_CANCELLED'));};
  const forward=()=>{if(!controller.signal.aborted)controller.abort(signal.reason||budgetError(message,'USER_CANCELLED'));};
  processEvents.on('SIGINT',stop);signal?.addEventListener('abort',forward,{once:true});if(signal?.aborted)forward();
  return()=>{processEvents.off('SIGINT',stop);signal?.removeEventListener('abort',forward);};
}
export function abortCause(error,signal){return signal?.aborted&&signal.reason instanceof Error?signal.reason:error;}
export async function historyStageWithBudget(task,{screenBudget,milliseconds,controller,schedule=setTimeout,cancel=clearTimeout}){
  controller.signal.throwIfAborted();screenBudget?.pause();
  const timer=schedule(()=>controller.abort(budgetError(`板块历史取数达到${milliseconds/1000}秒独立预算，已保存取得的历史缓存；未完成全量排名`,'HISTORY_TIMEOUT')),milliseconds);
  try{const result=await task();controller.signal.throwIfAborted();return result;}
  finally{cancel(timer);if(!controller.signal.aborted)screenBudget?.resume();}
}

// 顺序调用保留旧的采集暂停行为；并行时两个活动阶段各自计时。空闲审核队列不消耗模型余额。
const reviewUsers=new WeakMap();
export async function reviewStageWithBudget(task,{screenBudget,reviewBudget,signal,captureSignal=signal,concurrent=false}={}){
  signal?.throwIfAborted();if(!concurrent)screenBudget?.pause();if(reviewBudget){const users=reviewUsers.get(reviewBudget)||0;if(!users)reviewBudget.resume();reviewUsers.set(reviewBudget,users+1);}
  try{const result=await task();signal?.throwIfAborted();return result;}
  finally{if(reviewBudget){const users=(reviewUsers.get(reviewBudget)||1)-1;if(users)reviewUsers.set(reviewBudget,users);else{reviewUsers.delete(reviewBudget);reviewBudget.pause();}}if(!concurrent&&!captureSignal?.aborted)screenBudget?.resume();}
}
// 累计“至少一路在审核”的时间；旧记录无开始时间时沿用其单路耗时。
export function reviewTimes(events){
 const rows=events.filter(e=>/^(?:视觉复核第|保存原图视觉复核)/.test(e.stage)&&Number.isFinite(e.elapsedMs)&&e.elapsedMs>=0);let total=0,unplaced=0;const intervals=[];
 for(const e of rows){total+=e.elapsedMs;const start=Date.parse(e.startedAt);if(Number.isFinite(start))intervals.push([start,start+e.elapsedMs]);else unplaced+=e.elapsedMs;}
 intervals.sort((a,b)=>a[0]-b[0]);let active=unplaced,end=-Infinity;for(const [start,stop]of intervals){active+=Math.max(0,stop-Math.max(start,end));end=Math.max(end,stop);}return{seconds:active/1000,workSeconds:total/1000};
}
