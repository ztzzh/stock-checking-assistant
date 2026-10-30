// 全部为隔离合成数据；不请求真实市场、模型或用户会话。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {setTimeout as delay} from 'node:timers/promises';
import {historyURL,parseHistory,SectorHistoryProvider} from '../script/history.mjs';
import {rankHistoricalSectors} from '../script/period.mjs';
import {options,runScreening} from '../script/screen.mjs';
import {applyReviews,makePrompt} from '../script/vision.mjs';

const now=()=>Date.parse('2026-10-25T08:00:00Z');
const bars=Array.from({length:31},(_,n)=>({date:new Date(Date.UTC(2026,7,24+n*2)).toISOString().slice(0,10),close:100+n}));
const end=bars.at(-1).date;
const sectors=[{code:'BK0001',name:'合成行业甲',kind:'industry'},{code:'BK0002',name:'合成行业乙',kind:'industry'},{code:'BK0003',name:'合成概念甲',kind:'concept'}];
const histories=sectors.map((s,n)=>({...s,bars:bars.map((b,i)=>({...b,close:100+i*(n+1)}))}));
const catalogLoader=async kind=>({entries:sectors.filter(s=>s.kind===kind),pages:1});
const response=(code,history=bars)=>({ok:true,json:async()=>({rc:0,data:{code,klines:history.map(b=>`${b.date},999,${b.close},1000,1,10`)}})});
async function temporary(t){const directory=await fs.mkdtemp(path.join(os.tmpdir(),'period-screening-'));t.after(()=>fs.rm(directory,{recursive:true,force:true}));return directory;}
const collected=(days=30)=>{
  const ranking=rankHistoricalSectors(histories,days);
  return{ranking,entries:histories,evidence:{source:'eastmoney-index-history',validated:true,lookback:days,asOf:end,universeCount:3,eligibleCount:3,excludedCount:0,historyFailures:0,cacheHits:0}};
};
const stock=()=>({code:'300001',name:'合成股',price:'12',open:'11',url:'https://quote.eastmoney.com/sz300001.html',chartFile:'300001-15分钟.png',imageSHA256:'synthetic'});
const payload=()=>({marketDate:end,marketPhase:'合成收盘',rankingEvidenceConfirmed:false,quoteEvidenceConfirmed:true,notes:'纯软件夹具',stocks:[{code:'300001',identityConfirmed:true,period15mConfirmed:true,latestBarDate:end,allMALabelsVisible:true,volumeComplete:true,chartPrice:12,ma5:12,ma10:11.9,ma20:11.8,ma60:11,shape:'pass',nearMA20:'pass',ma20Above60:'pass',redVolume:'pass',reason:'软件合成视觉应答'}]});

test('历史数据请求仅允许板块指数，解析日K收盘列并拒绝错代码、坏日期及未来数据',()=>{
  const url=historyURL('BK0001','2026-10-25');assert.equal(url.searchParams.get('secid'),'90.BK0001');assert.equal(url.searchParams.get('klt'),'101');
  assert.throws(()=>historyURL('300001'));assert.throws(()=>historyURL('BK0001','2026-02-31'));
  assert.deepEqual(parseHistory({rc:0,data:{code:'BK0001',klines:['2026-10-23,999,123,1000,1']}},'BK0001'),[{date:'2026-10-23',close:123}]);
  assert.throws(()=>parseHistory({rc:0,data:null},'BK0001'),/不能当作历史不足/);
  assert.throws(()=>parseHistory({rc:0,data:{code:'BK0002',klines:[]}},'BK0001'),/身份/);
  assert.throws(()=>parseHistory({rc:1},'BK0001'),/返回错误/);
  assert.throws(()=>parseHistory({rc:0,data:{code:'BK0001',klines:['2026-10-26,1,2']}},'BK0001',{asOf:'2026-10-25'}),/未来日期/);
});
test('完整两类目录、受限并发及30分钟缓存可复用15/30日排名，强制刷新才重取',async t=>{
  const cacheDir=await temporary(t);let calls=0,active=0,max=0;
  const fetchImpl=async url=>{calls++;active++;max=Math.max(max,active);await delay(5);active--;const code=url.searchParams.get('secid').slice(3);return response(code,histories.find(e=>e.code===code).bars);};
  const cfg={catalogLoader,cacheDir,now,fetchImpl,concurrency:2};
  const first=await new SectorHistoryProvider(cfg).collect(30);assert.equal(first.evidence.universeCount,3);assert.equal(first.evidence.cacheHits,0);assert.equal(first.ranking.ranked[0].code,'BK0003');assert.equal(calls,3);assert.equal(max,2);
  const cached=await new SectorHistoryProvider(cfg).collect(15);assert.equal(cached.evidence.cacheHits,3);assert.equal(calls,3);assert.equal(cached.ranking.lookback,15);
  await new SectorHistoryProvider({...cfg,refresh:true}).collect(30);assert.equal(calls,6);
});
test('缓存过期会重新取；历史不足明确排除，不使用当日涨幅填补',async t=>{
  const cacheDir=await temporary(t);let calls=0;
  const cfg={catalogLoader,cacheDir,now,concurrency:1,fetchImpl:async url=>{calls++;const code=url.searchParams.get('secid').slice(3);return response(code,code==='BK0003'?bars.slice(-5):histories.find(s=>s.code===code).bars);}};
  const result=await new SectorHistoryProvider(cfg).collect(30);assert.equal(result.evidence.eligibleCount,2);assert.equal(result.evidence.excludedCount,1);assert.equal(result.ranking.excluded[0].availableBars,5);
  await new SectorHistoryProvider({...cfg,now:()=>now()+31*60000}).collect(15);assert.equal(calls,6);
});
test('HTTP拦截即停止且不自动重试；缺概念目录时不发历史请求',async t=>{
  const cacheDir=await temporary(t);let calls=0;
  const cfg={catalogLoader,cacheDir,now,concurrency:1,fetchImpl:async()=>{calls++;return{ok:false,status:429};}};
  await assert.rejects(new SectorHistoryProvider(cfg).collect(30),/HTTP 429/);assert.equal(calls,1);
  await assert.rejects(new SectorHistoryProvider({...cfg,catalogLoader:async kind=>kind==='concept'?{entries:[],pages:0}:catalogLoader(kind)}).collect(30),/目录不完整/);assert.equal(calls,1);
});
test('远端断连保留错误码而不只显示TypeError；空data阻止不完整排名',async t=>{
  const cacheDir=await temporary(t),cfg={catalogLoader,cacheDir,now,concurrency:1};
  await assert.rejects(new SectorHistoryProvider({...cfg,fetchImpl:async()=>{throw new TypeError('fetch failed',{cause:{code:'UND_ERR_SOCKET'}});}}).collect(15),/UND_ERR_SOCKET（远端断开连接/);
  await assert.rejects(new SectorHistoryProvider({...cfg,fetchImpl:async()=>({ok:true,json:async()=>({rc:0,data:null})})}).collect(30),/不能当作历史不足/);
});
test('近期参考工具只输出计算依据，不自动进入个股筛选',async t=>{
  const directory=await temporary(t);let charts=0;
  const browser={ranking:async()=>{throw Error('近期不能使用今日榜');},constituents:async selected=>{assert.equal(selected.code,'BK0003');return{snapshot:{url:'合成报价'},items:[{...stock(),chartFile:undefined}],image:Buffer.from('合成报价图'),boardImage:Buffer.from('合成详情图'),boardContext:{url:'合成板块详情'}};},chart:async()=>{charts++;return{image:Buffer.from('合成15分钟图'),capturedAt:new Date().toISOString(),chartInfo:{selectedPeriod:'15分钟'}};}};
  const run=await runScreening(options(['--rankings-only']),{browser,directory,historyProvider:{collect:async days=>collected(days)},review:async()=>{throw Error('排名工具不得调用视觉模型');},log:()=>{}});
  assert.equal(run.status,'rankings_only');assert.equal(charts,0);assert.equal(run.items.length,0);assert.equal(run.sector.code,'BK0003');
  assert.match(await fs.readFile(path.join(directory,'板块排名.csv'),'utf8'),/30个交易日/);assert.equal(JSON.parse(await fs.readFile(path.join(directory,'区间指数数据.json'),'utf8')).length,3);
  assert.equal(run.images.length,0);
});
test('只导出近期排名不打开个股、不采图、不调用视觉模型',async t=>{
  const directory=await temporary(t),deny=async()=>{throw Error('不应调用');};
  const run=await runScreening(options(['--lookback','15','--rankings-only']),{directory,browser:{ranking:deny,constituents:deny,chart:deny},review:deny,historyProvider:{collect:async days=>collected(days)},log:()=>{}});
  assert.equal(run.status,'rankings_only');assert.equal(run.marketDate,end);assert.equal(run.items.length,0);assert.equal(run.lookback,15);assert.equal(run.sector.lookback,15);
});
test('近期证据的截止日、完整覆盖及算术错误都阻止视觉符合',()=>{
  for(const mutate of [run=>{run.periodEvidence.validated=false;},run=>{run.periodEvidence.universeCount++;},run=>{run.sector.rate++;},run=>{run.periodEvidence.asOf='2026-10-22';},run=>{run.periodEvidence.historyFailures=1;},run=>{run.sector.lookback=15;}]){
    const data=collected(),run={lookback:30,sector:{...data.ranking.ranked[0]},periodEvidence:{...data.evidence},items:[stock()]};mutate(run);applyReviews(run,payload());assert.equal(run.items[0].result.status,'待确认');assert.equal(run.contextConfirmed,false);
  }
});
