// 真实EXE/Node/正式采图与审核队列的暂停联通夹具；全部股票、图片、审核均为合成。
import assert from 'node:assert/strict';import fs from 'node:fs/promises';import path from 'node:path';import {setTimeout as delay} from 'node:timers/promises';
import {serveGUI} from '../script/gui-protocol.mjs';import {runScreening,options} from '../script/screen.mjs';import {LiveArchiveSession} from '../script/live-archive.mjs';import {selectionDay} from '../script/selected-sectors.mjs';import {TENCENT_SOURCE} from '../script/tencent-history.mjs';import {reviewTargets} from '../script/vision.mjs';
const root=process.env.SCREENING_GUI_TEST_ROOT,scenario=process.env.SCREENING_GUI_TEST_SCENARIO;
if(!root||!path.isAbsolute(root)||!['fixture-task-pause','fixture-task-pause-stop'].includes(scenario))throw Error('仅允许软件暂停验收');
const emit=e=>process.stdout.write(JSON.stringify(e)+'\n'),sector={code:'pt01801081',name:'合成行业',kind:'industry',source:TENCENT_SOURCE};
await serveGUI({root,input:process.stdin,emit,run:async(args,ui)=>{
 const cfg=options(args),dir=path.join(cfg.outputRoot,'pause-fixture');await fs.mkdir(dir);let quotes=0,charts=0,reviews=0,pausedCounts,continued=false;const seen=[],reviewed=[];let freezeCheck=Promise.resolve();
 ui.pause.subscribe(state=>{
  if(state.status==='paused'&&!pausedCounts){pausedCounts={quotes,charts,reviews};freezeCheck=delay(250).then(()=>{assert.deepEqual({quotes,charts,reviews},pausedCounts);return true;});}
  if(pausedCounts&&!state.requested)continued=true;
 });
 const archive=new LiveArchiveSession(dir,cfg,{desktopDir:path.join(root,'fake-desktop'),log:message=>emit({type:'log',message})});
 const browsers=Array.from({length:cfg.captureWorkers},()=>({page:{},stockQuote:async item=>{quotes++;seen.push(item.code);await delay(350,null,{signal:ui.signal});return{code:item.code,name:item.name,price:'12',open:'11',dateText:selectionDay(),source:cfg.source,image:Buffer.from('合成报价'+item.code)};},chart:async item=>{await delay(150,null,{signal:ui.signal});charts++;return{image:Buffer.from('合成15分钟图'+item.code),capturedAt:new Date().toISOString(),chartInfo:{source:cfg.source,selectedPeriod:'15分钟',readiness:{ready:true}}};}}));
 const run=await runScreening(cfg,{directory:dir,browsers,pause:ui.pause,signal:ui.signal,reviewSignal:ui.signal,catalogLoader:async kind=>({kind,total:1,entries:[kind==='industry'?sector:{...sector,kind,code:'pt02GN2442',name:'合成概念'}]}),memberLoader:async()=>({sector:sector.code,source:TENCENT_SOURCE,total:18,items:Array.from({length:18},(_,n)=>({code:String(300001+n),name:'合成股票'+n,market:'sz',url:'https://quote.eastmoney.com/sz'+(300001+n)+'.html',membershipSource:TENCENT_SOURCE,membershipSector:sector.code}))}),review:async r=>{
  reviews++;const targets=reviewTargets(r);reviewed.push(...targets.map(i=>i.code));await delay(300,null,{signal:ui.signal});return{marketDate:selectionDay(),marketPhase:'软件合成',rankingEvidenceConfirmed:true,quoteEvidenceConfirmed:true,notes:'暂停夹具',stocks:targets.map(i=>({code:i.code,identityConfirmed:true,period15mConfirmed:true,latestBarDate:selectionDay(),allMALabelsVisible:true,volumeComplete:true,chartPrice:12,ma5:12,ma10:12,ma20:11.8,ma60:11,shape:'pass',nearMA20:'pass',ma20Above60:'pass',redVolume:'pass',reason:'软件合成'}))};
 },onProgress:r=>archive.schedule(r),log:message=>emit({type:'log',message})});await freezeCheck;await archive.flush(run);
 assert(pausedCounts&&pausedCounts.quotes>0);assert(run.pauseSeconds>=.25);assert.equal(seen.length,new Set(seen).size);assert.equal(reviewed.length,new Set(reviewed).size);
 if(scenario.endsWith('-stop')){assert.equal(run.status,'interrupted');assert.equal(continued,false);}else{assert(continued);assert.equal(run.counts.passed,18);assert.equal(quotes,18);assert.equal(charts,18);assert.equal(reviewed.length,18);}
 await fs.writeFile(path.join(root,'暂停联通证据.json'),JSON.stringify({status:'passed',scenario,batchId:run.id,pausedCounts,continued,quotes,charts,reviews,reviewedCodes:reviewed,uniqueCapture:true,uniqueReview:true,resultStatus:run.status,counts:run.counts,scope:'正式队列合成测试，无行情及模型调用'},null,2));return run.status==='completed'?0:2;
}});process.stdin.destroy();
