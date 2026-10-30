// 用户已授权更换公开板块数据源；行情只用于板块排名，成分接口只保留代码/名称。
import fs from 'node:fs/promises';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {createHash,randomBytes} from 'node:crypto';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {normalizeBars,rankHistoricalSectors,validateLookback,validDay} from './period.mjs';
import {memberTarget,validateMemberScope,memberScopeLabel} from './member-scope.mjs';

export const TENCENT_SOURCE='tencent-sector-history';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const sdk=path.join(root,'node_modules/westock-data-clawhub/scripts/index.js');
const bridge=path.join(root,'script/tencent-sdk-bridge.mjs');
const SDK_HASH='e35d828669d1e106d3baa9e290076cc56e334b2d39695d2eb6bae40ef81a524a';
export const isTencentBoard=code=>/^pt(?:01\d{6}|02[A-Z0-9]{6})$/.test(code||'');
const today=time=>new Date(time).toLocaleDateString('sv-SE',{timeZone:'Asia/Shanghai'});
const boardURL=code=>'https://stockapp.finance.qq.com/mstats/#mod=list&id='+code;
export function tencentCatalogURL(kind,offset=0){
 if(!['industry','concept'].includes(kind)||!Number.isInteger(offset)||offset<0)throw Error('腾讯板块目录参数错误');
 const u=new URL('https://proxy.finance.qq.com/cgi/cgi-bin/rank/pt/getRank');
 u.search=new URLSearchParams({board_type:kind==='industry'?'hy2':'gn',sort_type:'priceRatio',direct:'down',offset:String(offset),count:'200'});return u;
}
async function publicJSON(url,{signal,fetchImpl=fetch}={}){
 let response;try{response=await fetchImpl(url,{signal:signal?AbortSignal.any([signal,AbortSignal.timeout(10000)]):AbortSignal.timeout(10000),redirect:'error'});}catch(e){throw Error('腾讯公开板块请求失败：'+String(e.cause?.code||e.name||'NETWORK').replace(/[^a-zA-Z0-9_]/g,'').slice(0,60));}
 if(!response.ok)throw Error(`腾讯公开板块HTTP ${response.status}，停止本批，不重试`);
 const text=await response.text();if(text.length>4000000)throw Error('腾讯板块响应过大');
 let data;try{data=JSON.parse(text);}catch{throw Error('腾讯板块返回非JSON，停止本批');}
 if(data.code!==0)throw Error('腾讯板块服务返回错误，停止本批');return data.data;
}
export async function loadTencentCatalog(kind,options={}){
 const cacheDir=options.cacheDir===false?null:options.cacheDir||(!options.fetchImpl?path.join(root,'历史缓存/板块目录'):null),now=options.now?options.now():Date.now();
 const cacheFile=cacheDir?path.join(cacheDir,kind+'.json'):null;
 if(cacheFile&&!options.refreshCache)try{const c=JSON.parse(await fs.readFile(cacheFile,'utf8')),age=now-Date.parse(c.fetchedAt);if(c.schemaVersion===1&&c.kind===kind&&c.source==='tencent-public-sector-catalog'&&age>=0&&age<30*60000&&today(now)===today(Date.parse(c.fetchedAt))&&c.total===c.entries?.length&&c.total>0&&new Set(c.entries.map(e=>e.code)).size===c.total&&c.entries.every(e=>isTencentBoard(e.code)&&e.name&&e.kind===kind&&e.source===TENCENT_SOURCE&&(kind==='industry'?e.code.startsWith('pt01'):e.code.startsWith('pt02'))))return{...c,cacheHit:true};}catch(e){if(e.code!=='ENOENT'&&!(e instanceof SyntaxError))throw e;}
 const entries=[],seen=new Map();let total,pages=0,offset=0;
 for(;;){
  const data=await publicJSON(tencentCatalogURL(kind,offset),options),rows=data?.rank_list;
  if(!Number.isInteger(data?.total)||data.total<=0||!Array.isArray(rows)||!rows.length||(total!==undefined&&data.total!==total))throw Error('腾讯目录总数、分页或响应异常');
  total=data.total;
  const pageSeen=new Set();for(const row of rows){
   if(!isTencentBoard(row.code)||!row.name||pageSeen.has(row.code)||(kind==='industry'?row.stock_type!=='BK-HY-2':!/^BK-GN(?:-|$)/.test(row.stock_type)))throw Error('腾讯目录身份、类型或单页重复');
   pageSeen.add(row.code);if(seen.has(row.code)){if(seen.get(row.code)!==row.name)throw Error('腾讯目录同代码名称发生冲突');continue;}
   seen.set(row.code,row.name);entries.push({code:row.code,name:row.name,kind,source:TENCENT_SOURCE,url:boardURL(row.code)});
  }
  pages++;if(entries.length===total)break;
  if(entries.length>total||offset+rows.length>=total||pages>=100)throw Error('腾讯目录分页重复或缺项，未与总数核齐');
  // 目录只取名称/代码。盘中排名边界会变化：每页200条、最多150条重叠，单次遍历核齐total；缺项停止，不重试或换源。
  offset+=Math.max(1,rows.length-150);
 }
 const catalog={schemaVersion:1,kind,source:'tencent-public-sector-catalog',entries,total,pages,fetchedAt:new Date(now).toISOString(),cacheHit:false};
 if(cacheFile)await atomic(cacheFile,catalog);return catalog;
}
export async function loadTencentMembers(sector,{limit=10,allMembers=false,memberPercent,...options}={}){
 if(!isTencentBoard(sector.code)||sector.source!==TENCENT_SOURCE)throw Error('成分股必须对应本次腾讯板块');
 const scope={limit,allMembers,memberPercent};validateMemberScope(scope);
 const paged=allMembers||memberPercent!=null,count=paged?200:limit,items=[],seen=new Map();let total,target,offset=0,pages=0;
 for(;;){
  options.signal?.throwIfAborted();
  const u=new URL('https://proxy.finance.qq.com/cgi/cgi-bin/rank/hs/getBoardRankList');
  u.search=new URLSearchParams({_appver:'11.17.0',board_code:sector.code,sort_type:'priceRatio',direct:'down',offset:String(offset),count:String(count)});
  const data=await publicJSON(u,options),rows=data?.rank_list;
  if(!Number.isInteger(data?.total)||data.total<=0||total!==undefined&&data.total!==total||!Array.isArray(rows)||rows.length!==Math.min(count,data.total-offset))throw Error('腾讯板块成分目录不完整或分页总数变化');
  total=data.total;target=memberTarget(total,scope);const pageSeen=new Set();
  for(const r of rows){
   if(!/^(sh|sz|bj)\d{6}$/.test(r.code)||!r.name||pageSeen.has(r.code))throw Error('成分代码、名称或唯一性异常');pageSeen.add(r.code);
   if(seen.has(r.code)){if(seen.get(r.code)!==r.name)throw Error('同一成分代码名称冲突');continue;}
   seen.set(r.code,r.name);
   // 只带出代码、名称和所属市场；报价始终读所选网站可见页面。
   items.push({code:r.code.slice(2),market:r.code.slice(0,2),name:r.name,url:`https://quote.eastmoney.com/${r.code}.html`,membershipSource:TENCENT_SOURCE,membershipSector:sector.code});
  }
  pages++;if(items.length>total)throw Error('腾讯板块成分数超过声明总数');if(items.length>=target)break;
  if(items.length>total||offset+rows.length>=total)throw Error('腾讯板块成分分页缺项，未与总数核齐；停止本批，不将部分名单当全量');
  // 涨幅顺序盘中会变化：重叠150条防止分页边界漂移，单次遍历仍须核齐total。
  offset+=Math.max(1,rows.length-150);
 }
 const selected=items.slice(0,target);
 return{sector:sector.code,source:TENCENT_SOURCE,total,selectedCount:selected.length,targetCount:target,allMembers,...(memberPercent!=null?{memberPercent}:{}),pages,order:'腾讯成分表当日涨幅降序，'+memberScopeLabel(scope)+'；分页重叠去重，核齐所需数量；其报价不用于初筛',items:selected,fetchedAt:new Date().toISOString()};
}
let verifiedSDK=false;
export function parseTencentBars(rows,asOf){
 if(!Array.isArray(rows))throw Error('板块历史结构异常');const seen=new Set();
 const sorted=rows.map(r=>{const close=Number(r.close);if(!validDay(r.date)||r.date>asOf||seen.has(r.date)||r.close===null||r.close===''||!Number.isFinite(close)||close<0)throw Error('板块历史日期重复或收盘字段无效');seen.add(r.date);return{date:r.date,close};}).sort((a,b)=>a.date.localeCompare(b.date));
 // 新建概念的历史起点以前，腾讯以连续0填充；0不能参与收益计算，也不能跳过中途缺口。
 let leadingZeroBars=0;while(sorted[leadingZeroBars]?.close===0)leadingZeroBars++;
 const active=sorted.slice(leadingZeroBars);if(active.some(r=>r.close===0))throw Error('板块有效历史中途出现零值缺口');
 return{bars:active.length?normalizeBars(active).slice(-31):[],leadingZeroBars};
}
export async function sdkDailyBatch(codes,{signal,spawnImpl=spawn}={}){
 if(!codes.length||codes.length>3||codes.some(c=>!isTencentBoard(c))||new Set(codes).size!==codes.length)throw Error('SDK批次仅允许1—3个唯一板块');
 if(!verifiedSDK){let data;try{data=await fs.readFile(sdk);}catch{throw Error('缺少已固定版本的腾讯数据SDK，请运行 npm ci --ignore-scripts');}if(createHash('sha256').update(data).digest('hex')!==SDK_HASH)throw Error('腾讯SDK版本校验不一致，停止');verifiedSDK=true;}
 const env={SCREENING_BOARD_CODES:JSON.stringify(codes)};
 for(const key of ['SystemRoot','WINDIR','TEMP','TMP','PATH','HTTP_PROXY','HTTPS_PROXY','ALL_PROXY','NO_PROXY'])if(process.env[key])env[key]=process.env[key];
 const args=['--permission','--allow-fs-read='+path.dirname(path.dirname(sdk)),'--allow-fs-read='+bridge,'--allow-fs-read='+path.join(root,'package.json'),'--import',pathToFileURL(bridge).href,sdk,'kline',codes.join(','),'--period','day','--limit','45','--fq','bfq'];
 const stdout=await new Promise((resolve,reject)=>{
  const child=spawnImpl(process.execPath,args,{cwd:root,windowsHide:true,shell:false,env,stdio:['ignore','pipe','pipe'],signal});let output='',settled=false;
  const timer=setTimeout(()=>{child.kill();finish(Error('腾讯SDK板块日线请求超时，停止本批'));},15000);
  const finish=(err)=>{if(settled)return;settled=true;clearTimeout(timer);err?reject(err):resolve(output);};
  child.stdout.on('data',b=>{output+=b.toString();if(output.length>1000000){child.kill();finish(Error('SDK板块输出超过限制'));}});
  child.stderr.on('data',()=>{}); // 不存储SDK原始错误，避免鉴权参数进入日志。
  child.on('error',()=>finish(Error(signal?.aborted?'板块历史已中止':'腾讯SDK未能启动')));
  child.on('close',code=>finish(code===0?null:Error('腾讯SDK板块日线失败，停止本批')));
 });
 signal?.throwIfAborted();const records=stdout.trim().split(/\r?\n/).filter(line=>line.startsWith('BOARD_DAILY ')).map(line=>JSON.parse(line.slice(12)));
 if(records.length!==codes.length||new Set(records.map(r=>r.code)).size!==codes.length||records.some(r=>!codes.includes(r.code)||!Array.isArray(r.bars)))throw Error('腾讯SDK没有返回完整板块日线，停止本批');return records;
}
async function atomic(file,value){await fs.mkdir(path.dirname(file),{recursive:true});const tmp=file+'.'+randomBytes(3).toString('hex')+'.tmp';await fs.writeFile(tmp,JSON.stringify(value));await fs.rename(tmp,file);}
const shortCacheMs=30*60*1000,closedCacheMs=7*86400000;
export class TencentHistoryProvider{
 constructor({cacheDir=path.join(root,'历史缓存/腾讯'),signal,refresh=false,now=Date.now,catalogLoader=loadTencentCatalog,batchLoader=sdkDailyBatch,onCatalog=async()=>{},onProgress=()=>{}}={}){Object.assign(this,{cacheDir,signal,refresh,now,catalogLoader,batchLoader,onCatalog,onProgress});}
 async collect(days){
  validateLookback(days);if(days===1)throw Error('近期数据源用于15/30日排名');this.signal?.throwIfAborted();const catalogs=[];
  for(const kind of ['industry','concept']){const c=await this.catalogLoader(kind,{signal:this.signal});if(c.kind!==kind||!c.entries?.length||c.entries.length!==c.total||c.entries.some(e=>e.kind!==kind||e.source!==TENCENT_SOURCE||!isTencentBoard(e.code)||!(kind==='industry'?e.code.startsWith('pt01'):e.code.startsWith('pt02'))))throw Error('行业和概念目录必须各自取全且来源一致');catalogs.push(c);this.onProgress({stage:'catalog',kind,count:c.total,pages:c.pages});}
  await this.onCatalog(catalogs);const sectors=catalogs.flatMap(c=>c.entries),date=today(this.now()),entries=[],missing=[],candidates=new Map();
  if(new Set(sectors.map(s=>s.code)).size!==sectors.length)throw Error('行业/概念目录重复');
  const daysOnDisk=this.refresh?[]:await fs.readdir(this.cacheDir).catch(e=>{if(e.code==='ENOENT')return[];throw e;});
  const cacheDays=[date,...daysOnDisk.filter(d=>validDay(d)&&d<date&&Date.parse(date)-Date.parse(d)<=closedCacheMs).sort().reverse()];
  for(const sector of sectors){
   if(this.refresh)break;
   for(const cacheDay of cacheDays){
    let c;try{c=JSON.parse(await fs.readFile(path.join(this.cacheDir,cacheDay,sector.code+'.json'),'utf8'));}catch(e){if(e.code==='ENOENT'||e instanceof SyntaxError)continue;throw e;}
    const age=this.now()-Date.parse(c.fetchedAt);if(c.source!==TENCENT_SOURCE||c.schemaVersion!==1||c.code!==sector.code||!Number.isFinite(age)||age<0||age>closedCacheMs||!Array.isArray(c.bars))continue;
    const bars=c.bars.length?normalizeBars(c.bars):[];if(bars.some(b=>b.date>date))throw Error('板块缓存有未来日期');
    candidates.set(sector.code,{...c,bars,fresh:cacheDay===date&&age<shortCacheMs});break;
   }
  }
  let reference,closedCacheValidated=false;
  if([...candidates.values()].some(c=>!c.fresh)){
   // 过期缓存只在在线核对一个已有行业指数的完整31根收盘值及截止日后，才能跨日复用。
   const sector=sectors.find(s=>s.kind==='industry'&&candidates.has(s.code))||sectors[0];
   const records=await this.batchLoader([sector.code],{signal:this.signal}),record=records.find(r=>r.code===sector.code);
   if(!record||record.name!==sector.name)throw Error('缓存在线核验的指数身份不符');
   reference={...sector,...parseTencentBars(record.bars,date),fetchedAt:new Date(this.now()).toISOString(),cacheHit:false};
   const old=candidates.get(sector.code),latest=reference.bars.at(-1)?.date;
   closedCacheValidated=!!(latest&&latest<date&&old&&JSON.stringify(old.bars)===JSON.stringify(reference.bars));
   this.onProgress({stage:'cache-check',asOf:latest||'',closedCacheValidated});
  }
  for(const sector of sectors){
   const c=candidates.get(sector.code),latest=c?.bars.at(-1)?.date,referenceDate=reference?.bars.at(-1)?.date;
   const dateMatches=!reference||!c?.bars.length||latest===referenceDate;
   if(c&&dateMatches&&(c.fresh||(closedCacheValidated&&latest===referenceDate))){entries.push({...sector,bars:c.bars,leadingZeroBars:c.leadingZeroBars||0,fetchedAt:c.fetchedAt,cacheHit:true,...(!c.fresh?{closedCacheValidatedAt:reference.fetchedAt}:{})});}
   else if(reference?.code===sector.code){entries.push(reference);await atomic(path.join(this.cacheDir,date,sector.code+'.json'),{schemaVersion:1,...reference});}
   else missing.push(sector);
  }
  const actualCacheHits=entries.filter(e=>e.cacheHit).length;
  this.onProgress({stage:'history',done:entries.length,total:sectors.length,cacheHits:actualCacheHits});
  for(let start=0;start<missing.length;start+=3){
   this.signal?.throwIfAborted();const group=missing.slice(start,start+3),records=await this.batchLoader(group.map(s=>s.code),{signal:this.signal});
   for(const sector of group){const r=records.find(r=>r.code===sector.code);if(!r||r.name!==sector.name)throw Error('板块日线名称/代码与目录不符');let parsed;try{parsed=parseTencentBars(r.bars,date);}catch(e){throw Error(`板块${sector.name}（${sector.code}）：${e.message}`);}const fetchedAt=new Date(this.now()).toISOString();const entry={...sector,...parsed,fetchedAt,cacheHit:false};entries.push(entry);await atomic(path.join(this.cacheDir,date,sector.code+'.json'),{schemaVersion:1,...entry});}
   this.onProgress({stage:'history',done:entries.length,total:sectors.length,cacheHits:actualCacheHits});
  }
  const asOf=entries.flatMap(e=>e.bars.length?[e.bars.at(-1).date]:[]).sort().at(-1);if(!asOf)throw Error('板块日线为空');
  const ranking=rankHistoricalSectors(entries,days,{asOf,expectedCount:sectors.length});if(!ranking.eligibleCount)throw Error('板块历史不足，不能排名');
  const evidence={source:TENCENT_SOURCE,validated:true,lookback:days,asOf,calendarAsOf:date,catalogCoverage:'腾讯申万二级行业与概念完整分页，逐条核齐接口total',catalogs:catalogs.map(c=>({kind:c.kind,count:c.total,pages:c.pages,source:c.source})),universeCount:sectors.length,eligibleCount:ranking.eligibleCount,excludedCount:ranking.excluded.length,historyFailures:0,cacheHits:actualCacheHits,cacheMaxAgeMinutes:closedCacheValidated?7*24*60:30,cachePolicy:closedCacheValidated?'旧收盘缓存最多7天，每次在线核对参考行业指数完整31根收盘值及截止日；其余板块截止日逐一匹配':'当日缓存最长30分钟',closedCacheValidated,referenceCheck:reference?{code:reference.code,endDate:reference.bars.at(-1)?.date,fetchedAt:reference.fetchedAt}:null,fetchedAt:new Date(this.now()).toISOString(),sha256:createHash('sha256').update(JSON.stringify(entries)).digest('hex')};
  return{ranking,evidence,entries};
 }
}
