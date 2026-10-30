// 队列/网页/模型均为软件夹具；桌面副本写入测试临时目录。
import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs/promises';import path from 'node:path';import os from 'node:os';import {createHash} from 'node:crypto';
import {runScreening,options,refreshResultCounts} from '../script/screen.mjs';import {reviewTargets,reviewInBatches} from '../script/vision.mjs';import {TENCENT_SOURCE} from '../script/tencent-history.mjs';import {selectionDay} from '../script/selected-sectors.mjs';import {LiveArchiveSession} from '../script/live-archive.mjs';import {recoverSavedBatch} from '../script/recover-batch.mjs';import {guiSnapshot} from '../script/gui-protocol.mjs';import {ActiveBudget,reviewStageWithBudget} from '../script/budget.mjs';
const deferred=()=>{let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});return{promise,resolve,reject};};
const sector={code:'pt01801081',kind:'industry',name:'合成行业',source:TENCENT_SOURCE},catalogLoader=async kind=>({kind,total:1,entries:[kind==='industry'?sector:{...sector,code:'pt02GN2442',kind,name:'合成概念'}]});
const cfg=()=>options(['--sectors','合成行业','--limit','8']);
const memberLoader=async s=>({sector:s.code,source:TENCENT_SOURCE,total:8,items:Array.from({length:8},(_,n)=>({code:String(300001+n),name:'合成'+n,market:'sz',url:'https://quote.eastmoney.com/sz'+(300001+n)+'.html',membershipSource:TENCENT_SOURCE,membershipSector:s.code}))});
const quote=async i=>({code:i.code,name:i.name,price:'12',open:'11',dateText:selectionDay(),image:Buffer.from('合成报价')});
const chart=async()=>({image:Buffer.from('合成15分钟图'),capturedAt:new Date().toISOString(),chartInfo:{selectedPeriod:'15分钟'}});
const payload=r=>({marketDate:selectionDay(),marketPhase:'合成测试',rankingEvidenceConfirmed:true,quoteEvidenceConfirmed:true,notes:'软件夹具',stocks:reviewTargets(r).map(i=>({code:i.code,identityConfirmed:true,period15mConfirmed:true,latestBarDate:selectionDay(),allMALabelsVisible:true,volumeComplete:true,chartPrice:12,ma5:12,ma10:12,ma20:11.8,ma60:11,shape:'pass',nearMA20:'pass',ma20Above60:'pass',redVolume:'pass',reason:'合成四项通过'}))});
async function temp(t){const p=await fs.mkdtemp(path.join(os.tmpdir(),'stock-pipeline-'));t.after(async()=>{assert.equal(path.dirname(p),path.resolve(os.tmpdir()));await fs.rm(p,{recursive:true,force:true});});return p;}
test('审核第1批阻塞时采图仍完成8只；不可变快照不会混入后续股票或覆盖新进度',{timeout:10000},async t=>{
 const directory=await temp(t),modelStarted=deferred(),release=deferred(),captureFinished=deferred();let captured=0,reviewScope;
 const work=runScreening(cfg(),{directory,catalogLoader,memberLoader,browser:{stockQuote:quote,chart:async()=>{captured++;return chart();}},onCaptureDone:()=>captureFinished.resolve(),review:async r=>{if(!reviewScope){reviewScope=r;modelStarted.resolve();await release.promise;}return payload(r);},log:()=>{}});
 try{await modelStarted.promise;const images=reviewScope.images.length;assert.equal(captured,1);while(captured<7)await new Promise(r=>setTimeout(r,5));assert.equal(captured,7);release.resolve();await captureFinished.promise;assert.equal(captured,8);assert.equal(reviewScope.images.length,images);assert.equal(reviewScope.items[1].chartFile,undefined);assert.equal(reviewTargets(reviewScope).length,1);}finally{release.resolve();}
 const run=await work;assert.equal(run.status,'completed');assert.equal(run.counts.passed,8);assert.equal(run.counts.visualReviewed,8);assert.deepEqual(run.visionBatches.map(b=>b.codes.length),[1,3,3,1]);assert.equal(run.pipeline.capture.status,'completed');assert.equal(run.pipeline.review.status,'completed');assert.equal(guiSnapshot(run,directory).matches.length,8);
});
test('审核失败不打断后续采图，不自动重试模型；失败图片保留待审核',async t=>{
 const directory=await temp(t);let captures=0,reviews=0;const run=await runScreening(cfg(),{directory,catalogLoader,memberLoader,browser:{stockQuote:quote,chart:async()=>{captures++;return chart();}},review:async()=>{reviews++;throw Error('合成API认证失败');},log:()=>{}});
 assert.equal(captures,8);assert.equal(reviews,1);assert.equal(run.pipeline.capture.status,'completed');assert.equal(run.pipeline.review.status,'failed');assert.equal(run.status,'failed');assert.equal(run.counts.newCharts,8);assert.equal(run.counts.passed,0);assert.equal(run.counts.pending,8);assert.match(run.error,/API认证失败/);
});

test('仅采图途中停止保持审核禁用，不启动审核计时或等待定时器',async t=>{
 const directory=await temp(t),controller=new AbortController(),selected=options(['--sectors','合成行业','--limit','8','--capture-only']);let quotes=0;
 const run=await runScreening(selected,{directory,catalogLoader,memberLoader,signal:controller.signal,browser:{stockQuote:async i=>{if(++quotes===2){controller.abort(Object.assign(Error('合成停止'),{code:'USER_CANCELLED'}));throw controller.signal.reason;}return quote(i);},chart},review:()=>{throw Error('仅采图不可调用模型');},log:()=>{}});
 assert.equal(run.status,'interrupted');assert.equal(run.counts.newCharts,1);assert.equal(run.pipeline.review.status,'disabled');assert.equal(run.visionBatches.length,0);
});

test('所选图证模式传到采图适配器，首张审核时下一只仍可继续采图',async t=>{
 const directory=await temp(t),selected=options(['--sectors','合成行业','--limit','8','--evidence-mode','main-only']);let captures=0;
 const run=await runScreening(selected,{directory,catalogLoader,memberLoader,browser:{stockQuote:quote,chart:async(_item,settings)=>{assert.equal(settings.evidenceMode,'main-only');captures++;return chart();}},review:async r=>payload(r),log:()=>{}});
 assert.equal(captures,8);assert.equal(run.visionBatches[0].codes.length,1);assert(run.visionBatches.every(b=>b.codes.length<=3));assert.equal(run.counts.passed,8);
});
test('人工停止同时取消采图与审核，忽略迟到的模型返回，不产生虚假符合',async t=>{
 const directory=await temp(t),root=new AbortController(),started=deferred();let quotes=0;
 const run=await runScreening(cfg(),{directory,catalogLoader,memberLoader,signal:root.signal,reviewSignal:root.signal,browser:{stockQuote:async i=>{if(++quotes===6){await started.promise;root.abort(Object.assign(Error('合成人工停止'),{code:'USER_CANCELLED'}));throw root.signal.reason;}return quote(i);},chart},review:async r=>{started.resolve();await new Promise(resolve=>{root.signal.addEventListener('abort',resolve,{once:true});if(root.signal.aborted)resolve();});return payload(r);},log:()=>{}});
 assert.equal(run.status,'interrupted');assert.equal(run.counts.passed,0);assert.equal(run.counts.visualReviewed,0);assert.equal(run.counts.newCharts,5);assert.equal(run.counts.pending,8);assert.equal(guiSnapshot(run,directory).matches.length,0);
});
test('并行期间两项预算同时累计，审核不暂停采图计时；空队列不消耗审核预算',async()=>{
 let now=0;const timers=[],clock={now:()=>now,schedule:(fn,ms)=>{const t={fn,ms};timers.push(t);return t;},cancel:()=>{}};
 const capture=new ActiveBudget(1000,()=>{},clock),review=new ActiveBudget(1000,()=>{},clock);review.pause();now=200;assert.equal(review.remaining,1000);
 await reviewStageWithBudget(async()=>{assert.notEqual(capture.started,null);now=500;},{screenBudget:capture,reviewBudget:review,concurrent:true});capture.pause();assert.equal(capture.remaining,500);assert.equal(review.remaining,700);now=900;assert.equal(review.remaining,700);capture.dispose();review.dispose();
});
async function archiveFixture(t){const root=await temp(t),source=path.join(root,'source'),desktop=path.join(root,'desktop');await fs.mkdir(source);await fs.mkdir(desktop);const image=Buffer.from('合成图证，不是实时行情'),hash=createHash('sha256').update(image).digest('hex');const items=[1,2].map(n=>({code:String(300000+n),name:'合成'+n,marketSource:'eastmoney',price:'12',open:'11',chartFile:(300000+n)+'-15分钟.png',imageSHA256:hash,capturedAt:new Date().toISOString(),result:{status:n===1?'符合':'待确认',reason:n===1?'原已完成四项':'等待审核'},...(n===1?{review:{},reviewImageSHA256:hash,chartVisualConfirmed:true}:{})}));for(const item of items)await fs.writeFile(path.join(source,item.chartFile),image);const run={id:'archive-fixture',kind:'standalone-visual-script',startedAt:new Date().toISOString(),status:'running',items,images:items.map(i=>({file:i.chartFile,label:'合成图证'})),events:[],sectors:[sector]};refreshResultCounts(run);await fs.writeFile(path.join(source,'run.json'),JSON.stringify(run));return{root,source,desktop,run};}
test('运行中增量归档复用同一任务目录，最终根目录只有CSV、符合主图和其他；分类随判定更新',async t=>{
 const {source,desktop,run}=await archiveFixture(t),session=new LiveArchiveSession(source,{}, {desktopDir:desktop,log:()=>{}});const first=await session.flush(run),dir=first.directory;assert.equal(first.status,'writing');assert.deepEqual((await fs.readdir(dir)).sort(),['其他','合成1.png','结果.csv'].sort());assert(await fs.stat(path.join(dir,'其他','待审核','300002_合成2','判定说明.txt')));
 Object.assign(run.items[1],{result:{status:'符合',reason:'审核完成'},review:{},reviewImageSHA256:run.items[1].imageSHA256,chartVisualConfirmed:true});run.status='completed';run.finishedAt=new Date().toISOString();refreshResultCounts(run);const last=await session.flush(run);assert.equal(last.directory,dir);assert.equal(last.status,'completed');assert.deepEqual((await fs.readdir(dir)).sort(),['其他','合成1.png','合成2.png','结果.csv'].sort());assert.equal(await fs.access(path.join(dir,'其他','待审核','300002_合成2')).then(()=>true,()=>false),false);assert(await fs.stat(path.join(dir,'其他','符合','300002_合成2','判定说明.txt')));
 const manifest=JSON.parse(await fs.readFile(path.join(dir,'其他','归档清单.json')));assert.equal(manifest.counts['符合'],2);for(const f of manifest.files){const bytes=await fs.readFile(path.join(dir,f.file));assert.equal(createHash('sha256').update(bytes).digest('hex'),f.sha256,f.file);}assert.equal((await fs.readdir(path.dirname(dir))).length,1);
});
test('增量归档保留用户重新保存的CSV，最新生成版本另存其他；旧任务和同名任务均不覆盖',async t=>{
 const {source,desktop,run}=await archiveFixture(t),session=new LiveArchiveSession(source,{'task-name':'同名任务'},{desktopDir:desktop,log:()=>{}}),first=await session.flush(run);await fs.writeFile(path.join(first.directory,'结果.csv'),'用户重新保存的CSV');run.status='interrupted';const final=await session.flush(run);assert.equal(await fs.readFile(path.join(final.directory,'结果.csv'),'utf8'),'用户重新保存的CSV');assert((await fs.readFile(path.join(final.directory,'其他','原始记录','结果_最新生成.csv'),'utf8')).includes('300001'));assert.equal(final.status,'partial');await session.flush(run);assert.equal(await fs.readFile(path.join(final.directory,'结果.csv'),'utf8'),'用户重新保存的CSV');
 const secondSource=path.join(path.dirname(source),'another');await fs.mkdir(secondSource);for(const image of run.images)await fs.copyFile(path.join(source,image.file),path.join(secondSource,image.file));const other=new LiveArchiveSession(secondSource,{'task-name':'同名任务'},{desktopDir:desktop,log:()=>{}});const next=await other.flush({...run,id:'another'});assert.notEqual(next.directory,final.directory);assert.equal(await fs.readFile(path.join(final.directory,'结果.csv'),'utf8'),'用户重新保存的CSV');
});

test('增量归档经目录别名恢复仍复用原目录，不把长短路径差异当成越界',{skip:process.platform!=='win32'},async t=>{
 const {root,source,desktop,run}=await archiveFixture(t),alias=path.join(root,'桌面别名');await fs.symlink(desktop,alias,'junction');const first=await new LiveArchiveSession(source,{}, {desktopDir:alias,log:()=>{}}).flush(run);assert.equal(first.status,'writing');run.status='interrupted';const resumed=await new LiveArchiveSession(source,{}, {desktopDir:alias,log:()=>{}}).flush(run);assert.equal(resumed.status,'completed');assert.equal(resumed.directory,first.directory);assert.deepEqual(await fs.readFile(path.join(first.directory,'合成1.png')),await fs.readFile(path.join(source,run.items[0].chartFile)));
});
test('意外退出130仅恢复已保存快照到桌面，不改原始run、不重采、不调用模型',async t=>{
 const {source,desktop}=await archiveFixture(t),original=await fs.readFile(path.join(source,'run.json'),'utf8');const result=await recoverSavedBatch(source,{exitCode:130,desktopDir:desktop});assert.equal(result.status,'completed');assert.equal(result.snapshot.passed,1);assert.equal(result.snapshot.pending,1);assert.equal(result.snapshot.status,'interrupted');assert.equal(await fs.readFile(path.join(source,'run.json'),'utf8'),original);assert.deepEqual((await fs.readdir(result.archiveDirectory)).sort(),['其他','合成1.png','结果.csv'].sort());const again=await recoverSavedBatch(source,{exitCode:130,desktopDir:desktop});assert.equal(again.archiveDirectory,result.archiveDirectory);
});
test('审核期间任一股票图证身份改变则整批不合并，不留下部分符合',async t=>{
 const {source,run}=await archiveFixture(t);for(const item of run.items){delete item.review;delete item.reviewImageSHA256;item.result={status:'待确认',reason:'合成待审核'};}
 await assert.rejects(reviewInBatches(run,source,{review:async snapshot=>{run.items[1].imageSHA256='changed-during-review';return payload(snapshot);}}),/原图身份发生变化/);assert(run.items.every(i=>i.result.status==='待确认'&&!i.review));
});
test('分类文件夹已移动但清单未写完的意外退出，可按原快照恢复归档',async t=>{
 const {source,desktop,run}=await archiveFixture(t),session=new LiveArchiveSession(source,{}, {desktopDir:desktop,log:()=>{}}),receipt=await session.flush(run),from=path.join(receipt.directory,'其他','待审核','300002_合成2'),to=path.join(receipt.directory,'其他','符合','300002_合成2');
 await fs.mkdir(path.dirname(to),{recursive:true});await fs.rename(from,to);Object.assign(run.items[1],{result:{status:'符合',reason:'新判定已落盘'},review:{},reviewImageSHA256:run.items[1].imageSHA256,chartVisualConfirmed:true});await fs.writeFile(path.join(source,'run.json'),JSON.stringify(run));
 const restored=await recoverSavedBatch(source,{exitCode:130,desktopDir:desktop});assert.equal(restored.status,'completed');assert.equal(restored.archiveDirectory,receipt.directory);assert.equal(restored.snapshot.passed,2);assert(await fs.stat(path.join(restored.archiveDirectory,'合成2.png')));assert(await fs.stat(path.join(to,'判定说明.txt')));
});
