export const ORIGIN = 'https://quote.eastmoney.com';
export const KEYS = ['shape', 'nearMA20', 'ma20Above60', 'redVolume'];
export function rankingKind(raw){
  const u=new URL(safeQuoteURL(raw));
  return /^\/center\//.test(u.pathname)?u.hash.match(/^#(industry|concept)_board$/)?.[1]||null:null;
}
export function stockIdentity(snapshot,code,name){
  const u=new URL(safeQuoteURL(snapshot.url));
  const actual=u.pathname.match(/\/unify\/r\/[012]\.(\d{6})$/)?.[1]||u.pathname.match(/\/(?:(?:kcb|bj)\/|sh|sz|bj|[03]\.)?(\d{6})\.html$/)?.[1];
  const title=String(snapshot.title||'');
  return actual===code&&(title.includes(code)||Boolean(name?.trim()&&title.includes(name.trim())));
}
export function sectorCode(raw) {
  const u=new URL(safeQuoteURL(raw));
  const path=u.pathname.match(/\/(?:unify\/r\/90\.|bk\/90\.)(BK\d{4})(?:\.html)?$/i);
  const hash=/^\/center\//.test(u.pathname)&&u.hash.match(/^#boards[123]?-(?:90\.)?(BK\d{4})$/i);
  return (path?.[1]||hash?.[1]||'').toUpperCase();
}
export function sameSectorPage(a,b) {
  const ca=sectorCode(a),cb=sectorCode(b);
  if(ca&&cb)return ca===cb;
  const x=new URL(safeQuoteURL(a)),y=new URL(safeQuoteURL(b));
  return x.pathname===y.pathname&&x.hash===y.hash;
}
export function safeQuoteURL(raw) {
  const u = new URL(raw, ORIGIN);
  if (u.origin !== ORIGIN || u.username || u.password) throw Error('只允许同源东方财富行情页面');
  if (!/^\/(center(?:\/|$)|bk\/|unify\/r\/(?:90\.BK\d{4}|[012]\.\d{6})$|(?:kcb|bj)\/\d{6}\.html$|(?:sh|sz|bj)\d{6}\.html$|(?:[03]\.)?\d{6}\.html$)/i.test(u.pathname)) {
    throw Error('页面不在板块/个股行情允许范围内');
  }
  return u.href;
}
export function number(text) {
  const s = String(text ?? '').replace(/[,，\s%]/g, '');
  return /^[+-]?\d+(?:\.\d+)?$/.test(s) ? Number(s) : null;
}
export function leaders(snapshot){
  const valid=[];
  for(const t of snapshot.tables){
    const names=t.columns.findIndex(c=>/板块名称/.test(c)),rates=t.columns.findIndex(c=>/涨跌幅/.test(c)),rank=t.columns.findIndex(c=>/排名/.test(c));
    if(names<0||rates<0||rank<0)continue;
    for(const r of t.rows){const rate=number(r.cells[rates]);if(rate===null||!r.cells[names]||!r.links[names]?.length)continue;valid.push({rank:number(r.cells[rank]),name:r.cells[names],rate,url:safeQuoteURL(r.links[names][0].url)});}
  }
  if(!valid.some(r=>r.rank===1))throw Error('榜首和表头必须同时可见；请回到榜单顶部');
  return valid;
}
export function prefilter(row) {
  const price = number(row.price), open = number(row.open);
  if (!/^\d{6}$/.test(String(row.code||'')) || price === null || open === null || price <= 0 || open <= 0) return '待确认';
  return price > open ? '通过初筛' : '淘汰';
}
export function extractStocks(snapshot, limit=10) {
  const col=(cs,re)=>cs.findIndex(c=>re.test(c.replace(/[\s↑↓▲▼]/g,'')));
  const tables=snapshot.tables.map(t=>({t,code:col(t.columns,/^(股票)?代码$/),name:col(t.columns,/^(股票)?名称$/),price:col(t.columns,/^(最新价|现价)$/),open:col(t.columns,/^(今开|今开盘|开盘价)$/)})).filter(x=>[x.code,x.name,x.price,x.open].every(i=>i>=0));
  if(tables.length!==1)throw Error('找不到唯一且同时可见代码/名称/现价/今开的表。请先横向滚动显示全部四列。');
  const {t,code,name,price,open}=tables[0], seen=new Set(), out=[];
  for(const r of t.rows){
    const c=r.cells[code]?.trim(); if(!/^\d{6}$/.test(c)||seen.has(c))continue;
    seen.add(c);
    let url=null;
    for(const l of (r.links[name]||[])) {try {url=safeQuoteURL(l.url);break;}catch{}}
    out.push({code:c,name:r.cells[name],price:r.cells[price],open:r.cells[open],url,quoteAt:snapshot.at,quoteRect:r.rect});
    if(out.length>=Math.min(10,limit))break;
  }
  if(!out.length)throw Error('视口中没有完整可读的股票行');
  return out;
}
export function decision(item, sectorConfirmed = false) {
  if (prefilter(item) === '淘汰') return {status:'淘汰', reason:'可见现价≤今开'};
  if (prefilter(item) !== '通过初筛') return {status:'待确认', reason:'可见报价不完整'};
  const review = item.review || {};
  if (item.evidence?.chart && review.evidenceConfirmed && review.reviewer?.trim()) {
    const fail = KEYS.find(k => review[k] === 'fail');
    if (fail) return {status:'淘汰', reason:review.reason || `视觉条件不符：${fail}`};
  }
  if (!sectorConfirmed) return {status:'待确认', reason:'行业/概念最强板块及交易时点未确认；验收样本不作正式符合结果'};
  if (!item.evidence?.chart || !review.evidenceConfirmed || !review.reviewer?.trim()) return {status:'待确认', reason:item.captureError || '15分钟、最新日期、MA5/10/20/60与完整量柱待目视确认'};
  if (KEYS.every(k => review[k] === 'pass')) return {status:'符合', reason:review.reason || '四项视觉条件全部通过'};
  return {status:'待确认', reason:review.reason || '尚有模糊或未检查的视觉条件'};
}
