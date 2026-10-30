// 合成目录、成分、页面和视觉应答；不作为真实选股成绩。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {main,options,runScreening,prepareResume} from '../script/screen.mjs';
import {outcomeMessage} from '../script/screen.mjs';
import {selectionEntries,selectionDay,readSelection,resolveSectors,collectSelectedMembers,selectedMembershipConfirmed} from '../script/selected-sectors.mjs';
import {TENCENT_SOURCE} from '../script/tencent-history.mjs';
import {reviewTargets,makePrompt,applyReviews} from '../script/vision.mjs';
const date='2026-10-23',image=Buffer.from('软件合成图像，不是真实行情');
const sectors=[{code:'pt01800001',name:'合成行业',kind:'industry',source:TENCENT_SOURCE},{code:'pt02GN0001',name:'合成概念',kind:'concept',source:TENCENT_SOURCE}];
const catalogLoader=async kind=>({kind,total:1,entries:sectors.filter(s=>s.kind===kind)});
const member=(n,s)=>({code:String(300000+n),name:'合成'+n,market:'sz',url:`https://quote.eastmoney.com/sz${300000+n}.html`,membershipSource:TENCENT_SOURCE,membershipSector:s.code,price:'9999',open:'0'});
const members=async(s,{limit})=>({source:TENCENT_SOURCE,sector:s.code,total:20,items:(s.kind==='industry'?[1,2,3]:[2,3,4]).slice(0,limit).map(n=>member(n,s))});
const quote=i=>({code:i.code,name:i.name,price:'12',open:'11',dateText:date+' 15:00',image});
const chart=()=>({image,chartInfo:{selectedPeriod:'15分钟',readiness:{ready:true}},capturedAt:new Date().toISOString()});
const response=r=>({marketDate:date,marketPhase:'合成收盘',rankingEvidenceConfirmed:false,quoteEvidenceConfirmed:true,notes:'合成软件测试',stocks:reviewTargets(r).map(i=>({code:i.code,identityConfirmed:true,period15mConfirmed:true,latestBarDate:date,allMALabelsVisible:true,volumeComplete:true,chartPrice:12,ma5:12,ma10:12,ma20:11.8,ma60:11,shape:'fail',nearMA20:'not_checked',ma20Above60:'not_checked',redVolume:'not_checked',reason:'合成厂字形不通过'}))});
const cfg=()=>options(['--sectors','合成行业,合成概念','--limit','3']);
async function temp(t){const dir=await fs.mkdtemp(path.join(os.tmpdir(),'specified-sectors-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));return dir;}

test('旧rank命令立即拒绝，默认空名单不启动浏览器；独立排名须显式请求',async t=>{
 assert.throws(()=>options(['--rank','1','--limit','10']),/不再用--rank/);assert.throws(()=>options(['--lookback','15']),/不再用--rank/);
 assert.equal(options(['--rankings-only','--rank','1','--lookback','15']).lookback,15);
 assert.throws(()=>options(['--resume','old','--sectors','合成行业']),/沿用原板块/);
 const dir=await temp(t),file=path.join(dir,'empty.json');await fs.writeFile(file,JSON.stringify({date:selectionDay(),sectors:[]}));
 await assert.rejects(main(['--sectors-file',file]),/尚未指定板块/);assert.deepEqual(await fs.readdir(dir),['empty.json']);
});
test('当天名单、代码及名称精确核对，同名提示代码，禁止旧日期名单和跨源代换',async t=>{
 const dir=await temp(t),file=path.join(dir,'list.json');await fs.writeFile(file,'\ufeff'+JSON.stringify({date:selectionDay(),sectors:[{code:sectors[0].code,name:sectors[0].name},'合成概念']}));
 const selection=await readSelection(options(['--sectors-file',file]));const r=await resolveSectors(selection,{catalogLoader});assert.equal(r.sectors.length,2);
 await fs.writeFile(file,JSON.stringify({date:'2026-01-01',sectors:['合成行业']}));await assert.rejects(readSelection(options(['--sectors-file',file])),/每天午盘重新确认/);
 assert.throws(()=>selectionEntries([{code:'BK1408'}]),/腾讯行业/);await assert.rejects(resolveSectors({entries:[{code:sectors[0].code,name:'错误名'}]},{catalogLoader}),/未精确匹配/);
 const duplicate=async kind=>({kind,total:1,entries:[{...sectors[kind==='industry'?0:1],name:'同名'}]});await assert.rejects(resolveSectors({entries:[{name:'同名'}]},{catalogLoader:duplicate}),/不唯一.*pt01800001.*pt02GN0001/);
 const dedup=await resolveSectors({entries:selectionEntries(['合成行业',sectors[0].code])},{catalogLoader});assert.equal(dedup.sectors.length,1);
});
test('两板块前N条先去重，保留全部板块归属及总数，不带出接口报价，冲突名称拒绝合并',async()=>{
 const proof=await collectSelectedMembers(sectors,{limit:3,memberLoader:members});assert.equal(proof.totalMembershipRows,40);assert.equal(proof.selectedMembershipRows,6);assert.equal(proof.items.length,4);assert.equal(proof.items.find(i=>i.code==='300002').memberships.length,2);assert(proof.items.every(i=>i.price===undefined&&i.open===undefined));
 const conflict=async(s,o)=>{const p=await members(s,o);if(s.kind==='concept')p.items[0].name='错误名称';return p;};await assert.rejects(collectSelectedMembers(sectors,{limit:3,memberLoader:conflict}),/名称.*冲突/);
});
test('多板块直接筛股不调用任何历史与自动排名，重复股票只报价和采图一次；报告分板块列数',async t=>{
 const directory=await temp(t),quotes=[],charts=[],logs=[];
 const run=await runScreening(cfg(),{directory,catalogLoader,memberLoader:members,historyProvider:{collect:async()=>{throw Error('绝不能计算历史');}},historyStage:()=>{throw Error('绝不能进入历史阶段');},browser:{ranking:()=>{throw Error('绝不能选榜首');},stockQuote:async i=>{quotes.push(i.code);return quote(i);},chart:async i=>{charts.push(i.code);return chart();}},review:async r=>{assert.match(makePrompt(r),/不对板块强弱做判断/);assert.doesNotMatch(makePrompt(r),/合并第null强/);return response(r);},log:message=>logs.push(message)});
 assert.equal(run.status,'completed');assert.equal(run.contextConfirmed,true);assert.equal(run.counts.eliminated,4);assert.deepEqual(quotes,['300001','300002','300003','300004']);assert.deepEqual(charts,quotes);assert.equal(selectedMembershipConfirmed(run),true);assert(logs.every(s=>!s.includes('历史指数')));
 const text=await fs.readFile(path.join(directory,'结果.md'),'utf8');assert.match(text,/按板块累计成分40条/);assert.match(text,/纳入6条，去重后4只/);assert.match(text,/名单外成分未检查/);assert.match(text,/合成行业、合成概念/);
 run.items[1].memberships[0].code='pt01899999';applyReviews(run,response(run));assert.equal(run.contextConfirmed,false);assert.equal(run.items[0].result.status,'待确认');
});
test('成分预览不打开个股页面、不采图、不调用模型',async t=>{
 const run=await runScreening({...cfg(),'members-only':true},{directory:await temp(t),catalogLoader,memberLoader:members,browser:new Proxy({},{get(_target,key){if(key==='manualWaitMs')return 0;throw Error('不得访问浏览器');}}),review:()=>{throw Error('不得调用模型');},log:()=>{}});assert.equal(run.status,'members_only');assert.equal(run.counts.newCharts,0);assert.equal(run.items.length,4);
});
test('采集中断后保留有效未复核原图，只继续缺项；不重新查询目录或成分',async t=>{
 const root=await temp(t),source=path.join(root,'original');await fs.mkdir(source);const abort=new AbortController();let count=0;
 const original=await runScreening(cfg(),{directory:source,catalogLoader,memberLoader:members,browser:{stockQuote:async i=>{if(++count===2){abort.abort(Error('合成停止'));throw abort.signal.reason;}return quote(i);},chart},signal:abort.signal,review:()=>{throw Error('中断时不能复核');},log:()=>{}});
 assert.equal(original.status,'interrupted');assert.equal(original.counts.newCharts,1);const saved=await fs.readFile(path.join(source,'run.json'),'utf8');
 const prepared=await prepareResume(options(['--resume',source,'--output-dir',root]));assert.deepEqual(prepared.seed.resumeReviewFromSavedCodes,['300001']);assert.deepEqual(prepared.seed.resumeCaptureCodes,['300002','300003','300004']);
 const visited=[],order=[];const run=await runScreening(prepared.cfg,{...prepared,catalogLoader:()=>{throw Error('不许再读目录');},memberLoader:()=>{throw Error('不许再读成分');},browser:{stockQuote:async i=>{order.push('quote:'+i.code);visited.push(i.code);return quote(i);},chart},review:async r=>{order.push('review:'+reviewTargets(r).map(i=>i.code).join(','));return response(r);},log:()=>{}});
 assert.equal(order[0],'review:300001');assert.equal(order[1],'quote:300002');
 assert.equal(run.status,'completed');assert.deepEqual(visited,['300002','300003','300004']);assert.equal(run.counts.newCharts,3);assert.equal(run.counts.retainedCharts,1);assert.equal(run.counts.pending,0);assert.equal(await fs.readFile(path.join(source,'run.json'),'utf8'),saved);
});
test('超过10张分批复核，后一批失败保留前批完成项；断点继续仅复核已保存缺项图',async t=>{
 const root=await temp(t),directory=path.join(root,'source');await fs.mkdir(directory);
 const many=async(s,{limit})=>({source:TENCENT_SOURCE,sector:s.code,total:6,items:Array.from({length:Math.min(6,limit)},(_,n)=>member(n+1+(s.kind==='concept'?6:0),s))});let calls=0;const groups=[];
 const run=await runScreening(options(['--sectors','合成行业,合成概念','--limit','6']),{directory,catalogLoader,memberLoader:many,browser:{stockQuote:async i=>quote(i),chart},review:async r=>{groups.push(reviewTargets(r).map(i=>i.code));if(++calls===3)throw Error('合成第三批故障');return response(r);},log:()=>{}});
 assert.deepEqual(groups.map(g=>g.length),[1,3,3]);assert.equal(run.counts.eliminated,4);assert.equal(run.counts.pending,8);
 const prepared=await prepareResume(options(['--resume',directory,'--output-dir',root]));assert.deepEqual(prepared.seed.resumeCaptureCodes,[]);assert.equal(prepared.seed.resumeReviewFromSavedCodes.length,8);
 const resumed=await runScreening(prepared.cfg,{...prepared,browser:{stockQuote:()=>{throw Error('无需重采报价');},chart:()=>{throw Error('无需重采有效原图');}},review:async r=>{assert(reviewTargets(r).length<=3);return response(r);},log:()=>{}});assert.equal(resumed.counts.pending,0);assert.equal(resumed.counts.newCharts,0);assert.equal(resumed.counts.retainedCharts,12);
});
test('首张和后续小批交给并行审核；采集预算停止时审核仍保留判定及未访问数量',async t=>{
 const directory=await temp(t),controller=new AbortController(),logs=[];let quotes=0,reviews=0;
 const six=async s=>({source:TENCENT_SOURCE,sector:s.code,total:6,items:Array.from({length:6},(_,n)=>member(n+1+(s.kind==='concept'?6:0),s))});
 const run=await runScreening(options(['--sectors','合成行业,合成概念','--limit','6']),{directory,catalogLoader,memberLoader:six,signal:controller.signal,reviewSignal:new AbortController().signal,browser:{stockQuote:async i=>{if(++quotes===6){controller.abort(Object.assign(Error('合成预算耗尽'),{code:'SCREENING_TIMEOUT'}));throw controller.signal.reason;}return quote(i);},chart},review:async r=>{reviews++;assert(quotes>=1);return response(r);},log:m=>logs.push(m)});
 assert.equal(reviews,3);assert.equal(run.counts.eliminated,5);assert.equal(run.counts.visualReviewed,5);assert.equal(run.counts.unvisited,6);assert.equal(logs.filter(l=>l.startsWith('判定 ')).length,5);assert.match(outcomeMessage(run,directory),/淘汰5.*待确认7/);assert.match(outcomeMessage(run,directory),/未访问6/);
});
test('连续两只K线采集失败就停止，失败和未访问分开记录，不伪造股票淘汰',async t=>{
 const directory=await temp(t),logs=[];let calls=0;
 const run=await runScreening(cfg(),{directory,catalogLoader,memberLoader:members,browser:{stockQuote:async i=>quote(i),chart:async()=>{calls++;throw Object.assign(Error('合成K线连接失败'),{code:'CHART_NETWORK_FAILED'});}},review:()=>{throw Error('没有图不可调用模型');},log:m=>logs.push(m)});
 assert.equal(calls,2);assert.equal(run.errorCode,'CHART_SOURCE_UNAVAILABLE');assert.equal(run.counts.captureFailures,2);assert.equal(run.counts.unvisited,2);assert.equal(run.counts.eliminated,0);assert.equal(logs.filter(l=>l.startsWith('采图失败 ')).length,2);assert.match(outcomeMessage(run,directory),/采集失败2.*未访问2/);
});

test('采集预算到期后仍复核已保存图片；未取得图片的股票继续待确认',async t=>{
 const directory=await temp(t),capture=new AbortController(),root=new AbortController(),logs=[];let quotes=0,reviews=0;
 const run=await runScreening(cfg(),{directory,catalogLoader,memberLoader:members,signal:capture.signal,reviewSignal:root.signal,browser:{stockQuote:async i=>{if(++quotes===3){capture.abort(Object.assign(Error('合成采集预算到期'),{code:'SCREENING_TIMEOUT'}));throw capture.signal.reason;}return quote(i);},chart},review:async(r,_dir,{signal})=>{reviews++;assert.equal(signal,root.signal);assert.equal(capture.signal.aborted,reviews>1);assert.equal(signal.aborted,false);assert.equal(reviewTargets(r).length,1);return response(r);},log:m=>logs.push(m)});
 assert.equal(reviews,2);assert.equal(run.errorCode,'SCREENING_TIMEOUT');assert.equal(run.counts.eliminated,2);assert.equal(run.counts.pending,2);assert.equal(run.counts.visualReviewed,2);assert.equal(run.counts.newCharts,2);assert(logs.some(l=>l.includes('使用独立模型预算')));
});

test('采集超时后的原图复核仍受人工取消控制，取消不再调用模型',async t=>{
 const directory=await temp(t),capture=new AbortController(),root=new AbortController();let quotes=0,reviews=0;
 const run=await runScreening(cfg(),{directory,catalogLoader,memberLoader:members,signal:capture.signal,reviewSignal:root.signal,browser:{stockQuote:async i=>{if(++quotes===2){capture.abort(Object.assign(Error('合成采集超时'),{code:'SCREENING_TIMEOUT'}));root.abort(Object.assign(Error('合成人工取消'),{code:'USER_CANCELLED'}));throw capture.signal.reason;}return quote(i);},chart},review:async(r,_dir,{signal})=>{reviews++;await new Promise(resolve=>{signal.addEventListener('abort',resolve,{once:true});if(signal.aborted)resolve();});return response(r);},log:()=>{}});
 assert.equal(reviews,1);assert.equal(run.counts.visualReviewed,0);assert.equal(run.counts.pending,4);
});
test('全部成分超过10只完整纳入，跨板块去重，分批复核的上下文只传当批代码',async t=>{
 const full=options(['--sectors','合成行业,合成概念','--all-members','--limit','1']);assert.equal(full.allMembers,true);assert.throws(()=>options(['--resume','old','--all-members']),/沿用原名单范围/);
 const all=async(s,{allMembers})=>{assert.equal(allMembers,true);return{source:TENCENT_SOURCE,sector:s.code,total:15,items:Array.from({length:15},(_,n)=>member(n+1+(s.kind==='concept'?10:0),s))};};
 const directory=await temp(t),visited=[],batches=[];
 const run=await runScreening(full,{directory,catalogLoader,memberLoader:all,browser:{stockQuote:async i=>{visited.push(i.code);return quote(i);},chart},review:async r=>{const prompt=makePrompt(r),codes=reviewTargets(r).map(i=>i.code);batches.push(codes);assert.match(prompt,/各板块全部成分已纳入任务/);assert.doesNotMatch(prompt,/每板块最多前1只/);const metadata=JSON.parse(prompt.split('本次元数据及图片manifest（个股视觉以附图为准）：\n')[1]);assert(metadata.membershipEvidence.groups.every(g=>g.items.every(i=>codes.includes(i.code))));return response(r);},log:()=>{}});
 assert.equal(run.items.length,25);assert.equal(new Set(visited).size,25);assert.equal(visited.length,25);assert.equal(run.counts.eliminated,25);assert.equal(batches[0].length,1);assert(batches.slice(1).every(b=>b.length<=3));assert.equal(batches.flat().length,25);assert(selectedMembershipConfirmed(run));
 const report=await fs.readFile(path.join(directory,'结果.md'),'utf8');assert.match(report,/纳入全部成分股，纳入30条，去重后25只/);assert.doesNotMatch(report,/名单外成分未检查/);
 const summary=JSON.parse(await fs.readFile(path.join(directory,'任务概要.json'),'utf8'));assert.equal(summary.allMembers,true);assert.equal(summary.id,run.id);assert.equal(summary.limit,1);
 run.membershipEvidence.groups[0].items.pop();assert.equal(selectedMembershipConfirmed(run),false);
 await assert.rejects(collectSelectedMembers(sectors,{allMembers:true,limit:1,memberLoader:members}),/成分数量/);
});
test('全量任务预算中断后仅处理缺项，保留全量范围、原名单和已完成判定',async t=>{
 const root=await temp(t),directory=path.join(root,'full');await fs.mkdir(directory);const capture=new AbortController();let calls=0;
 const all=async(s,{allMembers})=>{assert.equal(allMembers,true);return{source:TENCENT_SOURCE,sector:s.code,total:12,items:Array.from({length:12},(_,n)=>member(n+1+(s.kind==='concept'?9:0),s))};};
 const run=await runScreening(options(['--sectors','合成行业,合成概念','--all-members','--limit','1']),{directory,catalogLoader,memberLoader:all,signal:capture.signal,reviewSignal:new AbortController().signal,browser:{stockQuote:async i=>{if(++calls===8){capture.abort(Object.assign(Error('合成全量采集超时'),{code:'SCREENING_TIMEOUT'}));throw capture.signal.reason;}return quote(i);},chart},review:async r=>response(r),log:()=>{}});
 assert.equal(run.items.length,21);assert.equal(run.counts.eliminated,7);assert.equal(run.counts.pending,14);assert.equal(run.allMembers,true);const before=await fs.readFile(path.join(directory,'run.json'),'utf8');
 const prepared=await prepareResume(options(['--resume',directory,'--output-dir',root]));assert.equal(prepared.cfg.allMembers,true);assert.equal(prepared.cfg.limit,1);assert.equal(prepared.seed.resumePendingCodes.length,14);
 const visited=[];const resumed=await runScreening(prepared.cfg,{...prepared,catalogLoader:()=>{throw Error('不可再查目录');},memberLoader:()=>{throw Error('不可再取成分');},browser:{stockQuote:async i=>{visited.push(i.code);return quote(i);},chart},review:async r=>response(r),log:()=>{}});
 assert.equal(resumed.allMembers,true);assert.equal(resumed.items.length,21);assert.equal(resumed.counts.eliminated,21);assert.equal(resumed.counts.pending,0);assert.equal(visited.length,14);assert(visited.every(c=>prepared.seed.resumePendingCodes.includes(c)));assert.equal(await fs.readFile(path.join(directory,'run.json'),'utf8'),before);
});
