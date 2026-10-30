// 板块强度的区间收益口径。这里只处理已提供的历史指数数据，不访问任何数据接口。
export const PERIODS=[1,15,30];
export const validSectorCode=code=>/^(BK\d{4}|pt01\d{6}|pt02[A-Z0-9]{6})$/.test(code||'');
export function validateLookback(value){const n=Number(value);if(!PERIODS.includes(n))throw Error('lookback仅支持1、15或30个交易日');return n;}
export function periodLabel(days){return days===1?'当日涨幅':`近${days}个交易日累计涨幅`;}
export function validDay(value){const ms=Date.parse(value);return typeof value==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(value)&&Number.isFinite(ms)&&new Date(ms).toISOString().slice(0,10)===value;}
export function normalizeBars(bars){
  if(!Array.isArray(bars)||!bars.length)throw Error('历史指数数据为空');
  const seen=new Set();
  const result=bars.map(b=>{
    const close=Number(b.close);
    if(!validDay(b.date)||!Number.isFinite(close)||close<=0||seen.has(b.date))throw Error('历史指数日期重复、格式异常或收盘字段无效');
    seen.add(b.date);return{date:b.date,close};
  });
  return result.sort((a,b)=>a.date.localeCompare(b.date));
}
export function periodReturn(bars,days,{asOf}={}){
  validateLookback(days);if(asOf&&!validDay(asOf))throw Error('区间截止日期无效');
  if(Array.isArray(bars)&&!bars.length)return{eligible:false,reason:`需要${days+1}个有效交易日收盘值，实际无日K历史`,availableBars:0};
  const normalized=normalizeBars(bars),eligible=asOf?normalized.filter(b=>b.date<=asOf):normalized;
  if(eligible.length<days+1)return{eligible:false,reason:`需要${days+1}个有效交易日收盘值，实际仅${eligible.length}个`,availableBars:eligible.length};
  const end=eligible.at(-1),base=eligible.at(-days-1);
  return{eligible:true,lookback:days,baseDate:base.date,firstReturnDate:eligible.at(-days).date,endDate:end.date,baseClose:base.close,endClose:end.close,rate:(end.close/base.close-1)*100,definition:`最新日K收盘字段 / ${days}个交易日前收盘字段 - 1；盘中最新日K值可能尚未收盘`};
}
export function rankHistoricalSectors(entries,days,{asOf,expectedCount}={}){
  validateLookback(days);
  if(!Array.isArray(entries)||!entries.length)throw Error('板块历史样本为空');
  if(expectedCount!==undefined&&entries.length!==expectedCount)throw Error('历史板块覆盖不完整，不能宣称全范围强弱排名');
  const seen=new Set(),ranked=[],excluded=[];
  for(const entry of entries){
    if(!validSectorCode(entry.code)||!entry.name||!['industry','concept'].includes(entry.kind)||seen.has(entry.code))throw Error('板块代码、类型、名称或唯一性异常');
    seen.add(entry.code);
    if(entry.error)throw Error(`板块${entry.name}历史数据获取失败，停止不完整排名：${entry.error}`);
    const metric=periodReturn(entry.bars,days,{asOf});
    if(!metric.eligible){excluded.push({code:entry.code,name:entry.name,kind:entry.kind,...metric});continue;}
    if(asOf&&metric.endDate!==asOf)throw Error(`板块${entry.name}最新数据停在${metric.endDate}，与截止${asOf}不一致`);
    ranked.push({code:entry.code,name:entry.name,kind:entry.kind,source:entry.source||'eastmoney-index-history',indexCode:entry.indexCode||'',url:entry.url||`https://quote.eastmoney.com/unify/r/90.${entry.code}`,...metric});
  }
  const ends=new Set(ranked.map(r=>r.endDate));if(ends.size>1)throw Error('板块截止交易日不同，不能混排');
  ranked.sort((a,b)=>b.rate-a.rate||a.code.localeCompare(b.code));ranked.forEach((r,n)=>r.rank=n+1);
  return{lookback:days,label:periodLabel(days),universeLabel:entries.every(e=>e.source==='tencent-sector-history')?'腾讯申万二级行业/概念合并':'行业/概念两榜合并',asOf:[...ends][0]||asOf||'',totalUniverse:entries.length,eligibleCount:ranked.length,excluded,ranked};
}
export function selectHistoricalSector(ranking,rank){
  const picked=ranking.ranked[rank-1];if(!picked)throw Error('有完整历史数据的板块不足以选择该名次');
  if(ranking.ranked.some((r,n)=>n!==rank-1&&Math.abs(r.rate-picked.rate)<1e-10))throw Error('目标近期名次并列，不能擅自打破并列');
  return{...picked,selectionRank:rank,selection:`${ranking.universeLabel||'行业/概念两榜合并'}${ranking.label}`,confirmed:false};
}
