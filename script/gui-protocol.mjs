// 窗口只是现有脚本的控制层：参数白名单、真实run.json快照和人工验证握手。
import fs from 'node:fs/promises';
import path from 'node:path';
import {createInterface} from 'node:readline';
import {randomBytes} from 'node:crypto';
import {visionModel} from './vision-engines.mjs';
import {reasoningEffort,evidenceMode} from './review-settings.mjs';
import {redactSecret} from './deepseek-vision.mjs';
import {validateMemberScope} from './member-scope.mjs';
import {captureWorkers} from './capture-pool.mjs';
import {reviewWorkers} from './review-queue.mjs';
import {normalizeQwenBaseURL} from './qwen-models.mjs';
import {TaskPause} from './task-pause.mjs';
const modes=new Set(['normal','resume','review','members','capture','login','check','browser']);
export const stoppedError=()=>Object.assign(Error('用户停止窗口任务'),{code:'USER_CANCELLED'});
export async function resolveBatchDirectory(value){
 if(typeof value!=='string'||!value.trim())throw Error('请先选择原任务目录');
 const dir=path.resolve(value);if(await fs.access(path.join(dir,'run.json')).then(()=>true,()=>false))return dir;
 for(const file of [path.join(dir,'其他','归档清单.json'),path.join(dir,'归档清单.json')]){
  let m;try{m=JSON.parse(await fs.readFile(file,'utf8'));}catch(e){if(e.code==='ENOENT')continue;throw e;}
  if(typeof m.sourceDirectory!=='string'||!path.isAbsolute(m.sourceDirectory))throw Error('桌面归档缺少项目原批次位置');
  const run=JSON.parse(await fs.readFile(path.join(m.sourceDirectory,'run.json'),'utf8'));if(run.id!==m.batchId)throw Error('桌面归档与原批次身份不一致');return m.sourceDirectory;
 }
 throw Error('目录内没有run.json或归档清单；请选择脚本批次或桌面任务目录');
}
export async function requestArgs(request,outputRoot){
 if(!request||request.command!=='start'||!modes.has(request.mode))throw Error('窗口运行方式无效');
 const mode=request.mode,source=request.source;if(!['sina','eastmoney'].includes(source))throw Error('请选择新浪或东方财富');
 const spec=visionModel(request.model),args=['--output-dir',path.resolve(outputRoot),'--model',spec.id];
 if(spec.provider==='qwen'&&['normal','resume','review','check'].includes(mode))args.push('--qwen-base-url',normalizeQwenBaseURL(request.qwenBaseUrl));
 if(request.captureWorkers!==undefined)args.push('--capture-workers',String(captureWorkers(request.captureWorkers)));
 args.push('--review-workers',String(reviewWorkers(request.reviewWorkers)));
 const effort=reasoningEffort(request.reasoningEffort,spec.id);
 if(spec.provider==='codex')args.push('--reasoning-effort',effort);
 if(request.compactEvidence!==undefined&&typeof request.compactEvidence!=='boolean')throw Error('精简图证选项须为开关');
 const selectedEvidence=evidenceMode(request.evidenceMode,request);args.push('--evidence-mode',selectedEvidence);
 if(selectedEvidence==='full')args.push('--full-evidence');
 if(mode==='login'||mode==='check'||mode==='browser')return [...args,mode==='login'?'--login':mode==='check'?'--check':'--check-browser','--source',source];
 if(request.allMembers!==undefined&&typeof request.allMembers!=='boolean')throw Error('全部成分股选项须为开关');
 validateMemberScope({limit:request.limit,allMembers:request.allMembers,memberPercent:request.memberPercent});
 for(const [key,minimum,maximum]of[['limit',1,10],['captureSeconds',5,3600],['reviewSeconds',5,3600]])if(!Number.isInteger(request[key])||request[key]<minimum||request[key]>maximum)throw Error(key==='limit'?'每板块股票数须为1—10整数':'采集/复核上限须为5—3600秒整数');
 args.push('--limit',String(request.limit),'--timeout-seconds',String(request.captureSeconds),'--review-timeout-seconds',String(request.reviewSeconds));
 if(request.taskName!==undefined){if(typeof request.taskName!=='string'||request.taskName.length>200)throw Error('任务名无效或过长');if(request.taskName.trim())args.push('--task-name',request.taskName.trim());}
 if(mode==='review'||mode==='resume')args.push(mode==='review'?'--review-only':'--resume',await resolveBatchDirectory(request.batchDirectory));
 else{
  if(!Array.isArray(request.sectors)||!request.sectors.length||request.sectors.length>10||request.sectors.some(s=>typeof s!=='string'||!s.trim()||s.length>80||/[,，;；\r\n]/.test(s)))throw Error('每行输入一个板块，至少1个、最多10个，空行请删除或填写');
  const names=[...new Set(request.sectors.map(s=>s.trim()))];args.push('--sectors',names.join(','));
  if(request.allMembers===true)args.push('--all-members');
  if(request.memberPercent!=null)args.push('--member-percent',String(request.memberPercent));
  if(mode==='members')args.push('--members-only');if(mode==='capture')args.push('--capture-only');
 }
 if(mode!=='review')args.push('--source',source);return args;
}
export function guiSnapshot(run,directory){
 const items=run.items||[],passed=items.filter(i=>i.result?.status==='符合').length,eliminated=items.filter(i=>i.result?.status==='淘汰').length;
 const visited=items.filter(i=>i.attemptedAt||i.quoteSnapshot).length,reviewed=items.filter(i=>i.review&&i.reviewImageSHA256===i.imageSHA256).length;
 const captured=items.filter(i=>i.chartFile).length,decided=items.filter(i=>['符合','淘汰'].includes(i.result?.status)||i.review&&i.reviewImageSHA256===i.imageSHA256||i.captureError).length;
 const matches=items.filter(i=>i.result?.status==='符合'&&i.chartFile&&i.chartVisualConfirmed===true&&i.reviewImageSHA256===i.imageSHA256).map(i=>({code:i.code,name:i.name}));
 return{directory,batchId:run.id,status:run.status,stage:run.currentStage||'准备任务',pipeline:run.pipeline,matches,total:items.length,visited,captured,reviewed,passed,eliminated,pending:items.length-passed-eliminated,unvisited:items.length-visited,
  percent:items.length?Math.min(95,Math.floor((visited+decided)/(items.length*2)*95)):0,error:run.error||'',errorCode:run.errorCode||'',marketSource:run.marketSource||'eastmoney',sectors:run.sectors?.map(s=>s.name)||[],members:run.status==='members_only'?items.map(i=>({code:i.code,name:i.name})):undefined};
}
export class GuiControl{
 constructor(emit){this.emit=emit;this.controller=new AbortController();this.sequence=0;this.pending=null;this.taskPause=new TaskPause();let previous='';this.taskPause.subscribe(state=>{const key=state.requested+':'+state.status;if(key!==previous){previous=key;emit({type:'pause-state',...state});}});}
 get signal(){return this.controller.signal;}
 stop(){if(!this.signal.aborted)this.controller.abort(stoppedError());}
 continue(id){if(this.pending&&id===this.pending.id)this.pending.resolve();}
 async waitForUser({kind,message,signal}={}){
  const combined=signal?AbortSignal.any([signal,this.signal]):this.signal;combined.throwIfAborted();if(this.pending)throw Error('已有人工确认正在等待');
  const id=++this.sequence;let abort;
  const waiting=new Promise((resolve,reject)=>{abort=()=>reject(combined.reason);this.pending={id,resolve};combined.addEventListener('abort',abort,{once:true});if(combined.aborted)abort();});
  try{this.emit({type:'waiting',id,kind:kind||'verification',message});await waiting;}
  finally{combined.removeEventListener('abort',abort);this.pending=null;this.emit({type:'waiting-ended',id});}
 }
}
export async function serveGUI({input,emit:rawEmit,run,root,recover,interrupt=()=>{}}={}){
 let secret='',qwenSecret='';const emit=event=>rawEmit(JSON.parse(redactSecret(redactSecret(JSON.stringify(event),secret),qwenSecret)));
 const control=new GuiControl(emit),lines=createInterface({input,crlfDelay:Infinity});let started=false,finishing=false,finish;
 const completed=new Promise(resolve=>finish=resolve);let latest=null,outputRoot=null,activeRead=false,timer,lastDirectory='';const snapshotStamps=new Map();
 async function snapshot(){
  if(!outputRoot||activeRead)return;activeRead=true;
  try{const names=await fs.readdir(outputRoot);for(const name of names){const directory=path.join(outputRoot,name);if(!(await fs.stat(directory)).isDirectory())continue;lastDirectory=directory;let r;try{const file=path.join(directory,'run.json'),info=await fs.stat(file,{bigint:true}),stamp=info.mtimeNs+':'+info.size;if(snapshotStamps.get(file)===stamp)continue;r=JSON.parse(await fs.readFile(file,'utf8'));snapshotStamps.set(file,stamp);}catch(e){if(['ENOENT','ENOTDIR'].includes(e.code))continue;throw e;}latest=guiSnapshot(r,directory);emit({type:'progress',...latest});}}
  catch(e){if(e.code!=='ENOENT')emit({type:'log',message:'进度快照暂未就绪：'+e.message});}finally{activeRead=false;}
 }
 async function start(request){
  let exitCode=1,error='',failure=null;
  try{
   if(request.deepseekApiKey!==undefined&&typeof request.deepseekApiKey!=='string')throw Error('DeepSeek密钥须为文本');
   if(request.qwenApiKey!==undefined&&typeof request.qwenApiKey!=='string')throw Error('千问密钥须为文本');
   if(request.model==='deepseek-flash')secret=(request.deepseekApiKey||'').trim();
   if(visionModel(request.model).provider==='qwen')qwenSecret=(request.qwenApiKey||'').trim();
   outputRoot=path.join(root,'脚本结果','窗口任务',new Date().toISOString().replace(/[-:.]/g,'')+'-'+randomBytes(3).toString('hex'));
   const args=await requestArgs(request,outputRoot);control.signal.throwIfAborted();await fs.mkdir(outputRoot,{recursive:true});
   emit({type:'started',mode:request.mode,source:request.source,model:visionModel(request.model).id});timer=setInterval(()=>void snapshot(),400);
   exitCode=await run(args,{deepseekApiKey:secret||undefined,qwenApiKey:qwenSecret||undefined,waitForUser:options=>control.waitForUser(options),signal:control.signal,pause:control.taskPause,onFailure:report=>failure=report});
  }catch(e){error=control.signal.aborted?control.signal.reason.message:e.message;failure={error,errorCode:e.code||'',ioCode:e.ioCode||'',failedFile:e.file||''};emit({type:'error',message:error});}
  finally{
   clearInterval(timer);while(activeRead)await new Promise(resolve=>setTimeout(resolve,10));await snapshot();
   if(exitCode!==0&&!failure&&lastDirectory)try{failure=JSON.parse(await fs.readFile(path.join(lastDirectory,'启动失败.json'),'utf8'));}catch{}
   error=error||failure?.error||latest?.error||'';
   let errorSummary=error,errorCode=failure?.errorCode||latest?.errorCode||'';
   if(exitCode!==0&&!errorSummary&&latest?.pending>0)errorSummary=`本轮尚有${latest.pending}只待审核，其中${latest.unvisited}只未访问；已完成判定与原图保留，可继续任务处理缺项`;
   if(errorCode==='STATE_SAVE_FAILED'||['EPERM','EACCES','EBUSY'].includes(errorCode)&&/rename/.test(error))errorSummary=`保存结果失败（${failure?.ioCode||errorCode}）：${path.basename(failure?.failedFile||'run.json')} 无法替换，已有判定和截图保留在原记录中`;
   let archiveDirectory='',archiveError='';if(latest)try{const receipt=JSON.parse(await fs.readFile(path.join(latest.directory,'桌面归档.json'),'utf8'));if(receipt.status==='failed')archiveError=receipt.error;else{archiveDirectory=receipt.directory||'';if(receipt.status==='partial')archiveError='部分文件未归档，请查看归档清单';}}catch(e){if(exitCode===0&&['normal','resume','review','capture'].includes(request.mode))archiveError='未找到桌面归档记录，请查看原记录和日志';}
   if(recover&&exitCode!==0&&lastDirectory&&(!archiveDirectory||latest?.status==='running'))try{const saved=await recover(lastDirectory,{exitCode,error:error||'脚本未正常收尾'});archiveDirectory=saved.archiveDirectory||archiveDirectory;archiveError=saved.archiveError||'';if(saved.snapshot){latest=saved.snapshot;emit({type:'progress',...latest});}emit({type:'log',message:'已把最后保存的进度补存桌面：'+archiveDirectory});}catch(e){archiveError='异常退出补存失败：'+e.message;}
   finishing=true;emit({type:'finished',exitCode,stopped:control.signal.aborted,error,errorSummary,errorCode,mode:request.mode,archiveDirectory,archiveError,snapshot:latest});finish();
  }
 }
 lines.on('line',line=>{
  try{if(line.length>30000)throw Error('窗口命令过长');const msg=JSON.parse(line);
   if(msg.command==='stop'){if(!control.signal.aborted)emit({type:'log',message:'收到窗口停止请求，正在保存已有判定与进度'});control.stop();interrupt();}
   else if(msg.command==='pause'&&started&&!finishing&&!control.signal.aborted){control.taskPause.pause();emit({type:'log',message:'收到暂停请求：停止新增采图和审核，已在途工作保存后暂停'});}
   else if(msg.command==='resume'&&started&&!finishing&&!control.signal.aborted){control.taskPause.resume();emit({type:'log',message:'继续当前任务剩余队列，保留已完成项'});}
   else if(msg.command==='continue')control.continue(msg.id);
   else if(msg.command==='start'&&!started){started=true;void start(msg);}
   else emit({type:'log',message:'忽略重复或未知窗口命令'});
  }catch(e){emit({type:'error',message:e.message});if(!started)finish();}
 });
 lines.on('close',()=>{if(started&&!finishing){emit({type:'log',message:'窗口控制管道关闭，正在停止并保存任务'});control.stop();interrupt();}else finish();});
 emit({type:'ready'});await completed;clearInterval(timer);lines.close();
}
