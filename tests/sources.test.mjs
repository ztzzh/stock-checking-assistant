// 来源隔离与策略一致性的软件夹具；不产生真实行情结论。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {options,runScreening,prepareResume,reviewSavedBatch} from '../script/screen.mjs';
import {sourceName,sourceFromURL,stockURL,safeSinaURL,assignSource,assertCaptureSource,marketEvidenceConfirmed} from '../script/sources.mjs';
import {SinaBrowser,sinaNetworkRecord} from '../script/sina-browser.mjs';
import {createMarketBrowser} from '../script/market-browser.mjs';
import {ScriptBrowser} from '../script/browser.mjs';
import {reviewTargets,reviewInput,applyReviews,makePrompt} from '../script/vision.mjs';
import {selectedMembershipConfirmed} from '../script/selected-sectors.mjs';
import {TENCENT_SOURCE} from '../script/tencent-history.mjs';
const date='2026-10-26',bytes=Buffer.from('合成截图不是行情');
const sector={code:'pt01800001',name:'合成行业',kind:'industry',source:TENCENT_SOURCE};
const member=n=>({code:String(300000+n),name:'合成'+n,market:'sz',url:`https://quote.eastmoney.com/sz${300000+n}.html`,membershipSource:TENCENT_SOURCE,membershipSector:sector.code});
const catalogLoader=async kind=>({kind,total:1,entries:[kind==='industry'?sector:{...sector,code:'pt02GN0001',name:'合成概念',kind}]});
const memberLoader=async()=>({source:TENCENT_SOURCE,sector:sector.code,total:3,items:[1,2,3].map(member)});
const verdict=i=>({code:i.code,identityConfirmed:true,period15mConfirmed:true,latestBarDate:date,allMALabelsVisible:true,volumeComplete:true,chartPrice:12,ma5:12,ma10:12,ma20:11.8,ma60:11,shape:'pass',nearMA20:'pass',ma20Above60:'pass',redVolume:'pass',reason:'合成四项通过'});
const payload=run=>({marketDate:date,marketPhase:'软件合成收盘',rankingEvidenceConfirmed:true,quoteEvidenceConfirmed:true,stocks:reviewTargets(run).map(verdict),notes:'软件测试'});
const browser=source=>({stockQuote:async i=>({source,url:stockURL(i,source),code:i.code,name:i.name,price:'12',open:'11',dateText:date+' 15:00',image:bytes}),chart:async i=>({image:bytes,chartInfo:{source,url:stockURL(i,source),selectedPeriod:source==='sina'?'15分':'15分钟',readiness:{ready:true}},capturedAt:new Date().toISOString(),periodImages:[{image:bytes}],parameterImages:source==='sina'?[{image:bytes,parameters:[5,10,20,60]}]:[]})});
async function temp(t){const dir=await fs.mkdtemp(path.join(os.tmpdir(),'sources-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));return dir;}
async function runFixture(t,source,review=async r=>payload(r)){
 const directory=await temp(t),cfg=options(['--sectors',sector.name,'--source',source,'--limit','3']);
 const run=await runScreening(cfg,{directory,catalogLoader,memberLoader,browser:browser(source),review,log:()=>{}});return{run,directory,cfg};
}
test('显式来源参数与继承分开，非法来源及原图重评换源拒绝，工厂返回正确采集器',()=>{
 assert.equal(options(['--sectors','合成']).source,'eastmoney');assert.equal(options(['--resume','x']).sourceExplicit,false);
 assert.equal(options(['--source','sina','--sectors','合成']).sourceExplicit,true);
 assert.throws(()=>options(['--source','random','--sectors','合成']),/仅支持/);assert.throws(()=>options(['--review-only','x','--source','sina']),/原图重评不切换/);
 assert.throws(()=>options(['--source','','--sectors','合成']),/仅支持/);
 for(const source of ['toString','__proto__','constructor'])assert.throws(()=>options(['--source',source,'--sectors','合成']),/仅支持/);
 assert.throws(()=>options(['--rankings-only','--source','sina']),/个股报价和图表/);
 assert(createMarketBrowser('sina',{}) instanceof SinaBrowser);assert(createMarketBrowser('eastmoney',{}) instanceof ScriptBrowser);
});
test('目标URL只由已知代码和交易所构造，拒绝假域名、凭据、端口及非个股页',()=>{
 for(const source of ['sina','eastmoney'])for(const market of ['sh','sz','bj'])assert.equal(sourceFromURL(stockURL({...member(1),market},source)),source);
 assert.equal(stockURL({code:'688648',url:'https://quote.eastmoney.com/kcb/688648.html'},'sina'),'https://finance.sina.com.cn/realstock/company/sh688648/nc.shtml');
 assert.throws(()=>stockURL({code:'300001'},'sina'),/交易所缺失/);assert.throws(()=>stockURL({code:'invalid',market:'sz'},'sina'),/代码无效/);
 for(const url of ['http://finance.sina.com.cn/realstock/company/sz300001/nc.shtml','https://finance.sina.com.cn.evil.test/realstock/company/sz300001/nc.shtml','https://user:pass@finance.sina.com.cn/realstock/company/sz300001/nc.shtml','https://finance.sina.com.cn:8000/realstock/company/sz300001/nc.shtml','https://finance.sina.com.cn/news/','https://quote.eastmoney.com:8000/sz300001.html'])assert.equal(sourceFromURL(url),null);
 assert.throws(()=>safeSinaURL(stockURL(member(1),'sina')+'?secret=x'),/只允许/);assert.throws(()=>safeSinaURL(stockURL(member(1),'sina')+'#x'),/只允许/);assert.equal(sourceName('sina'),'新浪财经');
});
test('只改变行情URL，板块成分原证据保留；不允许报价与图来自不同来源',()=>{
 const i=assignSource(member(1),'sina');assert.equal(i.membershipURL,member(1).url);assert.equal(i.url,stockURL(i,'sina'));
 assert.equal(marketEvidenceConfirmed({...i,quoteSnapshot:{source:'sina',url:i.url},chartInfo:{source:'sina',url:i.url}}),true);
 assert.equal(marketEvidenceConfirmed({...i,quoteSnapshot:{source:'eastmoney',url:i.membershipURL},chartInfo:{source:'sina'}}),false);
 assert.equal(marketEvidenceConfirmed({quoteSnapshot:{url:'https://evil.test/'}}),false);assert.equal(marketEvidenceConfirmed({}),true);
 assert.equal(marketEvidenceConfirmed({marketSource:'toString'}),false);
 assert.throws(()=>assertCaptureSource({source:'sina'},'eastmoney'),e=>e.code==='MARKET_SOURCE_MISMATCH');assert.throws(()=>assertCaptureSource({url:i.membershipURL},'sina'),e=>e.code==='MARKET_SOURCE_MISMATCH');
});
test('两来源走相同四项策略：通过、逐项失败、不清楚、缺图证结果完全相同',async t=>{
 const a=await runFixture(t,'eastmoney'),b=await runFixture(t,'sina');assert.equal(a.run.counts.passed,3);assert.equal(b.run.counts.passed,3);
 for(const [changes,status] of [[{},'符合'],[{shape:'fail'},'淘汰'],[{nearMA20:'fail'},'淘汰'],[{ma20Above60:'fail'},'淘汰'],[{redVolume:'fail'},'淘汰'],[{nearMA20:'unclear'},'待确认'],[{period15mConfirmed:false},'待确认'],[{allMALabelsVisible:false},'待确认'],[{volumeComplete:false},'待确认'],[{ma20:10,ma60:11},'待确认']]){
  const conclusions=[];for(const original of [a.run,b.run]){const run=structuredClone(original),p=payload(run);p.stocks.forEach(s=>Object.assign(s,changes));applyReviews(run,p);assert(run.items.every(i=>i.result.status===status));conclusions.push(run.items.map(i=>({result:i.result,review:i.review})));}assert.deepEqual(conclusions[0],conclusions[1]);
 }
 assert.equal(selectedMembershipConfirmed(b.run),true);b.run.items[0].membershipURL='https://quote.eastmoney.com/sz999999.html';assert.equal(selectedMembershipConfirmed(b.run),false);
});
test('新浪参数图保留在本地完整图证清单；篡改SHA后拒绝重评',async t=>{
 const {run,directory}=await runFixture(t,'sina'),file=run.items[0].parameterFiles[0].file;
 assert(reviewInput(run,{includeAuxiliary:true}).images.some(i=>i.file===file));assert(!reviewInput(run).images.some(i=>i.file===file));assert.match(makePrompt(run),/换来源不改变/);assert.equal(JSON.parse(makePrompt(run).split('本次元数据及图片manifest（个股视觉以附图为准）：\n')[1]).marketSource,'sina');
 const report=await fs.readFile(path.join(directory,'结果.md'),'utf8'),csv=await fs.readFile(path.join(directory,'结果.csv'),'utf8');assert.match(report,/新浪财经/);assert.match(csv,/来源/);assert.match(csv,/新浪财经/);
 await fs.writeFile(path.join(directory,file),'changed');let calls=0;
 await assert.rejects(reviewSavedBatch(options(['--review-only',directory,'--output-dir',await temp(t)]),{review:async()=>{calls++;},log:()=>{}}),/MA参数图SHA256/);assert.equal(calls,0);
});
test('续跑默认继承新浪，显式换源重采所有待确认的报价及图；完成项与原批次保留',async t=>{
 for(const [from,to]of[['eastmoney','sina'],['sina','eastmoney']]){
  const f=await runFixture(t,from,async r=>{const p=payload(r);for(const i of p.stocks)if(i.code!=='300001')i.shape='unclear';return p;});
  const before=await fs.readFile(path.join(f.directory,'run.json'),'utf8');
  const inherited=await prepareResume(options(['--resume',f.directory,'--output-dir',await temp(t)]));assert.equal(inherited.cfg.source,from);
  const prepared=await prepareResume(options(['--resume',f.directory,'--source',to,'--output-dir',await temp(t)]));
  assert.equal(prepared.cfg.source,to);assert.deepEqual(prepared.seed.resumeReviewFromSavedCodes,[]);assert.deepEqual(prepared.seed.resumeCaptureCodes,['300002','300003']);
  assert.equal(prepared.seed.items[0].marketSource,from);assert.equal(prepared.seed.items[1].quoteSnapshot,undefined);assert.equal(prepared.seed.items[1].parameterFiles,undefined);
  const visited=[],fake=browser(to),run=await runScreening(prepared.cfg,{...prepared,browser:{...fake,stockQuote:async i=>{visited.push(i.code);return fake.stockQuote(i);}},memberLoader:()=>{throw Error('续跑不重选成分');},review:async r=>payload(r),log:()=>{}});
  assert.deepEqual(visited,['300002','300003']);assert.equal(run.counts.pending,0);assert.equal(run.items[0].marketSource,from);assert(run.items.slice(1).every(i=>i.marketSource===to&&marketEvidenceConfirmed(i)));assert.equal(await fs.readFile(path.join(f.directory,'run.json'),'utf8'),before);
 }
});
test('换源续跑也不复用尚未复核的旧来源图',async t=>{
 const f=await runFixture(t,'eastmoney',async()=>{throw Error('合成模型未完成');});assert.equal(f.run.items[0].review,undefined);assert.equal(f.run.items[0].chartInfo.readiness.ready,true);
 const prepared=await prepareResume(options(['--resume',f.directory,'--source','sina','--output-dir',await temp(t)]));assert.equal(prepared.seed.resumeReviewFromSavedCodes.length,0);assert.equal(prepared.seed.resumeCaptureCodes.length,3);assert(prepared.seed.items.every(i=>!i.chartFile&&!i.quoteSnapshot));
});
test('采集层拒绝混源报价或混源图，不调用模型、不自动切回其他来源',async t=>{
 for(const stage of ['stockQuote','chart']){
  const directory=await temp(t),fake=browser('sina'),calls=[];
  const b={...fake,[stage]:async i=>{calls.push(i.code);if(stage==='stockQuote')return browser('eastmoney').stockQuote(i);return browser('eastmoney').chart(i);}};
  const run=await runScreening(options(['--sectors',sector.name,'--source','sina','--limit','3']),{directory,catalogLoader,memberLoader,browser:b,review:()=>{throw Error('无同源图不可调用模型');},log:()=>{}});
  assert.equal(calls.length,3);assert.equal(run.counts.pending,3);assert.equal(run.counts.visualReviewed,0);assert(run.items.every(i=>i.captureErrorCode==='MARKET_SOURCE_MISMATCH'&&!i.chartFile));
 }
 const f=await runFixture(t,'sina'),run=structuredClone(f.run);run.items[0].quoteSnapshot.source='eastmoney';applyReviews(run,payload(run));assert.equal(run.contextConfirmed,false);assert(run.items.every(i=>i.result.status==='待确认'));
});
test('新浪仍核对可见身份、日期与数值，允许全半角A；诊断不存查询/响应体',()=>{
 const b=new SinaBrowser({}),i={code:'000725',name:'京东方A',market:'sz',expectedMarketDate:date},q={code:i.code,name:'京东方Ａ',price:'4.87',open:'4.86',dateText:date,url:stockURL(i,'sina')};assert.equal(b.checkQuote(q,i),q);
 for(const [change,code]of[[{name:'错误名'},'QUOTE_IDENTITY_MISMATCH'],[{price:'-'},'QUOTE_NOT_READY'],[{dateText:'-'},'QUOTE_DATE_NOT_READY'],[{dateText:'2026-10-23'},'MARKET_DATE_CHANGED'],[{url:stockURL({...i,code:'300001'},'sina')},'QUOTE_IDENTITY_MISMATCH']])assert.throws(()=>b.checkQuote({...q,...change},i),e=>e.code===code);
 const row=sinaNetworkRecord({url:()=> 'https://quotes.sina.cn/cn/api/jsonp_v2.php/CN_MarketDataService.getKLineData?symbol=x&token=never-save'},{status:429});assert.equal(row.status,429);assert.doesNotMatch(JSON.stringify(row),/token|symbol|never-save/);
 assert.equal(sinaNetworkRecord({url:()=> 'https://quotes.sina.cn.evil.test/x?token=x'}),null);
});
