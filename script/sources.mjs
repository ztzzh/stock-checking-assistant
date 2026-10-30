// 行情来源只影响可见报价和截图，不定义任何选股条件。
export const SOURCES=Object.freeze({
  eastmoney:{name:'东方财富',home:'https://quote.eastmoney.com/center/'},
  sina:{name:'新浪财经',home:'https://finance.sina.com.cn/realstock/company/sz000725/nc.shtml'}
});
export function sourceName(source='eastmoney'){if(typeof source!=='string'||!Object.hasOwn(SOURCES,source))throw Error('source仅支持eastmoney或sina');return SOURCES[source].name;}
export function sourceFromURL(raw){
  try{const u=new URL(raw);if(u.protocol!=='https:'||u.username||u.password)return null;
    if(u.origin==='https://quote.eastmoney.com'&&/^\/(?:(?:kcb|bj)\/|sh|sz|bj|[03]\.)?\d{6}\.html$|^\/unify\/r\/[012]\.\d{6}$/.test(u.pathname))return'eastmoney';
    if(u.origin==='https://finance.sina.com.cn'&&/^\/realstock\/company\/(?:sh|sz|bj)\d{6}\/nc\.shtml$/.test(u.pathname))return'sina';
  }catch{}return null;
}
export function stockURL(item,source='eastmoney'){
  sourceName(source);if(!/^\d{6}$/.test(item.code))throw Error('股票代码无效');
  let market=item.market;
  if(!market){try{const u=new URL(item.url);market=u.pathname.match(/(?:^\/|\/company\/)(sh|sz|bj)\d{6}/)?.[1]||(/^\/kcb\//.test(u.pathname)?'sh':/^\/bj\//.test(u.pathname)?'bj':null);}catch{}}
  if(!['sh','sz','bj'].includes(market))throw Error('股票交易所缺失，不能构造行情页面：'+item.code);
  return source==='sina'?`https://finance.sina.com.cn/realstock/company/${market}${item.code}/nc.shtml`:`https://quote.eastmoney.com/${market}${item.code}.html`;
}
export function safeSinaURL(raw){const u=new URL(raw);if(sourceFromURL(raw)!=='sina'||u.search||u.hash)throw Error('只允许新浪财经对应个股行情页面');return u.href;}
export function assignSource(item,source){
  const url=stockURL(item,source);item.membershipURL??=item.url;item.url=url;item.marketSource=source;return item;
}
export function assertCaptureSource(snapshot,source){
  if((snapshot.source&&snapshot.source!==source)||(snapshot.url&&sourceFromURL(snapshot.url)!==source))throw Object.assign(Error('实际报价或图表来源与指定来源不一致，不采纳本只数据'),{code:'MARKET_SOURCE_MISMATCH'});
}
export function marketEvidenceConfirmed(item){
  const q=item.quoteSnapshot||{},c=item.chartInfo||{},names=[item.marketSource,q.source,c.source].filter(Boolean);
  if(names.some(s=>typeof s!=='string'||!Object.hasOwn(SOURCES,s)))return false;
  for(const raw of [q.url,c.url].filter(Boolean)){const source=sourceFromURL(raw);if(!source)return false;names.push(source);}
  return new Set(names).size<=1;
}
