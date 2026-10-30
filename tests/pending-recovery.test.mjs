// 全部为合成软件夹具，不产生真实选股结论。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {assertStockQuote,ScriptBrowser,quoteNetworkRecord,sameStockPageURL} from '../script/browser.mjs';
import {options,prepareResume,runScreening,outcomeMessage,reviewSavedBatch} from '../script/screen.mjs';
import {reviewInput,applyReviews} from '../script/vision.mjs';

const date='2026-10-23',bytes=Buffer.from('合成图，不是真实行情'),hash=createHash('sha256').update(bytes).digest('hex');
const stock=code=>({code,name:'合成'+code,url:'https://quote.eastmoney.com/sz'+code+'.html',price:'12',open:'11',chartFile:code+'-15分钟.png',imageSHA256:hash,result:{status:'待确认',reason:'合成空图'}});
const verdict=code=>({code,identityConfirmed:true,period15mConfirmed:true,latestBarDate:date,allMALabelsVisible:true,volumeComplete:true,chartPrice:12,ma5:12,ma10:12,ma20:11.8,ma60:11,shape:'fail',nearMA20:'not_checked',ma20Above60:'not_checked',redVolume:'not_checked',reason:'合成厂字形失败'});
const payload=code=>({marketDate:date,marketPhase:'合成收盘',rankingEvidenceConfirmed:true,quoteEvidenceConfirmed:true,stocks:[verdict(code)],notes:'软件测试'});
async function fixture(t){
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'pending-recovery-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));const source=path.join(dir,'source'),output=path.join(dir,'output');await fs.mkdir(source);await fs.mkdir(output);
 const items=[{...stock('300001'),result:{status:'淘汰',reason:'原图厂字形失败'}},stock('300002'),stock('300003')];
 const original={kind:'standalone-visual-script',id:'synthetic-source',marketDate:date,lookback:1,rank:3,limit:10,status:'completed_with_quote_gaps',startedAt:'2026-10-25T01:00:00Z',finishedAt:'2026-10-25T01:01:00Z',sector:{name:'合成板块'},items,images:items.map(i=>({file:i.chartFile,label:'合成图'}))};
 const saved=JSON.stringify(original);await fs.writeFile(path.join(source,'run.json'),saved);for(const i of original.images)await fs.writeFile(path.join(source,i.file),bytes);
 return{source,output,original,saved,cfg:options(['--resume',source,'--output-dir',output])};
}
test('报价字段未呈现与实际身份不符分别报告，跨行情日补采立即拒绝',()=>{
 const i={code:'300001',name:'合成股',expectedMarketDate:date},q={...i,price:'12',open:'11',dateText:date};
 assert.equal(assertStockQuote(q,i),q);
 for(const [change,code]of[[{name:''},'QUOTE_IDENTITY_NOT_READY'],[{code:'-',name:'-'},'QUOTE_IDENTITY_NOT_READY'],[{code:'--',name:'—'},'QUOTE_IDENTITY_NOT_READY'],[{code:'300002'},'QUOTE_IDENTITY_MISMATCH'],[{price:'-'},'QUOTE_NOT_READY'],[{dateText:'-'},'QUOTE_DATE_NOT_READY'],[{dateText:'2026-10-26'},'MARKET_DATE_CHANGED']])assert.throws(()=>assertStockQuote({...q,...change},i),e=>e.code===code);
});

test('科创板/北交所站内规范路径沿用原文档，另一只股票不能当作同一页面',()=>{
 const base='https://quote.eastmoney.com/';
 assert.equal(sameStockPageURL(base+'kcb/688648.html',base+'sh688648.html'),true);
 assert.equal(sameStockPageURL(base+'bj/920001.html',base+'bj920001.html'),true);
 assert.equal(sameStockPageURL(base+'kcb/688585.html',base+'sh688648.html'),false);
 assert.equal(sameStockPageURL(base+'sz688648.html',base+'sh688648.html'),false);
});
test('人工验证成功后不重载已验证文档',async()=>{
 let gated=true,callbacks=0,reloads=0;
 const page={mainFrame(){return this;},frames(){return[this];},locator(selector){return selector==='body'?{innerText:async()=>gated?'拖动下方滑块完成拼图':'正常页面'}:{count:async()=>0};}};
 const browser=new ScriptBrowser({page,onVerification:async()=>{callbacks++;gated=false;}});browser.goto=async()=>{reloads++;};
 await browser.assertNoGate();assert.equal(callbacks,1);assert.equal(reloads,0);
});
test('补采只访问待确认股票，不重新排名或读取成分，完成项原判定和原图保留',async t=>{
 const f=await fixture(t),{seed,directory,cfg}=await prepareResume(f.cfg),quotes=[],charts=[];
 assert.deepEqual(seed.resumePendingCodes,['300002','300003']);assert.equal(seed.items[1].chartFile,undefined);assert.equal(seed.items[1].expectedMarketDate,date);
 assert.deepEqual(seed.images.map(i=>i.file),['300001-15分钟.png']);assert.equal(await fs.readFile(path.join(directory,'恢复前现场','300002-15分钟.png'),'utf8'),bytes.toString());
 const browser={stockQuote:async i=>{quotes.push(i.code);return{code:i.code,name:i.name,price:i.code==='300002'?'11':'12',open:'11',dateText:date,image:bytes};},chart:async i=>{charts.push(i.code);return{image:bytes,capturedAt:new Date().toISOString()};},ranking:async()=>{throw Error('不应重选板块');}};
 const run=await runScreening(cfg,{seed,directory,browser,historyProvider:{collect:async()=>{throw Error('不应读历史');}},memberLoader:async()=>{throw Error('不应读成分');},log:()=>{},review:async r=>{assert.deepEqual(reviewInput(r).codes,['300003']);return payload('300003');}});
 assert.deepEqual(quotes,['300002','300003']);assert.deepEqual(charts,['300003']);assert.equal(run.items[0].result.reason,'原图厂字形失败');assert.equal(run.counts.newCharts,1);assert.equal(run.counts.retainedCharts,1);assert.equal(run.counts.pending,0);
 assert.equal(await fs.readFile(path.join(f.source,'run.json'),'utf8'),f.saved);const report=await fs.readFile(path.join(directory,'结果.md'),'utf8');assert.match(report,/仅断点继续及复核/);assert.match(report,/自动执行.*人工等待/);assert.match(report,/继续采集2只/);
});
test('补采遇到新行情日或中断，不能清除已经完成股票的原判定',async t=>{
 const f=await fixture(t),prepared=await prepareResume(f.cfg);let captures=0;
 const run=await runScreening(prepared.cfg,{...prepared,browser:{stockQuote:async()=>{throw Object.assign(Error('行情日已变化'),{code:'MARKET_DATE_CHANGED'});},chart:async()=>{captures++;}},log:()=>{}});
 assert.equal(run.errorCode,'MARKET_DATE_CHANGED');assert.equal(captures,0);assert.equal(run.items[0].result.reason,'原图厂字形失败');
 const seed=prepared.seed;seed.items[2].chartFile='300003-15分钟.png';seed.items[2].price='12';seed.items[2].open='11';assert.throws(()=>applyReviews(seed,{...payload('300003'),marketDate:'2026-10-26'}),e=>e.code==='MARKET_DATE_CHANGED');assert.equal(seed.items[0].result.reason,'原图厂字形失败');
});
test('原批次完成项图证缺失或SHA变化，拒绝以旧判定补采',async t=>{
 const f=await fixture(t);await fs.writeFile(path.join(f.source,'300001-15分钟.png'),'changed');await assert.rejects(prepareResume(f.cfg),/SHA256不符/);
 await fs.unlink(path.join(f.source,'300001-15分钟.png'));await assert.rejects(prepareResume(f.cfg),/原批次图证缺失/);
});
test('网络诊断仅记录行情请求传输错误及HTTP状态，不保存带参URL或冒充域名',()=>{
 const request={url:()=> 'https://push2.eastmoney.com/api/qt/stock/get?token=never-save&secid=0.300001'};
 const record=quoteNetworkRecord(request,{status:429,error:'net::ERR_EMPTY_RESPONSE'});assert.equal(record.status,429);assert.equal(record.host,'push2.eastmoney.com');assert.equal(record.path,'/api/qt/stock/get');assert.doesNotMatch(JSON.stringify(record),/never-save|token=|secid=/);
 for(const url of ['https://evil-eastmoney.com/api/qt/stock/get','https://push2.eastmoney.com.evil.test/api/qt/stock/get','https://quote.eastmoney.com/ads/track?token=x'])assert.equal(quoteNetworkRecord({url:()=>url},{status:403}),null);
});
test('连续两只报价全空提前停止，后续标记未访问，不推荐仅有沿用旧图的重评命令',async t=>{
 const f=await fixture(t);f.original.items.push({...stock('300004'),price:undefined,open:undefined,chartFile:undefined});await fs.writeFile(path.join(f.source,'run.json'),JSON.stringify(f.original));
 const prepared=await prepareResume(f.cfg),visited=[];let current,diagnostics=0;
 const run=await runScreening(prepared.cfg,{...prepared,log:()=>{},browser:{stockQuote:async i=>{visited.push(i.code);current=i;throw Object.assign(Error('合成空报价'),{code:'QUOTE_NOT_READY'});},quoteDiagnostic:async()=>({snapshot:{code:current.code,name:current.name,price:'-',open:'-',dateText:'-'},image:bytes,networkFailures:[{host:'push2.eastmoney.com',path:'/api/qt/stock/get',error:'net::ERR_EMPTY_RESPONSE'}]}),diagnostics:async()=>{diagnostics++;return['失败页面.json'];}},review:async()=>{throw Error('不应调用模型');}});
 assert.deepEqual(visited,['300002','300003']);assert.equal(run.errorCode,'QUOTE_SOURCE_UNAVAILABLE');assert.equal(diagnostics,1);assert.equal(run.counts.newCharts,0);assert.deepEqual(run.quoteConnection.unvisitedCodes,['300004']);assert.match(run.items[3].result.reason,/尚未访问/);assert.equal(run.items[0].result.reason,'原图厂字形失败');assert.doesNotMatch(outcomeMessage(run,prepared.directory),/review-only/);
 const detail=JSON.parse(await fs.readFile(path.join(prepared.directory,'300002-报价诊断.json'),'utf8'));assert.equal(detail.networkFailures[0].error,'net::ERR_EMPTY_RESPONSE');
});
test('中间成功的报价清零连续失败计数；不足提前停止范围的空报价也保存批次诊断',async t=>{
 const f=await fixture(t);f.original.items.push({...stock('300004'),price:undefined,open:undefined,chartFile:undefined});await fs.writeFile(path.join(f.source,'run.json'),JSON.stringify(f.original));
 const prepared=await prepareResume(f.cfg),visited=[];let current,diagnostics=0;
 const browser={stockQuote:async i=>{visited.push(i.code);current=i;if(i.code==='300003')return{...i,price:'11',open:'11',image:bytes};throw Object.assign(Error('合成空报价'),{code:'QUOTE_NOT_READY'});},quoteDiagnostic:async()=>({snapshot:{code:current.code,name:current.name,price:'-',open:'-'},image:bytes}),diagnostics:async()=>{diagnostics++;return['失败页面.json'];}};
 const run=await runScreening(prepared.cfg,{...prepared,browser,log:()=>{}});assert.deepEqual(visited,['300002','300003','300004']);assert.equal(run.status,'incomplete_quotes');assert.equal(run.errorCode,undefined);assert.equal(run.quoteConnection,undefined);assert.equal(diagnostics,1);assert.equal(run.items[2].result.status,'淘汰');
});
test('周期悬停图纳入准确股票清单并核验SHA，缺失或改动不能静默重评',async t=>{
 const f=await fixture(t),target=f.original.items[1],file='300002-周期1.png';target.periodFiles=[{file,imageSHA256:hash}];f.original.images.push({file,label:'合成周期图'});await fs.writeFile(path.join(f.source,file),bytes);await fs.writeFile(path.join(f.source,'run.json'),JSON.stringify(f.original));
 assert(reviewInput(f.original).images.some(i=>i.file===file));let calls=0;
 await reviewSavedBatch(options(['--review-only',f.source,'--output-dir',f.output]),{review:async r=>{calls++;return{...payload('300002'),stocks:reviewInput(r).codes.map(code=>verdict(code))};},log:()=>{}});assert.equal(calls,2); // 统一首只立即审核，最后一只作为尾批。
 await fs.writeFile(path.join(f.source,file),'changed');await assert.rejects(reviewSavedBatch(options(['--review-only',f.source,'--output-dir',f.output]),{review:async()=>{calls++;},log:()=>{}}),/周期悬停图SHA256/);assert.equal(calls,2);
 const without={...f.original,images:f.original.images.filter(i=>i.file!==file)};assert.throws(()=>reviewInput(without),/周期悬停图缺失/);
});
