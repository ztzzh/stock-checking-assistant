// 多路调度、网页和模型均为软件夹具；不查询行情或调用付费模型。
import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs/promises';import path from 'node:path';import os from 'node:os';import {setTimeout as delay} from 'node:timers/promises';import {createHash} from 'node:crypto';
import {CaptureCoordinator,captureWorkers} from '../script/capture-pool.mjs';import {runScreening,options,prepareResume} from '../script/screen.mjs';import {requestArgs} from '../script/gui-protocol.mjs';import {reviewTargets} from '../script/vision.mjs';import {TENCENT_SOURCE} from '../script/tencent-history.mjs';import {selectionDay} from '../script/selected-sectors.mjs';
import {TaskPause} from '../script/task-pause.mjs';
const latch=()=>{let resolve;const promise=new Promise(r=>resolve=r);return{promise,resolve};};
const sector={code:'pt01801081',name:'合成行业',kind:'industry',source:TENCENT_SOURCE};
const catalogLoader=async kind=>({kind,total:1,entries:[kind==='industry'?sector:{...sector,kind,code:'pt02GN2442',name:'合成概念'}]});
const members=count=>async s=>({source:TENCENT_SOURCE,sector:s.code,total:count,items:Array.from({length:count},(_,n)=>({code:String(300001+n),name:'合成'+n,market:'sz',url:'https://quote.eastmoney.com/sz'+(300001+n)+'.html',membershipSource:TENCENT_SOURCE,membershipSector:s.code}))});
const payload=r=>({marketDate:selectionDay(),marketPhase:'合成',rankingEvidenceConfirmed:true,quoteEvidenceConfirmed:true,notes:'软件夹具',stocks:reviewTargets(r).map(i=>({code:i.code,identityConfirmed:true,period15mConfirmed:true,latestBarDate:selectionDay(),allMALabelsVisible:true,volumeComplete:true,chartPrice:12,ma5:12,ma10:12,ma20:11.8,ma60:11,shape:'pass',nearMA20:'pass',ma20Above60:'pass',redVolume:'pass',reason:'合成通过'}))});
async function temp(t){const dir=await fs.mkdtemp(path.join(os.tmpdir(),'stock-two-capture-'));t.after(async()=>{assert.equal(path.dirname(dir),path.resolve(os.tmpdir()));await fs.rm(dir,{recursive:true,force:true});});return dir;}
const cfg=(count=8)=>options(['--sectors','合成行业','--limit',String(count)]);
function adapter({quoteHook=async()=>{},chartHook=async()=>{}}={}){let current;return{page:{},stockQuote:async i=>{current=i.code;await quoteHook(i);assert.equal(current,i.code);return{source:'eastmoney',url:i.url,code:i.code,name:i.name,price:'12',open:'11',dateText:selectionDay(),image:Buffer.from('报价'+i.code)};},chart:async i=>{assert.equal(current,i.code);await chartHook(i);assert.equal(current,i.code);return{image:Buffer.from('主图'+i.code),capturedAt:new Date().toISOString(),chartInfo:{source:'eastmoney',url:i.url,selectedPeriod:'15分钟',readiness:{ready:true}}};}};}

test('两路分别占用独立适配器、最多2个在途任务，名单只分配一次',{timeout:5000},async()=>{
 const both=latch(),release=latch(),c=new CaptureCoordinator(),seen=[];let active=0,max=0;const items=Array.from({length:8},(_,n)=>({code:String(n)}));
 const work=c.run(items,[{page:{}},{page:{}}],async item=>{seen.push(item.code);max=Math.max(max,++active);if(seen.length===2)both.resolve();await release.promise;active--;});await both.promise;assert.equal(max,2);assert.equal(seen.length,2);release.resolve();await work;assert.equal(new Set(seen).size,8);assert.equal(c.state().workers,2);assert(c.state().lanes.every(l=>l.status==='completed'));
});
test('拒绝同一页面、重复代码和超过6路；GUI各入口默认六路，CLI仍可指定单路',async t=>{
 const root=await temp(t);await fs.writeFile(path.join(root,'run.json'),'{}');assert.equal(options([]).captureWorkers,6);assert.equal(captureWorkers(),6);assert.equal(options(['--capture-workers','1']).captureWorkers,1);for(const n of [1,2,3,4,5,6])assert.equal(captureWorkers(String(n)),n);for(const v of [0,7,1.5,true,'bad'])assert.throws(()=>captureWorkers(v),/采图路数/);
 const page={};await assert.rejects(new CaptureCoordinator().run([{code:'1'}],[{page},{page}],async()=>{}),/同一页面/);await assert.rejects(new CaptureCoordinator().run([{code:'1'},{code:'1'}],[{page:{}}],async()=>{}),/重复代码/);
 const base={command:'start',source:'sina',sectors:['合成行业'],limit:1,captureSeconds:300,reviewSeconds:180,model:'gpt-6.1-terra',batchDirectory:root};for(const mode of ['normal','resume','review','capture']){assert.equal(options(await requestArgs({...base,mode},root)).captureWorkers,6);assert.equal(options(await requestArgs({...base,mode,captureWorkers:1},root)).captureWorkers,1);}await assert.rejects(requestArgs({...base,mode:'normal',captureWorkers:7},root),/采图路数/);await assert.rejects(new CaptureCoordinator().run([{code:'1'}],Array.from({length:7},()=>({page:{}})),async()=>{}),/独立浏览器/);
});

test('六路同时在途，乱序完成仍同页绑定代码，停机后不提交迟到图片',{timeout:15000},async t=>{
 const directory=await temp(t),firstSix=latch(),release=latch(),controller=new AbortController();let active=0,max=0,quotes=0,reviews=0;const seen=new Set();
 const make=()=>adapter({quoteHook:async i=>{assert(!seen.has(i.code));seen.add(i.code);quotes++;max=Math.max(max,++active);if(quotes===6)firstSix.resolve();await release.promise;},chartHook:async()=>{active--;}});
 const work=runScreening(cfg(10),{directory,browsers:Array.from({length:6},make),catalogLoader,memberLoader:members(10),signal:controller.signal,review:async r=>{reviews++;return payload(r);},log:()=>{}});
 await firstSix.promise;assert.equal(max,6);assert.equal(quotes,6);controller.abort(Object.assign(Error('合成六路停止'),{code:'USER_CANCELLED'}));release.resolve();const run=await work;assert.equal(run.status,'interrupted');assert.equal(run.pipeline.capture.workers,6);assert.equal(run.pipeline.capture.active,0);assert.equal(reviews,0);assert.equal(run.counts.newCharts,0);assert.equal(seen.size,6);
});

test('六路完成不同股票，审核与取图重叠，主图与报价和结果SHA不串股',{timeout:15000},async t=>{
 const directory=await temp(t),all=latch(),release=latch();let active=0,max=0,entered=0,overlap=false;const seen=[];
 const make=()=>adapter({quoteHook:async i=>{seen.push(i.code);max=Math.max(max,++active);if(++entered===6)all.resolve();await all.promise;await delay(Number(i.code.slice(-1))*4);},chartHook:async i=>{if(i.code==='300006')await release.promise;await delay(15);active--;}});
 const run=await runScreening({...cfg(10),reviewWorkers:12},{directory,browsers:Array.from({length:6},make),catalogLoader,memberLoader:members(10),review:async r=>{overlap ||= active>0;release.resolve();return payload(r);},log:()=>{}});
 assert.equal(max,6);assert.equal(overlap,true);assert.equal(new Set(seen).size,10);assert.equal(run.counts.passed,10);assert.equal(run.pipeline.capture.workers,6);assert.equal(run.pipeline.capture.active,0);for(const i of run.items){const bytes=await fs.readFile(path.join(directory,i.chartFile));assert.equal(bytes.toString(),'主图'+i.code);assert.equal(i.quoteSnapshot.code,i.code);assert.equal(createHash('sha256').update(bytes).digest('hex'),i.reviewImageSHA256);}
});
test('队列达到6只暂停新任务；审核失败后解除等待并保留继续采图行为',{timeout:5000},async()=>{
 let state={status:'running',queued:6},calls=0;const paused=latch(),c=new CaptureCoordinator({onBudgetState:value=>{if(value)paused.resolve();}}),queue={state:()=>state};
 const work=c.run([{code:'1'},{code:'2'}],[{page:{}},{page:{}}],async()=>{calls++;},{queue});await paused.promise;assert.equal(calls,0);assert(c.state().waitingForReview>0);state={status:'failed',queued:6,error:'合成模型额度不足'};c.wake();await work;assert.equal(calls,2);
});
test('两页人工验证串行处理，期间不分配股票，重叠人工等待只计一次',{timeout:5000},async()=>{
 let now=0,manual=0,max=0,captures=0;const first=latch(),second=latch(),release1=latch(),release2=latch(),c=new CaptureCoordinator({now:()=>now});
 const verify=async(start,release)=>{max=Math.max(max,++manual);start.resolve();await release.promise;manual--;};
 const a=c.verification(()=>verify(first,release1),1);await first.promise;now=10;const b=c.verification(()=>verify(second,release2),2);const work=c.run([{code:'1'},{code:'2'}],[{page:{}},{page:{}}],async()=>{captures++;});await delay(5);assert.equal(captures,0);now=30;release1.resolve();await second.promise;assert.equal(captures,0);now=50;release2.resolve();await Promise.all([a,b,work]);assert.equal(max,1);assert.equal(c.manualWaitMs,50);assert.equal(captures,2);
});
test('任一路致命错误后不分配新股票，等待另一在途任务结束再收尾',{timeout:5000},async()=>{
 const both=latch(),release=latch(),c=new CaptureCoordinator();let calls=0,settled=false;const work=c.run([{code:'1'},{code:'2'},{code:'3'}],[{page:{}},{page:{}}],async i=>{calls++;if(calls===2)both.resolve();await both.promise;if(i.code==='1')throw Error('合成源中断');await release.promise;}).finally(()=>settled=true);const rejected=assert.rejects(work,/合成源中断/);await both.promise;await delay(5);assert.equal(settled,false);assert.equal(calls,2);release.resolve();await rejected;assert.equal(calls,2);
});
test('双路正常筛股同页报价到主图不串股，审核与两路采图重叠，原图SHA逐只匹配',{timeout:10000},async t=>{
 const directory=await temp(t),sixStarted=latch(),releaseSix=latch();let active=0,max=0,overlap=false,reviews=0;const seen=[];const make=()=>adapter({quoteHook:async i=>{seen.push(i.code);max=Math.max(max,++active);if(i.code==='300006'){sixStarted.resolve();await releaseSix.promise;}await delay(15);},chartHook:async()=>{await delay(15);active--;}});
 const run=await runScreening(cfg(),{directory,browsers:[make(),make()],catalogLoader,memberLoader:members(8),review:async r=>{if(++reviews===1){await sixStarted.promise;overlap=active>0;releaseSix.resolve();}await delay(5);return payload(r);},log:()=>{}});
 assert.equal(max,2);assert.equal(overlap,true);assert.equal(new Set(seen).size,8);assert.equal(run.counts.passed,8);assert.equal(run.pipeline.capture.workers,2);assert.equal(run.visionBatches[0].codes.length,1);for(const i of run.items){const bytes=await fs.readFile(path.join(directory,i.chartFile));assert.equal(bytes.toString(),'主图'+i.code);assert.equal(createHash('sha256').update(bytes).digest('hex'),i.reviewImageSHA256);}
});
test('部分辅助图写入失败的主图不能被另一路抢先送审；补采仅重做缺项',{timeout:10000},async t=>{
 const root=await temp(t),source=path.join(root,'source');await fs.mkdir(source);const bad=adapter();bad.chart=async i=>({image:Buffer.from('主图'+i.code),chartInfo:{source:'eastmoney',readiness:{ready:true}},capturedAt:new Date().toISOString(),periodImages:[{image:null}]});let reviewed=[];
 const run=await runScreening(cfg(2),{directory:source,browsers:[bad,adapter()],catalogLoader,memberLoader:members(2),review:async r=>{reviewed.push(...reviewTargets(r).map(i=>i.code));return payload(r);},log:()=>{}});
 assert.deepEqual(reviewed,['300002']);assert.equal(run.items[0].captureReady,false);assert(run.items[0].chartFile);assert.equal(run.counts.passed,1);assert.equal(run.counts.pending,1);assert.equal(run.status,'completed_with_capture_gaps');const before=await fs.readFile(path.join(source,'run.json'),'utf8');
 const prepared=await prepareResume(options(['--resume',source,'--output-dir',root]));assert.deepEqual(prepared.seed.resumeCaptureCodes,['300001']);const completed=structuredClone(prepared.seed.items[1]),visited=[];const make=()=>adapter({quoteHook:async i=>visited.push(i.code)});const resumed=await runScreening(prepared.cfg,{...prepared,browsers:[make(),make()],review:async r=>payload(r),log:()=>{}});assert.deepEqual(visited,['300001']);assert.equal(resumed.counts.pending,0);assert.deepEqual(resumed.items[1],completed);assert.equal(await fs.readFile(path.join(source,'run.json'),'utf8'),before);
});
test('两页报价交易日不同立即停止，错误日期不会进入本批可用图证',{timeout:10000},async t=>{
 const directory=await temp(t),a=adapter(),b=adapter();b.stockQuote=async i=>{await delay(20);return{code:i.code,name:i.name,price:'12',open:'11',dateText:'2026-01-01',source:'eastmoney',image:Buffer.from('旧日报价')};};
 const run=await runScreening(cfg(2),{directory,browsers:[a,b],catalogLoader,memberLoader:members(2),review:async r=>payload(r),log:()=>{}});assert.equal(run.errorCode,'MARKET_DATE_CHANGED');assert.equal(run.quoteMarketDate,selectionDay());assert.equal(run.items[1].quoteSnapshot,undefined);assert.equal(run.items[1].chartFile,undefined);assert.equal(run.items[1].result.status,'待确认');
});
test('停止同时取消两路，迟到的截图不落盘、不送审',{timeout:10000},async t=>{
 const directory=await temp(t),controller=new AbortController(),both=latch(),release=latch();let charts=0,reviews=0;const make=()=>adapter({chartHook:async()=>{if(++charts===2)both.resolve();await release.promise;}});const work=runScreening(cfg(),{directory,browsers:[make(),make()],catalogLoader,memberLoader:members(8),signal:controller.signal,review:async r=>{reviews++;return payload(r);},log:()=>{}});await both.promise;controller.abort(Object.assign(Error('合成停止'),{code:'USER_CANCELLED'}));release.resolve();const run=await work;assert.equal(charts,2);assert.equal(reviews,0);assert.equal(run.counts.newCharts,0);assert.equal(run.counts.pending,8);assert.equal(run.status,'interrupted');
});

test('六路在途采图保存后暂停，暂停不分配新股或审核，继续同名单且不重复采图',{timeout:15000},async t=>{
 const directory=await temp(t),pause=new TaskPause(),six=latch(),release=latch(),paused=latch();let quotes=0,charts=0,reviews=0;const seen=[];pause.subscribe(s=>{if(s.status==='paused')paused.resolve();});
 const make=()=>adapter({quoteHook:async i=>{seen.push(i.code);if(++quotes===6)six.resolve();await release.promise;},chartHook:async()=>{charts++;}});
 const work=runScreening(cfg(10),{directory,browsers:Array.from({length:6},make),pause,catalogLoader,memberLoader:members(10),review:async r=>{reviews++;return payload(r);},log:()=>{}});
 await six.promise;pause.pause();release.resolve();await paused.promise;await delay(50);assert.equal(quotes,6);assert.equal(charts,6);assert.equal(reviews,0);const snapshot=JSON.parse(await fs.readFile(path.join(directory,'run.json')));assert.equal(snapshot.items.filter(i=>i.chartFile).length,6);assert.equal(snapshot.status,'running');
 pause.resume();const run=await work;assert.equal(run.status,'completed');assert.equal(run.counts.passed,10);assert.equal(quotes,10);assert.equal(charts,10);assert.equal(new Set(seen).size,10);assert(reviews>0);assert.equal(pause.active,0);assert(run.pauseSeconds>=.04);assert(run.activeSeconds<run.elapsedSeconds);
});

test('已暂停时停止会正常保存缺项，不需要先继续才能退出',{timeout:10000},async t=>{
 const directory=await temp(t),pause=new TaskPause(),controller=new AbortController();pause.pause();let quotes=0;
 const work=runScreening(cfg(),{directory,pause,signal:controller.signal,browser:adapter({quoteHook:async()=>quotes++}),catalogLoader,memberLoader:members(8),log:()=>{}});await delay(20);controller.abort(Object.assign(Error('暂停时停止'),{code:'USER_CANCELLED'}));const run=await work;assert.equal(run.status,'interrupted');assert.equal(quotes,0);assert.equal(pause.active,0);assert.equal(pause.waiters.size,0);
});
