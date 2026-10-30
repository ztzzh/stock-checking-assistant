// 合成板块/报价，不访问市场和用户登录，也不运行真实模型。
import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs/promises';import os from 'node:os';import path from 'node:path';
import {TENCENT_SOURCE,loadTencentCatalog,loadTencentMembers,parseTencentBars,TencentHistoryProvider,sdkDailyBatch}from'../script/tencent-history.mjs';
import{options,runScreening}from'../script/screen.mjs';import{applyReviews}from'../script/vision.mjs';
const now=()=>Date.parse('2026-10-25T09:00:00Z');const bars=Array.from({length:31},(_,n)=>({date:new Date(Date.UTC(2026,8,23+n)).toISOString().slice(0,10),close:100+n}));
const sectors=[{code:'pt01801081',name:'合成行业',kind:'industry',source:TENCENT_SOURCE},{code:'pt02GN2442',name:'合成概念',kind:'concept',source:TENCENT_SOURCE}];
const catalogLoader=async kind=>({kind,total:1,pages:1,source:'tencent-public-sector-catalog',entries:sectors.filter(s=>s.kind===kind)});
const batchLoader=async codes=>codes.map(code=>({...sectors.find(s=>s.code===code),bars:bars.map((b,n)=>({...b,close:100+n*(code.startsWith('pt02')?2:1)}))}));
const temp=async t=>{const d=await fs.mkdtemp(path.join(os.tmpdir(),'tencent-sector-'));t.after(()=>fs.rm(d,{recursive:true,force:true}));return d;};
const reply=data=>({ok:true,text:async()=>JSON.stringify({code:0,data})});
test('腾讯两类目录根据total翻页，接受新旧概念代码，拒绝重复页和缺概念',async()=>{
 let calls=0;const fetchImpl=async u=>{calls++;assert.equal(u.searchParams.get('board_type'),'gn');return reply({total:2,rank_list:[{code:calls===1?'pt02003800':'pt02GN2442',name:'合成'+calls,stock_type:'BK-GN'}]});};
 const c=await loadTencentCatalog('concept',{fetchImpl});assert.equal(c.entries.length,2);assert.equal(c.pages,2);assert.equal(calls,2);
 await assert.rejects(loadTencentCatalog('concept',{fetchImpl:async()=>reply({total:2,rank_list:[{code:'pt02GN2442',name:'重复',stock_type:'BK-GN'}]})}),/重复/);
 let failures=0;await assert.rejects(loadTencentCatalog('industry',{fetchImpl:async()=>{failures++;return{ok:false,status:429};}}),/HTTP 429/);assert.equal(failures,1);
});
test('盘中目录相邻页有意重叠，跨页同身份去重并核齐total；同页重复和缺项仍拒绝',async()=>{
 const rows=Array.from({length:250},(_,n)=>({code:'pt02'+String(300000+n),name:'合成概念'+n,stock_type:'BK-GN'})),offsets=[];
 const c=await loadTencentCatalog('concept',{fetchImpl:async u=>{const offset=Number(u.searchParams.get('offset'));offsets.push(offset);assert.equal(u.searchParams.get('count'),'200');const current=rows.slice();if(offset){[current[195],current[203]]=[current[203],current[195]];}return reply({total:250,rank_list:current.slice(offset,offset+200)});}});assert.deepEqual(offsets,[0,50]);assert.equal(c.entries.length,250);assert.equal(new Set(c.entries.map(e=>e.code)).size,250);
 await assert.rejects(loadTencentCatalog('concept',{fetchImpl:async()=>reply({total:2,rank_list:[rows[0],rows[0]]})}),/单页重复/);
 let calls=0;await assert.rejects(loadTencentCatalog('concept',{fetchImpl:async u=>{calls++;const offset=Number(u.searchParams.get('offset'));return reply({total:250,rank_list:offset?[...rows.slice(50,249),rows[0]]:rows.slice(0,200)});}}),/缺项/);assert.equal(calls,2);
});
test('完整板块名称目录当日缓存30分钟，不缓存价格；过期、跨日或损坏重新核全',async t=>{
 const cacheDir=await temp(t);let calls=0;const fetchImpl=async()=>{calls++;return reply({total:1,rank_list:[{code:'pt02GN2442',name:'合成概念',stock_type:'BK-GN',zxj:999}]});};
 const first=await loadTencentCatalog('concept',{cacheDir,fetchImpl,now});assert.equal(first.cacheHit,false);assert.equal(first.entries[0].zxj,undefined);
 const second=await loadTencentCatalog('concept',{cacheDir,fetchImpl,now:()=>now()+1000});assert.equal(second.cacheHit,true);assert.equal(calls,1);
 await loadTencentCatalog('concept',{cacheDir,fetchImpl,now:()=>now()+31*60000});assert.equal(calls,2);
 await loadTencentCatalog('concept',{cacheDir,fetchImpl,now:()=>now()+86400000});assert.equal(calls,3);
 await fs.writeFile(path.join(cacheDir,'concept.json'),'{bad');await loadTencentCatalog('concept',{cacheDir,fetchImpl,now});assert.equal(calls,4);
});
test('板块日线零值起点明确舍弃，不能跨中途缺口、重复日或未来日计算',()=>{
 const parsed=parseTencentBars([{date:'2026-09-01',close:'0'},...bars], '2026-10-25');assert.equal(parsed.leadingZeroBars,1);assert.equal(parsed.bars.length,31);assert.equal(parsed.bars[0].close,100);
 assert.throws(()=>parseTencentBars([...bars.slice(0,3),{date:'2026-10-25',close:0}],'2026-10-25'),/中途/);
 assert.throws(()=>parseTencentBars([bars[0],bars[0]],'2026-10-25'),/重复/);
 assert.throws(()=>parseTencentBars([{date:'2026-10-26',close:10}],'2026-10-25'),/无效/);
 assert.throws(()=>parseTencentBars([{date:'2026-10-23',close:null}],'2026-10-25'),/无效/);
});
test('成分只保留代码名称及同源归属，不保留接口报价',async()=>{
 const c=await loadTencentMembers(sectors[1],{limit:2,fetchImpl:async u=>{assert.equal(u.searchParams.get('board_code'),sectors[1].code);return reply({total:1,rank_list:[{code:'sz300001',name:'合成股',zxj:'999',open:'1'}]});}});
 assert.equal(c.items[0].price,undefined);assert.equal(c.items[0].open,undefined);assert.equal(c.items[0].membershipSector,sectors[1].code);assert.equal(c.items[0].url,'https://quote.eastmoney.com/sz300001.html');
 await assert.rejects(loadTencentMembers({...sectors[1],source:'wrong'}),/本次腾讯板块/);
 await assert.rejects(sdkDailyBatch(['sz300001']),/板块/);
});
test('全量成分分页核齐450只，重叠边界去重，不泄露任何接口报价字段',async()=>{
 const rows=Array.from({length:450},(_,n)=>({code:'sz'+String(300001+n),name:'合成成分'+n,zxj:999,priceRatio:99,open:1})),offsets=[];
 const result=await loadTencentMembers(sectors[1],{limit:1,allMembers:true,fetchImpl:async u=>{const offset=Number(u.searchParams.get('offset'));offsets.push(offset);assert.equal(u.searchParams.get('count'),'200');const current=rows.slice();if(offset){[current[199],current[201]]=[current[201],current[199]];}return reply({total:450,rank_list:current.slice(offset,offset+200)});}});
 assert.equal(result.items.length,450);assert.equal(result.total,450);assert.equal(result.selectedCount,450);assert.equal(result.allMembers,true);assert.deepEqual(offsets,[0,50,100,150,200,250]);assert.equal(new Set(result.items.map(i=>i.code)).size,450);assert(result.items.every(i=>i.price===undefined&&i.priceRatio===undefined&&i.open===undefined&&i.zxj===undefined));
});
test('全量缺项、总数变化、同代码冲突及HTTP失败立即停止，不把第一页当全部',async()=>{
 const rows=Array.from({length:250},(_,n)=>({code:'sz'+String(300001+n),name:'合成'+n}));
 for(const scenario of ['missing','changed-total','conflict','http']){let calls=0;await assert.rejects(loadTencentMembers(sectors[1],{allMembers:true,fetchImpl:async u=>{calls++;const offset=Number(u.searchParams.get('offset'));if(offset&&scenario==='http')return{ok:false,status:429};const page=rows.slice(offset,offset+200);if(offset&&scenario==='missing')page[199]=rows[0];if(offset&&scenario==='conflict')page[0]={...page[0],name:'错误名称'};return reply({total:offset&&scenario==='changed-total'?251:250,rank_list:page});}}),/缺项|总数|冲突|HTTP 429/);assert.equal(calls,2);}
 const stop=new AbortController();let calls=0;await assert.rejects(loadTencentMembers(sectors[1],{allMembers:true,signal:stop.signal,fetchImpl:async()=>{calls++;stop.abort(Error('人工停止全量成分'));return reply({total:250,rank_list:rows.slice(0,200)});}}),/人工停止/);assert.equal(calls,1);
});
test('完整双目录31日收盘缓存复用15/30日，缺一种目录或历史失败不出排名',async t=>{
 const cacheDir=await temp(t);let calls=0;const cfg={cacheDir,now,catalogLoader,batchLoader:async c=>{calls++;return batchLoader(c);}};
 const a=await new TencentHistoryProvider(cfg).collect(15);assert.equal(a.evidence.universeCount,2);assert.equal(a.ranking.ranked[0].kind,'concept');assert.equal(calls,1);
 const b=await new TencentHistoryProvider(cfg).collect(30);assert.equal(b.evidence.cacheHits,2);assert.equal(calls,1);
 await assert.rejects(new TencentHistoryProvider({...cfg,refresh:true,catalogLoader:async k=>k==='concept'?{kind:k,total:0,entries:[]}:catalogLoader(k)}).collect(15),/各自取全/);assert.equal(calls,1);
 await assert.rejects(new TencentHistoryProvider({...cfg,refresh:true,batchLoader:async()=>{throw Error('合成服务断开');}}).collect(15),/合成服务断开/);
});
test('同源成分与可见报价、新图串联；未出现可见报价时禁止用接口价格补齐',async t=>{
 const directory=await temp(t),cacheDir=path.join(directory,'cache'),provider=new TencentHistoryProvider({cacheDir,now,catalogLoader,batchLoader}),data=await provider.collect(15);
 const member={code:'300001',name:'合成股',market:'sz',url:'https://quote.eastmoney.com/sz300001.html',membershipSector:sectors[1].code,membershipSource:TENCENT_SOURCE};
 const memberLoader=async()=>({source:TENCENT_SOURCE,sector:sectors[1].code,total:1,items:[member]});
 const browser={stockQuote:async()=>({code:'300001',name:'合成股',price:'12',open:'11',dateText:bars.at(-1).date,image:Buffer.from('合成报价')}),chart:async()=>({image:Buffer.from('合成图'),chartInfo:{selectedPeriod:'15分钟'}})};
 const review=async()=>({marketDate:bars.at(-1).date,marketPhase:'合成',quoteEvidenceConfirmed:true,stocks:[{code:'300001',identityConfirmed:true,period15mConfirmed:true,latestBarDate:bars.at(-1).date,allMALabelsVisible:true,volumeComplete:true,chartPrice:12,ma5:12,ma10:12,ma20:11.8,ma60:11,shape:'fail',nearMA20:'not_checked',ma20Above60:'not_checked',redVolume:'not_checked'}]});
 const run=await runScreening(options(['--sectors',sectors[1].code]),{directory,catalogLoader,browser,historyProvider:{collect:async()=>data},memberLoader,review,log:()=>{}});assert.equal(run.status,'completed');assert.equal(run.contextConfirmed,true);assert.equal(run.items[0].result.status,'淘汰');
 run.items[0].memberships[0].code='pt02GN9999';applyReviews(run,await review());assert.equal(run.contextConfirmed,false);assert.equal(run.items[0].result.status,'待确认');
 let reviews=0;const failed=await runScreening(options(['--sectors',sectors[1].code]),{directory,catalogLoader,browser:{stockQuote:async()=>{throw Error('可见报价为空');}},historyProvider:{collect:async()=>data},memberLoader,review:async()=>{reviews++;},log:()=>{}});assert.equal(failed.status,'incomplete_quotes');assert.equal(failed.items[0].price,undefined);assert.equal(failed.items[0].result.status,'待确认');assert.equal(reviews,0);
});

test('过期及跨日旧收盘缓存先在线核验一个行业，匹配后复用全目录；刷新仍取全量',async t=>{
 const cacheDir=await temp(t),calls=[],cfg={cacheDir,now,catalogLoader,batchLoader:async c=>{calls.push(c);return batchLoader(c);}};
 await new TencentHistoryProvider(cfg).collect(15);assert.equal(calls.length,1);
 const expired=await new TencentHistoryProvider({...cfg,now:()=>now()+45*60000}).collect(30);
 assert.equal(calls.length,2);assert.deepEqual(calls[1],[sectors[0].code]);assert.equal(expired.evidence.cacheHits,2);assert.equal(expired.evidence.closedCacheValidated,true);assert.equal(expired.evidence.referenceCheck.endDate,'2026-10-23');
 const nextDay=await new TencentHistoryProvider({...cfg,now:()=>now()+86400000}).collect(15);assert.equal(calls.length,3);assert.equal(nextDay.evidence.cacheHits,2);assert.equal(nextDay.evidence.calendarAsOf,'2026-10-26');
 await new TencentHistoryProvider({...cfg,refresh:true}).collect(15);assert.deepEqual(calls[3],sectors.map(s=>s.code));
});
test('最新日变为当日或核验历史有修订时，不使用过期旧收盘；核验失败不离线排名',async t=>{
 const cacheDir=await temp(t),cfg={cacheDir,now,catalogLoader,batchLoader};await new TencentHistoryProvider(cfg).collect(15);
 await assert.rejects(new TencentHistoryProvider({...cfg,now:()=>now()+45*60000,batchLoader:async()=>{throw Error('在线核验失败');}}).collect(15),/在线核验失败/);
 const calls=[],fresh=await new TencentHistoryProvider({...cfg,now:()=>now()+86400000,batchLoader:async codes=>{calls.push(codes);return(await batchLoader(codes)).map(r=>({...r,bars:[...r.bars,{date:'2026-10-26',close:170}]}));}}).collect(15);
 assert.equal(fresh.evidence.cacheHits,0);assert.equal(fresh.evidence.closedCacheValidated,false);assert.equal(fresh.evidence.asOf,'2026-10-26');assert.equal(calls.length,2);
});
test('同截止日参考指数被修订，重新取得各板块而非仅比日期复用',async t=>{
 const cacheDir=await temp(t),cfg={cacheDir,now,catalogLoader,batchLoader};await new TencentHistoryProvider(cfg).collect(15);let calls=0;
 const changed=await new TencentHistoryProvider({...cfg,now:()=>now()+45*60000,batchLoader:async codes=>{calls++;return(await batchLoader(codes)).map(r=>({...r,bars:r.bars.map((b,n)=>({...b,close:b.close+(n===0?1:0)}))}));}}).collect(15);
 assert.equal(calls,2);assert.equal(changed.evidence.cacheHits,0);assert.equal(changed.evidence.closedCacheValidated,false);
});
