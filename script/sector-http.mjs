// 板块目录和历史指数专用。复用浏览器请求会话，不读取或导出凭据，不允许个股接口。
const catalogEndpoint='https://push2.eastmoney.com/api/qt/clist/get';
export function catalogURL(kind,page=1){
  if(!['industry','concept'].includes(kind)||!Number.isInteger(page)||page<1)throw Error('公开板块目录类型或页码无效');
  const url=new URL(catalogEndpoint);
  // ut为AKShare公开适配源码中的固定服务参数，并非用户密钥。
  url.search=new URLSearchParams({pn:String(page),pz:'100',po:'1',np:'1',ut:'bd1d9ddb04089700cf9c27f6f7426281',fltt:'2',invt:'2',fid:'f12',fs:`m:90 t:${kind==='industry'?2:3} f:!50`,fields:'f12,f14'});
  return url;
}
export function assertSectorURL(input){
  const url=new URL(input);
  if(url.protocol!=='https:'||url.username||url.password||url.port||url.hash)throw Error('板块接口地址不安全');
  const history=url.hostname==='91.push2his.eastmoney.com'&&url.pathname==='/api/qt/stock/kline/get'&&/^90\.BK\d{4}$/.test(url.searchParams.get('secid')||'')&&url.searchParams.get('klt')==='101';
  const catalog=url.hostname==='push2.eastmoney.com'&&url.pathname==='/api/qt/clist/get'&&/^m:90 t:[23] f:!50$/.test(url.searchParams.get('fs')||'')&&url.searchParams.get('fields')==='f12,f14';
  if(!history&&!catalog)throw Error('只允许板块目录和板块日K历史，禁止个股接口');return url;
}
export function sectorFetch(context,{onFailure=()=>{}}={}){
  return async(input,{signal,headers={}}={})=>{
    const url=assertSectorURL(input);signal?.throwIfAborted();let response;
    try{
      response=await context.request.get(url.href,{timeout:10000,maxRetries:0,maxRedirects:0,headers:{...headers,Accept:'application/json',Referer:'https://quote.eastmoney.com/'}});
      signal?.throwIfAborted();const status=response.status(),ok=response.ok(),body=await response.text();
      if(body.length>1024*1024)throw Error('板块接口响应异常过大');
      return{status,ok,json:async()=>JSON.parse(body)};
    }catch(e){
      if(signal?.aborted)throw signal.reason;
      const code=/timeout/i.test(e.message)?'SECTOR_TIMEOUT':/socket|closed|ECONNRESET|hang up/i.test(e.message)?'ECONNRESET':'SECTOR_TRANSPORT_ERROR';
      const detail=code==='ECONNRESET'?'远端断开连接':code==='SECTOR_TIMEOUT'?'请求超时':'网络请求未成功';
      onFailure({at:new Date().toISOString(),host:url.hostname,path:url.pathname,error:code});
      throw Error(`专用会话板块请求失败：${code}（${detail}）`,{cause:{code}});
    }finally{await response?.dispose().catch(()=>{});}
  };
}
export async function loadSectorCatalog(kind,{fetchImpl,signal,onPage=async()=>{}}){
  const entries=[],seen=new Set();let total,pages=0;
  for(let page=1;page<=300;page++){
    signal?.throwIfAborted();const response=await fetchImpl(catalogURL(kind,page),{signal});
    if(!response.ok)throw Error(`公开板块目录HTTP ${response.status}；停止，不自动重试或绕过拦截`);
    let payload;try{payload=await response.json();}catch{throw Error('公开板块目录未返回JSON，可能需要人工验证；停止');}
    const data=payload?.data;
    if(payload?.rc!==0||!Number.isInteger(data?.total)||data.total<1||data.total>5000||!Array.isArray(data.diff)||!data.diff.length)throw Error('公开板块目录响应为空或不完整');
    if(total!==undefined&&total!==data.total)throw Error('公开板块目录翻页期间总数改变，停止不完整排名');total=data.total;
    const rows=data.diff.map(row=>{
      if(!/^BK\d{4}$/.test(row.f12)||typeof row.f14!=='string'||!row.f14.trim()||seen.has(row.f12))throw Error('公开板块目录代码/名称无效或翻页重复');
      seen.add(row.f12);return{code:row.f12,name:row.f14.trim(),kind,url:`https://quote.eastmoney.com/unify/r/90.${row.f12}`};
    });
    entries.push(...rows);pages=page;await onPage({kind,page,total,entries:rows,collected:entries.length});
    if(entries.length>total)throw Error('公开板块目录条数超过声明总数');
    if(entries.length===total)return{entries,pages,total,source:'eastmoney-public-sector-catalog'};
  }
  throw Error('公开板块目录超过分页上限，停止不完整排名');
}
