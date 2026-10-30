// 正式队列的并发、落盘、取消和断点软件验收；不访问行情或付费模型。
import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs/promises';import path from 'node:path';import os from 'node:os';
import {runScreening,reviewSavedBatch,prepareResume,options} from '../script/screen.mjs';import {reviewTargets,reviewDirectory} from '../script/vision.mjs';import {requestArgs} from '../script/gui-protocol.mjs';import {ActiveBudget,reviewStageWithBudget,reviewTimes} from '../script/budget.mjs';import {TENCENT_SOURCE} from '../script/tencent-history.mjs';import {selectionDay} from '../script/selected-sectors.mjs';
import {TaskPause} from '../script/task-pause.mjs';
const latch=()=>{let resolve;const promise=new Promise(r=>resolve=r);return{promise,resolve};},sleep=ms=>new Promise(r=>setTimeout(r,ms));
const sector={code:'pt01801081',name:'合成行业',kind:'industry',source:TENCENT_SOURCE};
const cfg=(workers=3)=>options(['--sectors','合成行业','--source','sina','--limit','10','--review-workers',String(workers),'--evidence-mode','main-only']);
async function temp(t){const dir=await fs.mkdtemp(path.join(os.tmpdir(),'stock-review-workers-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));return dir;}
const catalogLoader=async kind=>({kind,total:1,entries:[kind==='industry'?sector:{...sector,kind,code:'pt02GN2442',name:'合成概念'}]});
const memberLoader=async()=>({sector:sector.code,source:TENCENT_SOURCE,total:10,items:Array.from({length:10},(_,n)=>({code:String(300001+n),name:'合成'+n,market:'sz',url:'https://quote.eastmoney.com/sz'+(300001+n)+'.html',membershipSource:TENCENT_SOURCE,membershipSector:sector.code}))});
const browser=()=>({stockQuote:async i=>({code:i.code,name:i.name,price:'12',open:'11',dateText:selectionDay(),source:'sina',image:Buffer.from('报价'+i.code)}),chart:async i=>({image:Buffer.from('主图'+i.code),chartInfo:{source:'sina',readiness:{ready:true}},capturedAt:new Date().toISOString()})});
const payload=r=>({marketDate:selectionDay(),marketPhase:'合成测试',rankingEvidenceConfirmed:true,quoteEvidenceConfirmed:true,notes:'软件测试',stocks:reviewTargets(r).map(i=>({code:i.code,identityConfirmed:true,period15mConfirmed:true,latestBarDate:selectionDay(),allMALabelsVisible:true,volumeComplete:true,chartPrice:12,ma5:12,ma10:12,ma20:11.8,ma60:11,shape:'pass',nearMA20:'pass',ma20Above60:'pass',redVolume:'pass',reason:'软件测试'}))});

test('窗口和CLI在正常、继续及原图审核传递下拉各档位，非法值不启动',async t=>{
 const dir=await temp(t);await fs.writeFile(path.join(dir,'run.json'),'{}');const base={command:'start',source:'sina',model:'gpt-6.1-sol',sectors:['合成行业'],limit:1,captureSeconds:300,reviewSeconds:180,batchDirectory:dir};assert.equal(options([]).reviewWorkers,1);
 for(const workers of [1,2,3,4,6,8,10,12,16,24,32])for(const mode of ['normal','resume','review'])assert.equal(options(await requestArgs({...base,mode,reviewWorkers:workers},dir)).reviewWorkers,workers);
 for(const value of [0,33,true,1.5])await assert.rejects(requestArgs({...base,mode:'normal',reviewWorkers:value},dir),/审核路数/);assert.throws(()=>options(['--review-workers','33']),/审核路数/);
});

test('三路乱序完成仍有唯一批号和目录，逐股结果与快照不相互覆盖',{timeout:15000},async t=>{
 const dir=await temp(t),all=latch();let calls=0,active=0,max=0;const directories=new Set();
 const run=await runScreening(cfg(),{directory:dir,catalogLoader,memberLoader,browser:browser(),log:()=>{},review:async(r,d,o)=>{max=Math.max(max,++active);if(++calls===3)all.resolve();await all.promise;await sleep(o.batchIndex===1?80:10);const out=reviewDirectory(d,o);assert(!directories.has(out));directories.add(out);await fs.mkdir(out,{recursive:true});await fs.writeFile(path.join(out,'合成模型.json'),JSON.stringify(payload(r)));active--;return payload(r);}});
 assert.equal(max,3);assert.equal(run.counts.passed,10);assert.equal(run.status,'completed');assert.equal(run.pipeline.review.workers,3);assert.equal(run.pipeline.review.activeWorkers,0);assert.equal(directories.size,4);assert.deepEqual(run.visionBatches.map(b=>b.batchIndex),[1,2,3,4]);const saved=JSON.parse(await fs.readFile(path.join(dir,'run.json')));assert.equal(saved.counts.passed,10);assert(saved.items.every(i=>i.reviewImageSHA256===i.imageSHA256&&i.reviewEngine.contextConfirmed));
});

test('多路模型失败保留其他成功项，后续仅补缺项且不重新采图',{timeout:15000},async t=>{
 const dir=await temp(t),all=latch();let calls=0;const run=await runScreening(cfg(),{directory:dir,catalogLoader,memberLoader,browser:browser(),log:()=>{},review:async(r,_d,o)=>{if(++calls===3)all.resolve();await all.promise;if(o.batchIndex===2)throw Error('合成额度错误');await sleep(15);return payload(r);}});
 assert.equal(calls,3);assert.equal(run.counts.passed,4);assert.equal(run.counts.pending,6);assert.equal(run.counts.newCharts,10);const original=await fs.readFile(path.join(dir,'run.json'),'utf8'),kept=run.items.filter(i=>i.result.status==='符合');const resumed=await prepareResume(options(['--resume',dir,'--output-dir',path.join(dir,'out'),'--review-workers','2','--evidence-mode','main-only']));assert.equal(resumed.cfg.reviewWorkers,2);assert.equal(resumed.seed.resumeCaptureCodes.length,0);
 const done=await runScreening(resumed.cfg,{...resumed,browser:{stockQuote:()=>{throw Error('不可补采');}},review:async r=>payload(r),log:()=>{}});assert.equal(done.counts.passed,10);for(const item of kept)assert.deepEqual(done.items.find(i=>i.code===item.code),item);assert.equal(await fs.readFile(path.join(dir,'run.json'),'utf8'),original);
});

test('三路停止后迟到模型结果不写入符合，所有在途调用收尾',{timeout:15000},async t=>{
 const dir=await temp(t),all=latch(),release=latch(),controller=new AbortController();let calls=0;
 const work=runScreening(cfg(),{directory:dir,catalogLoader,memberLoader,browser:browser(),signal:controller.signal,reviewSignal:controller.signal,log:()=>{},review:async r=>{if(++calls===3)all.resolve();await release.promise;return payload(r);}});await all.promise;controller.abort(Object.assign(Error('合成停止'),{code:'USER_CANCELLED'}));release.resolve();const run=await work;assert.equal(calls,3);assert.equal(run.counts.passed,0);assert.equal(run.counts.visualReviewed,0);assert.equal(run.pipeline.review.activeWorkers,0);assert.equal(run.status,'interrupted');
});

test('原图复核三路真实进入队列，源记录不改，最多3只一批',{timeout:15000},async t=>{
 const dir=await temp(t);await runScreening(cfg(1),{directory:dir,catalogLoader,memberLoader,browser:browser(),review:async r=>payload(r),log:()=>{}});const original=await fs.readFile(path.join(dir,'run.json'),'utf8');let active=0,max=0,calls=0;const all=latch();
 const {run}=await reviewSavedBatch(options(['--review-only',dir,'--review-workers','3','--output-dir',path.join(dir,'out'),'--evidence-mode','main-only']),{log:()=>{},review:async r=>{max=Math.max(max,++active);if(++calls===3)all.resolve();await all.promise;assert(reviewTargets(r).length<=3);await sleep(5);active--;return payload(r);}});assert.equal(max,3);assert.equal(run.counts.passed,10);assert.equal(run.status,'completed');assert.equal(await fs.readFile(path.join(dir,'run.json'),'utf8'),original);
});

test('多路补证独立占有批号，补证结果不覆盖其他主图判定',{timeout:15000},async t=>{
 const dir=await temp(t),selected={...cfg(),evidenceMode:'main-auto'};const run=await runScreening(selected,{directory:dir,catalogLoader,memberLoader,browser:browser(),log:()=>{},review:async r=>{await sleep(5);const result=payload(r);if(r.singleChartOnly&&reviewTargets(r).some(i=>i.code==='300001'))result.quoteEvidenceConfirmed=false;return result;}});assert.equal(run.counts.passed,10);assert.equal(run.supplementAttempts.length,1);assert.equal(run.supplementAttempts[0].status,'completed');assert.equal(new Set(run.visionBatches.map(b=>b.batchIndex)).size,run.visionBatches.length);assert(run.visionBatches.some(b=>b.reviewPhase==='补充图证'));
});

test('其他路已经模型失败时，在途主图可保存但不再新增补证请求',{timeout:15000},async t=>{
 const dir=await temp(t),all=latch();let calls=0;const selected={...cfg(),evidenceMode:'main-auto'};
 const run=await runScreening(selected,{directory:dir,catalogLoader,memberLoader,browser:browser(),log:()=>{},review:async(r,_d,o)=>{if(++calls===3)all.resolve();await all.promise;if(o.batchIndex===2)throw Error('合成额度错误');await sleep(20);const answer=payload(r);if(reviewTargets(r).some(i=>i.code==='300001'))answer.quoteEvidenceConfirmed=false;return answer;}});
 assert.equal(calls,3);assert.equal(run.counts.passed,3);assert.equal(run.counts.pending,7);assert.equal(run.supplementAttempts[0].status,'failed');assert.match(run.error,/额度错误/);
});

test('重叠审核预算在最后一路结束才暂停，报告重叠时间不重复累计',async()=>{
 let now=0;const clock={now:()=>now,schedule:()=>1,cancel:()=>{}},budget=new ActiveBudget(1000,()=>{},clock);budget.pause();const a=latch(),b=latch();now=100;const first=reviewStageWithBudget(()=>a.promise,{reviewBudget:budget,concurrent:true});now=200;const second=reviewStageWithBudget(()=>b.promise,{reviewBudget:budget,concurrent:true});now=400;a.resolve();await first;assert.equal(budget.started,100);now=500;b.resolve();await second;assert.equal(budget.remaining,600);assert.equal(budget.started,null);
 const at=Date.parse('2026-10-28T00:00:00Z');assert.deepEqual(reviewTimes([{stage:'视觉复核第1批',startedAt:new Date(at).toISOString(),elapsedMs:200},{stage:'视觉复核第2批',startedAt:new Date(at+100).toISOString(),elapsedMs:300}]),{seconds:.4,workSeconds:.5});budget.dispose();
});

test('仅复核原图两路在途保存后暂停，尾队列不提前完成，继续不重评已完成项',{timeout:15000},async t=>{
 const dir=await temp(t);await runScreening(cfg(1),{directory:dir,catalogLoader,memberLoader,browser:browser(),review:async r=>payload(r),log:()=>{}});const original=await fs.readFile(path.join(dir,'run.json'),'utf8'),pause=new TaskPause(),started=latch(),release=latch(),paused=latch(),seen=[];let calls=0,finished=false;pause.subscribe(s=>{if(s.status==='paused')paused.resolve();});
 const work=reviewSavedBatch(options(['--review-only',dir,'--review-workers','2','--output-dir',path.join(dir,'out'),'--evidence-mode','main-only']),{pause,log:()=>{},review:async r=>{seen.push(...reviewTargets(r).map(i=>i.code));if(++calls===2)started.resolve();await release.promise;return payload(r);}}).then(r=>{finished=true;return r;});
 await started.promise;pause.pause();release.resolve();await paused.promise;await sleep(50);assert.equal(calls,2);assert.equal(finished,false);assert.equal(seen.length,4);pause.resume();const result=await work;assert.equal(result.run.status,'completed');assert.equal(result.run.counts.passed,10);assert.equal(seen.length,10);assert.equal(new Set(seen).size,10);assert.equal(await fs.readFile(path.join(dir,'run.json'),'utf8'),original);
});

test('主图返回后请求暂停，必要补证等待继续，不因暂停重发主图',{timeout:15000},async t=>{
 const dir=await temp(t),pause=new TaskPause(),paused=latch();let calls=0,mainForFirst=0,supplementForFirst=0;pause.subscribe(s=>{if(s.status==='paused')paused.resolve();});
 const work=runScreening({...cfg(1),evidenceMode:'main-auto'},{directory:dir,pause,catalogLoader,memberLoader,browser:browser(),log:()=>{},review:async r=>{calls++;const result=payload(r);if(reviewTargets(r).some(i=>i.code==='300001')){if(r.singleChartOnly){mainForFirst++;result.quoteEvidenceConfirmed=false;pause.pause();}else supplementForFirst++;}return result;}});
 await paused.promise;await sleep(40);assert.equal(calls,1);assert.equal(mainForFirst,1);assert.equal(supplementForFirst,0);pause.resume();const run=await work;assert.equal(run.status,'completed');assert.equal(run.counts.passed,10);assert.equal(mainForFirst,1);assert.equal(supplementForFirst,1);assert.equal(run.supplementAttempts[0].status,'completed');
});
