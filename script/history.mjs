// 用户2026-10-25明确授权：仅板块排序可读取东方财富公开历史指数；个股仍只看新截图。
// 历史字段参照AKShare开源适配：https://github.com/akfamily/akshare/blob/main/akshare/stock/stock_board_concept_em.py
import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash,randomBytes} from 'node:crypto';
import {normalizeBars,rankHistoricalSectors,validDay,validateLookback} from './period.mjs';

export const HISTORY_SOURCE='eastmoney-index-history';
const endpoint='https://91.push2his.eastmoney.com/api/qt/stock/kline/get';
const today=(time=Date.now())=>new Date(time).toLocaleDateString('sv-SE',{timeZone:'Asia/Shanghai'});
export function historyURL(code,date=today()){
  if(!/^BK\d{4}$/.test(code))throw Error('只允许板块指数代码，不能用本模块获取个股数据');
  if(!validDay(date))throw Error('历史指数请求日期无效');
  const start=new Date(date+'T00:00:00Z');start.setUTCDate(start.getUTCDate()-120);
  const url=new URL(endpoint);url.search=new URLSearchParams({secid:'90.'+code,klt:'101',fqt:'0',beg:start.toISOString().slice(0,10).replaceAll('-',''),end:date.replaceAll('-',''),lmt:'45',fields1:'f1,f2,f3,f4,f5,f6',fields2:'f51,f52,f53,f54,f55,f56,f57,f58,f59,f60,f61'});
  return url;
}
export function parseHistory(payload,code,{asOf=today()}={}){
  if(payload?.rc!==0)throw Error('历史指数服务返回错误，不能以当日涨幅代替');
  if(payload.data===null)throw Error('历史服务未返回该板块数据，不能当作历史不足而静默排除');
  if(String(payload.data?.code)!==code||!Array.isArray(payload.data?.klines))throw Error('历史指数身份或日K字段异常');
  if(!payload.data.klines.length)return[];
  const bars=payload.data.klines.map(line=>{const columns=String(line).split(',');return{date:columns[0],close:Number(columns[2])};});
  const normalized=normalizeBars(bars);if(normalized.some(b=>b.date>asOf))throw Error('历史指数出现未来日期，停止');
  return normalized.slice(-31);
}
async function atomic(file,value){await fs.mkdir(path.dirname(file),{recursive:true});const temp=file+'.'+randomBytes(3).toString('hex')+'.tmp';await fs.writeFile(temp,JSON.stringify(value,null,2));await fs.rename(temp,file);}
export class SectorHistoryProvider{
  constructor({catalogLoader,cacheDir,signal,fetchImpl=(...args)=>fetch(...args),concurrency=3,refresh=false,now=Date.now,onProgress=()=>{},onCatalog=async()=>{}}){
    if(!Number.isInteger(concurrency)||concurrency<1||concurrency>3)throw Error('历史数据并发上限为3');
    Object.assign(this,{catalogLoader,cacheDir,signal,fetchImpl,concurrency,refresh,now,onProgress,onCatalog});
  }
  async one(sector,batchSignal){
    const date=today(this.now()),file=path.join(this.cacheDir,date,sector.code+'.json');
    if(!this.refresh){
      try{
        const cached=JSON.parse(await fs.readFile(file,'utf8')),age=this.now()-Date.parse(cached.fetchedAt);
        if(cached.schemaVersion===2&&cached.source===HISTORY_SOURCE&&cached.code===sector.code&&age>=0&&age<30*60*1000&&Array.isArray(cached.bars)){
          const bars=cached.bars.length?normalizeBars(cached.bars):[];
          if(bars.some(b=>b.date>date))throw Error('缓存包含未来日期');
          return{...sector,bars,fetchedAt:cached.fetchedAt,cacheHit:true};
        }
      }catch{}
    }
    batchSignal.throwIfAborted();
    const signal=AbortSignal.any([batchSignal,AbortSignal.timeout(10000)]),url=historyURL(sector.code,date);
    let response;try{response=await this.fetchImpl(url,{signal,headers:{Accept:'application/json'}});}catch(e){
      const code=String(e.cause?.code||e.code||e.name).replace(/[^a-zA-Z0-9_]/g,'').slice(0,60);
      const reason=code==='UND_ERR_SOCKET'?'远端断开连接，可能为站点拦截或网络/代理问题':/TIMEOUT|Timeout/.test(code)?'请求超时':'网络请求未成功';
      throw Error(`板块${sector.name}历史请求失败：${code}（${reason}）；停止本轮，不自动重试或切回当日排行`);
    }
    if(!response.ok)throw Error(`板块历史服务HTTP ${response.status}；停止本轮，不自动绕过拦截`);
    let payload;try{payload=await response.json();}catch{throw Error('板块历史服务未返回JSON，可能需要人工验证；停止');}
    batchSignal.throwIfAborted();const bars=parseHistory(payload,sector.code,{asOf:date}),fetchedAt=new Date(this.now()).toISOString();
    await atomic(file,{schemaVersion:2,source:HISTORY_SOURCE,code:sector.code,name:sector.name,kind:sector.kind,fetchedAt,bars});
    return{...sector,bars,fetchedAt,cacheHit:false};
  }
  async collect(days){
    validateLookback(days);if(days===1)throw Error('当日模式应使用页面当日榜单');
    this.signal?.throwIfAborted();const catalogs=[];
    // 完整板块目录逐页校验；CLI使用同一专用会话的公开目录接口并核对total，不用当日榜首冒充全量。
    for(const kind of ['industry','concept']){
      const catalog=await this.catalogLoader(kind);
      if(!Array.isArray(catalog.entries)||!catalog.entries.length||!Number.isInteger(catalog.pages)||catalog.pages<1)throw Error('行业/概念目录不完整');
      catalogs.push({...catalog,kind});
      this.onProgress({stage:'catalog',kind,count:catalog.entries.length,pages:catalog.pages});
    }
    await this.onCatalog(catalogs);
    const unique=new Map();for(const catalog of catalogs)for(const entry of catalog.entries){
      if(!/^BK\d{4}$/.test(entry.code)||!entry.name)throw Error('板块目录代码或名称无效');
      if(unique.has(entry.code))throw Error('行业与概念目录出现重复板块，不能确认完整范围');
      unique.set(entry.code,{...entry,kind:catalog.kind});
    }
    const sectors=[...unique.values()];if(!sectors.length)throw Error('行业/概念完整目录为空');
    const batch=new AbortController(),signal=this.signal?AbortSignal.any([this.signal,batch.signal]):batch.signal,entries=Array(sectors.length);let next=0,done=0,failure;
    await Promise.all(Array.from({length:Math.min(this.concurrency,sectors.length)},async()=>{
      while(!signal.aborted){const index=next++;if(index>=sectors.length)return;
        try{entries[index]=await this.one(sectors[index],signal);done++;this.onProgress({done,total:sectors.length,cacheHits:entries.filter(e=>e?.cacheHit).length});}
        catch(e){failure??=e;batch.abort(e);return;}
      }
    }));
    if(failure)throw failure;this.signal?.throwIfAborted();
    const endDates=entries.flatMap(e=>e.bars.length?[e.bars.at(-1).date]:[]).sort(),asOf=endDates.at(-1);
    if(!asOf)throw Error('没有任何可用板块日K历史');
    const ranking=rankHistoricalSectors(entries,days,{asOf,expectedCount:sectors.length});
    if(!ranking.ranked.length)throw Error(`没有具有完整${days}个交易日历史的板块`);
    const evidence={source:HISTORY_SOURCE,validated:true,lookback:days,asOf,calendarAsOf:today(this.now()),catalogCoverage:catalogs.every(c=>c.source==='eastmoney-public-sector-catalog')?'东方财富公开板块目录全部分页，与接口total逐条核齐':'注入目录；完整性由catalogLoader提供',catalogs:catalogs.map(c=>({kind:c.kind,count:c.entries.length,pages:c.pages,source:c.source||'injected'})),universeCount:sectors.length,eligibleCount:ranking.eligibleCount,excludedCount:ranking.excluded.length,historyFailures:0,cacheHits:entries.filter(e=>e.cacheHit).length,cacheMaxAgeMinutes:30,fetchedAt:new Date(this.now()).toISOString(),sha256:createHash('sha256').update(JSON.stringify(entries)).digest('hex')};
    return{ranking,evidence,entries};
  }
}
