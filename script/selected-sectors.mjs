import fs from 'node:fs/promises';
import path from 'node:path';
import {loadTencentCatalog,loadTencentMembers,isTencentBoard,TENCENT_SOURCE} from './tencent-history.mjs';
import {validDay} from './period.mjs';
import {memberTarget,validateMemberScope} from './member-scope.mjs';

export const selectionDay=()=>new Date().toLocaleDateString('sv-SE',{timeZone:'Asia/Shanghai'});
export function selectionEntries(input){
 const rows=typeof input==='string'?input.split(/[,，;；\n]/):input;
 if(!Array.isArray(rows)||!rows.length)throw Error('尚未指定板块。请用 --sectors "板块名称1,板块名称2"，或填写板块名单.json；不再自动按--rank选板块');
 const entries=rows.map(row=>{
  if(typeof row==='string'){const value=row.trim();if(!value)throw Error('板块名单存在空项');return isTencentBoard(value)?{code:value}:{name:value};}
  if(!row||typeof row!=='object'||Array.isArray(row)||(!row.code&&!row.name))throw Error('每个板块须填名称或准确代码');
  if(row.code&&!isTencentBoard(row.code))throw Error('板块代码须为腾讯行业/概念代码pt01…或pt02…；不按同名板块转换其他来源代码');
  if(row.kind&&!['industry','concept'].includes(row.kind))throw Error('板块类型仅支持industry或concept');
  return{...(row.code?{code:row.code}:{}),...(row.name?{name:String(row.name).trim()}:{}),...(row.kind?{kind:row.kind}:{})};
 });
 if(entries.length>10)throw Error('一次最多指定10个板块');
 return entries;
}
export async function readSelection(cfg,{today=selectionDay()}={}){
 if(cfg.sectors)return{date:today,inputSource:'命令行指定',entries:selectionEntries(cfg.sectors)};
 const file=path.resolve(cfg.sectorsFile);let data;
 try{data=JSON.parse((await fs.readFile(file,'utf8')).replace(/^\uFEFF/,''));}catch(e){if(e.code==='ENOENT')throw Error('未找到板块名单，请用 --sectors "板块名称1,板块名称2"；不自动选择板块');throw Error('板块名单JSON读取失败：'+e.message);}
 if(!validDay(data.date)||data.date!==today)throw Error(`请更新板块名单日期为今天${today}，每天午盘重新确认名单；不会沿用其他日期的板块`);
 return{date:data.date,inputSource:file,entries:selectionEntries(data.sectors)};
}
export async function resolveSectors(selection,{catalogLoader=loadTencentCatalog,signal}={}){
 const catalogs=[];
 for(const kind of ['industry','concept']){
  const c=await catalogLoader(kind,{signal});
  if(c.kind!==kind||c.total!==c.entries?.length||!c.entries?.length||c.entries.some(e=>e.kind!==kind||e.source!==TENCENT_SOURCE||!isTencentBoard(e.code)))throw Error('板块名称/代码核对目录不完整或来源不符');
  catalogs.push(c);
 }
 const all=catalogs.flatMap(c=>c.entries);if(new Set(all.map(s=>s.code)).size!==all.length)throw Error('板块目录代码重复');
 const sectors=[];
 for(const requested of selection.entries){
  const matches=all.filter(s=>(!requested.code||s.code===requested.code)&&(!requested.name||s.name===requested.name)&&(!requested.kind||s.kind===requested.kind));
  if(matches.length!==1){
   const similar=requested.name?all.filter(s=>s.name.includes(requested.name)).slice(0,15):[];
   throw Error(matches.length?`板块名称“${requested.name}”不唯一，请用代码指定：${matches.map(s=>s.code+' '+s.name+' '+s.kind).join('；')}`:`板块“${requested.name||requested.code}”未精确匹配名称/代码，请核对来源及名称${similar.length?'；可核对：'+similar.map(s=>s.name+' '+s.code).join('；'):''}`);
  }
  if(!sectors.some(s=>s.code===matches[0].code))sectors.push(matches[0]);
 }
 return{sectors,catalogs};
}
export async function collectSelectedMembers(sectors,{limit=10,allMembers=false,memberPercent,memberLoader=loadTencentMembers,signal,onBoard=async()=>{}}={}){
 validateMemberScope({limit,allMembers,memberPercent});
 const groups=[],unique=new Map();
 for(const sector of sectors){
  signal?.throwIfAborted();const group=await memberLoader(sector,{limit,allMembers,memberPercent,signal});
  if(group.source!==TENCENT_SOURCE||group.sector!==sector.code||!Number.isInteger(group.total)||group.total<1||group.items?.length!==memberTarget(group.total,{limit,allMembers,memberPercent}))throw Error('指定板块成分数量或来源不符：'+sector.name);
  const seen=new Set();
  for(const item of group.items){
   if(!/^\d{6}$/.test(item.code)||!item.name||!['sh','sz','bj'].includes(item.market)||item.membershipSource!==TENCENT_SOURCE||item.membershipSector!==sector.code||item.url!==`https://quote.eastmoney.com/${item.market}${item.code}.html`||seen.has(item.code))throw Error('指定板块成分身份、来源或重复代码异常');
   seen.add(item.code);const existing=unique.get(item.code),membership={code:sector.code,name:sector.name,kind:sector.kind,source:TENCENT_SOURCE};
   if(existing){if(existing.name!==item.name||existing.market!==item.market||existing.url!==item.url)throw Error('同代码的股票名称/市场冲突，不能合并：'+item.code);existing.memberships.push(membership);}
   else unique.set(item.code,{code:item.code,name:item.name,market:item.market,url:item.url,membershipSource:TENCENT_SOURCE,membershipSector:sector.code,memberships:[membership],requireMarketDate:true,result:{status:'待确认',reason:'尚未读取可见报价'}});
  }
  groups.push({...group,name:sector.name,kind:sector.kind});await onBoard(groups.at(-1));
 }
 return{source:TENCENT_SOURCE,validated:true,sectors:sectors.map(s=>({code:s.code,name:s.name,kind:s.kind})),groups,items:[...unique.values()],totalMembershipRows:groups.reduce((n,g)=>n+g.total,0),selectedMembershipRows:groups.reduce((n,g)=>n+g.items.length,0)};
}
export function selectedMembershipConfirmed(run){
 try{validateMemberScope(run);}catch{return false;}
 const proof=run.membershipEvidence,sectors=run.sectors;
 if(run.selectionMode!=='specified-sectors'||proof?.validated!==true||proof.source!==TENCENT_SOURCE||!Array.isArray(sectors)||!sectors.length||proof.groups?.length!==sectors.length)return false;
 if(new Set(sectors.map(s=>s.code)).size!==sectors.length||new Set(run.items.map(i=>i.code)).size!==run.items.length)return false;
 const expected=new Map();
 for(const sector of sectors){
  const group=proof.groups.find(g=>g.sector===sector.code);
  if(sector.source!==TENCENT_SOURCE||!group||group.source!==TENCENT_SOURCE||group.name!==sector.name||group.kind!==sector.kind||!Number.isSafeInteger(group.total)||group.total<1||!Array.isArray(group.items)||group.items.length!==memberTarget(group.total,run))return false;
  for(const member of group.items){if(member.membershipSector!==sector.code||member.membershipSource!==TENCENT_SOURCE)return false;const refs=expected.get(member.code)||[];refs.push({sector,member});expected.set(member.code,refs);}
 }
 if(expected.size!==run.items.length)return false;
 return run.items.every(item=>{
  const refs=expected.get(item.code);return refs?.length===item.memberships?.length&&refs.every(({sector,member})=>member.name===item.name&&member.url===(item.membershipURL||item.url)&&member.market===item.market&&item.memberships.filter(m=>m.code===sector.code&&m.name===sector.name&&m.kind===sector.kind&&m.source===TENCENT_SOURCE).length===1);
 });
}
