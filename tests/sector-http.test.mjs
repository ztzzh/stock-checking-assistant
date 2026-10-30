import test from 'node:test';
import assert from 'node:assert/strict';
import {catalogURL,assertSectorURL,sectorFetch,loadSectorCatalog} from '../script/sector-http.mjs';
import {historyURL} from '../script/history.mjs';
const row=n=>({f12:'BK'+String(n).padStart(4,'0'),f14:'合成板块'+n});
const ok=data=>({ok:true,status:200,json:async()=>({rc:0,data})});
test('专用请求通道仅放行板块目录/日K，拒绝个股、外站、跳转和私有凭据地址',()=>{
  assertSectorURL(historyURL('BK0001'));assertSectorURL(catalogURL('industry'));
  for(const url of ['https://91.push2his.eastmoney.com/api/qt/stock/kline/get?secid=0.300001&klt=101','https://push2.eastmoney.com/api/qt/clist/get?fs=b:BK0001','https://example.com/','https://u:p@push2.eastmoney.com/api/qt/clist/get'])assert.throws(()=>assertSectorURL(url));
});
test('请求复用APIRequestContext，固定公开Referer、零重试/重定向并释放响应，不读cookie',async()=>{
  let call,disposed=0;const context={request:{get:async(url,options)=>{call={url,options};return{ok:()=>true,status:()=>200,text:async()=>'{"rc":0}',dispose:async()=>{disposed++;}};}}};
  const response=await sectorFetch(context)(historyURL('BK0001'));assert.equal(disposed,1);assert.equal((await response.json()).rc,0);assert.equal(call.options.maxRetries,0);assert.equal(call.options.maxRedirects,0);assert.equal(call.options.headers.Referer,'https://quote.eastmoney.com/');
});
test('请求错误只保留安全错误码，不输出可能含凭据的原始调用日志',async()=>{
  const fetchImpl=sectorFetch({request:{get:async()=>{throw Error('socket hang up cookie=SECRET');}}});
  await assert.rejects(fetchImpl(historyURL('BK0001')),e=>e.cause.code==='ECONNRESET'&&!e.message.includes('SECRET'));
});
test('目录按total核齐所有分页，服务端每页少于请求值也不丢页',async()=>{
  const seen=[],result=await loadSectorCatalog('industry',{fetchImpl:async url=>{const page=Number(url.searchParams.get('pn'));seen.push(page);return ok({total:5,diff:page===1?[row(1),row(2)]:page===2?[row(3),row(4)]:[row(5)]});}});
  assert.deepEqual(seen,[1,2,3]);assert.equal(result.entries.length,5);assert.equal(result.pages,3);assert.equal(result.total,5);
});
test('重复、缺页、总数变化或HTTP拦截拒绝给出不完整全量目录',async()=>{
  for(const mode of ['duplicate','empty','changed','blocked']){
    await assert.rejects(loadSectorCatalog('concept',{fetchImpl:async url=>{const page=Number(url.searchParams.get('pn'));if(page===1)return ok({total:4,diff:[row(1),row(2)]});if(mode==='blocked')return{ok:false,status:429};return ok({total:mode==='changed'?5:4,diff:mode==='duplicate'?[row(2),row(3)]:[]});}}));
  }
});
