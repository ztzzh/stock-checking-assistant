// 合成成分/网页测试，不调用真实模型，不作为股票判断或速度成绩。
import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs/promises';import path from 'node:path';import os from 'node:os';
import {memberTarget,memberScopeLabel} from '../script/member-scope.mjs';
import {TENCENT_SOURCE,loadTencentMembers} from '../script/tencent-history.mjs';
import {collectSelectedMembers,selectedMembershipConfirmed,selectionDay} from '../script/selected-sectors.mjs';
import {options,runScreening,prepareResume} from '../script/screen.mjs';
import {requestArgs} from '../script/gui-protocol.mjs';
const sectors=[{code:'pt01801081',name:'合成行业',kind:'industry',source:TENCENT_SOURCE},{code:'pt02GN2442',name:'合成概念',kind:'concept',source:TENCENT_SOURCE}];
const catalogLoader=async kind=>({kind,total:1,entries:sectors.filter(s=>s.kind===kind)}),reply=data=>({ok:true,text:async()=>JSON.stringify({code:0,data})});
const stock=(n,s)=>({code:String(300000+n),name:'合成'+n,market:'sz',url:'https://quote.eastmoney.com/sz'+(300000+n)+'.html',membershipSource:TENCENT_SOURCE,membershipSector:s.code});
async function temp(t){const dir=await fs.mkdtemp(path.join(os.tmpdir(),'stock-percent-'));t.after(async()=>{assert.equal(path.dirname(dir),path.resolve(os.tmpdir()));assert(path.basename(dir).startsWith('stock-percent-'));await fs.rm(dir,{recursive:true,force:true});});return dir;}
const loader=async(s,scope)=>{const total=s.kind==='industry'?29:101,count=memberTarget(total,scope);return{source:TENCENT_SOURCE,sector:s.code,total,items:Array.from({length:count},(_,n)=>stock(n+1+(s.kind==='concept'?7:0),s))};};
test('百分比按每个板块总数向上取整，无10只上限；1%至少一只、100%全部',()=>{
 for(const [total,pct,count]of[[100,30,30],[29,30,9],[101,30,31],[1174,30,353],[443,30,133],[3,1,1],[1174,100,1174]])assert.equal(memberTarget(total,{limit:1,memberPercent:pct}),count);
 assert.equal(memberTarget(29,{limit:9}),9);assert.equal(memberTarget(29,{limit:1,allMembers:true}),29);assert.match(memberScopeLabel({memberPercent:30}),/30%.*向上取整/);
 for(const value of [0,101,1.5,NaN,Infinity,'30'])assert.throws(()=>memberTarget(29,{memberPercent:value}),/百分比/);
 assert.throws(()=>memberTarget(29,{allMembers:true,memberPercent:30}),/只能选择一种/);
 const cfg=options(['--sectors','合成行业','--member-percent','30','--limit','1']);assert.equal(cfg.memberPercent,30);assert.equal(cfg.allMembers,false);
 for(const args of [['--all-members'],['--resume','old'],['--review-only','old'],['--rankings-only']])assert.throws(()=>options(['--member-percent','30',...args]),/只能选择一种|原名单范围/);
});
test('真实分页契约：按total计算比例，跨页只纳入目标数；不输出接口个股报价',async()=>{
 const rows=Array.from({length:450},(_,n)=>({code:'sz'+(300001+n),name:'合成'+n,zxj:999,open:1,priceRatio:99}));
 for(const [pct,expected,offsetsExpected]of[[1,5,[0]],[50,225,[0,50]],[100,450,[0,50,100,150,200,250]]]){
  const offsets=[],group=await loadTencentMembers(sectors[0],{limit:1,memberPercent:pct,fetchImpl:async u=>{const offset=Number(u.searchParams.get('offset'));offsets.push(offset);assert.equal(u.searchParams.get('count'),'200');return reply({total:rows.length,rank_list:rows.slice(offset,offset+200)});}});
  assert.equal(group.items.length,expected);assert.equal(group.targetCount,expected);assert.equal(group.selectedCount,expected);assert.equal(group.memberPercent,pct);assert.deepEqual(offsets,offsetsExpected);assert.equal(new Set(group.items.map(i=>i.code)).size,expected);assert.equal(group.items.at(-1).code,String(300000+expected));assert(group.items.every(i=>i.zxj===undefined&&i.open===undefined&&i.priceRatio===undefined));
 }
});
test('百分比取数仍拒绝总数变化、缺项、HTTP受限和取消，不以部分名单继续',async()=>{
 const rows=Array.from({length:450},(_,n)=>({code:'sz'+(300001+n),name:'合成'+n}));
 for(const scenario of ['missing','changed','http']){let calls=0;await assert.rejects(loadTencentMembers(sectors[0],{memberPercent:50,fetchImpl:async u=>{const offset=Number(u.searchParams.get('offset'));calls++;if(offset&&scenario==='http')return{ok:false,status:429};return reply({total:offset&&scenario==='changed'?451:450,rank_list:scenario==='missing'?rows.slice(0,200):rows.slice(offset,offset+200)});}}),/缺项|总数|HTTP 429/);assert.equal(calls,scenario==='missing'?6:2);}
 const controller=new AbortController();controller.abort(Error('合成人工停止'));let calls=0;await assert.rejects(loadTencentMembers(sectors[0],{memberPercent:30,signal:controller.signal,fetchImpl:()=>{calls++;}}),/人工停止/);assert.equal(calls,0);
});
test('多板块分别计算再去重，报告及概要保留比例与实际只数；预览不调用浏览器和模型',async t=>{
 const proof=await collectSelectedMembers(sectors,{memberPercent:30,limit:1,memberLoader:loader});assert.deepEqual(proof.groups.map(g=>g.items.length),[9,31]);assert.equal(proof.totalMembershipRows,130);assert.equal(proof.selectedMembershipRows,40);assert.equal(proof.items.length,38);assert.equal(proof.items.find(i=>i.code==='300008').memberships.length,2);
 const directory=await temp(t),run=await runScreening(options(['--sectors','合成行业,合成概念','--member-percent','30','--members-only']),{directory,catalogLoader,memberLoader:loader,browser:{stockQuote:()=>{throw Error('禁止打开个股');}},review:()=>{throw Error('禁止调用模型');},log:()=>{}});
 assert.equal(run.items.length,38);assert.equal(run.memberPercent,30);assert(selectedMembershipConfirmed(run));const summary=JSON.parse(await fs.readFile(path.join(directory,'任务概要.json')));assert.equal(summary.memberPercent,30);const report=await fs.readFile(path.join(directory,'结果.md'),'utf8');assert.match(report,/前30%.*向上取整/);assert.match(report,/纳入40条，去重后38只/);assert.match(report,/29 \| 9/);assert.match(report,/101 \| 31/);
 run.memberPercent=35;assert.equal(selectedMembershipConfirmed(run),false);run.memberPercent=30;run.membershipEvidence.groups[0].items.pop();assert.equal(selectedMembershipConfirmed(run),false);
});
test('比例任务断点只继续原缺项，沿用原百分比和名单，不能按最新total重选',async t=>{
 const root=await temp(t),directory=path.join(root,'first');await fs.mkdir(directory);let calls=0;const controller=new AbortController();
 const quote=async i=>({code:i.code,name:i.name,price:'11',open:'11',dateText:selectionDay(),image:Buffer.from('合成可见报价')});
 const original=await runScreening(options(['--sectors','合成行业','--member-percent','30']),{directory,catalogLoader,memberLoader:loader,signal:controller.signal,reviewSignal:new AbortController().signal,browser:{stockQuote:async i=>{if(++calls===3){controller.abort(Object.assign(Error('合成预算到期'),{code:'SCREENING_TIMEOUT'}));throw controller.signal.reason;}return quote(i);}},review:()=>{throw Error('报价淘汰不调用模型');},log:()=>{}});
 assert.equal(original.items.length,9);assert.equal(original.counts.eliminated,2);const before=await fs.readFile(path.join(directory,'run.json'),'utf8'),completed=structuredClone(original.items.slice(0,2));
 const prepared=await prepareResume(options(['--resume',directory,'--output-dir',root]));assert.equal(prepared.cfg.memberPercent,30);assert.equal(prepared.seed.resumePendingCodes.length,7);
 const seen=[],continued=await runScreening(prepared.cfg,{...prepared,browser:{stockQuote:async i=>{seen.push(i.code);return quote(i);}},catalogLoader:()=>{throw Error('不能重新查目录');},memberLoader:()=>{throw Error('不能重新计算比例或取成分');},log:()=>{}});assert.equal(continued.memberPercent,30);assert.equal(continued.items.length,9);assert.equal(continued.counts.eliminated,9);assert.equal(seen.length,7);assert.deepEqual(continued.items.slice(0,2),completed);assert.equal(await fs.readFile(path.join(directory,'run.json'),'utf8'),before);
});
test('EXE命令传递比例用于新任务；继续与原图重评不接受改动范围',async t=>{
 const root=await temp(t);await fs.writeFile(path.join(root,'run.json'),'{}');const base={command:'start',mode:'normal',source:'sina',sectors:['合成行业'],limit:9,captureSeconds:300,reviewSeconds:180,allMembers:false,memberPercent:30};
 for(const mode of ['normal','capture','members']){const args=await requestArgs({...base,mode},root);assert.equal(args[args.indexOf('--member-percent')+1],'30');assert(!args.includes('--all-members'));}
 for(const mode of ['resume','review']){const args=await requestArgs({...base,mode,batchDirectory:root},root);assert(!args.includes('--member-percent'));}
 for(const bad of [{memberPercent:0},{memberPercent:101},{memberPercent:1.2},{memberPercent:'30'},{allMembers:true}])await assert.rejects(requestArgs({...base,...bad},root),/百分比|只能选择一种/);
});
