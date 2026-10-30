import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {createRequire} from 'node:module';
import {setTimeout as delay} from 'node:timers/promises';
import {safeQuoteURL,sameSectorPage,sectorCode,leaders,stockIdentity,extractStocks} from '../extension/core.js';
import {readFullPage} from '../rendered-full-page.mjs';
import {detectGate,manualGateError} from './gate.mjs';

export function catalogRows(snapshot){
  const found=[];
  for(const table of snapshot.tables||[]){
    const name=table.columns.findIndex(c=>/板块名称/.test(c)),rank=table.columns.findIndex(c=>/^(排名|序号)$/.test(c));if(name<0||rank<0)continue;
    for(const row of table.rows){
      const label=row.cells[name],position=Number(row.cells[rank]);if(!label||!Number.isInteger(position)||position<1)continue;
      const link=(row.links[name]||[]).find(l=>{try{return !!sectorCode(l.url);}catch{return false;}});if(!link)throw Error('目录中的板块名称没有实际行情链接');
      found.push({code:sectorCode(link.url),name:label,url:safeQuoteURL(link.url),position});
    }
  }
  if(!found.length)throw Error('板块目录仍未呈现');return found;
}

// 只读取页面上实际可见的报价节点；不读取行情变量、响应体或隐藏属性。
export function readStockQuote(){
 const visible=e=>{if(!e)return false;const r=e.getBoundingClientRect(),s=getComputedStyle(e);return r.width>0&&r.height>0&&r.bottom>0&&r.right>0&&r.top<innerHeight&&r.left<innerWidth&&s.display!=='none'&&s.visibility!=='hidden';};
 const text=selector=>{const nodes=[...document.querySelectorAll(selector)].filter(visible);return nodes.length===1?nodes[0].innerText.trim():'';};
 const labels=[...document.querySelectorAll('.brief_info_c td')].filter(e=>visible(e)&&/^今开[：:]$/.test(e.innerText.trim()));
 const open=labels.length===1&&visible(labels[0].nextElementSibling)?labels[0].nextElementSibling.innerText.trim():'';
 const regions=[...document.querySelectorAll('.quote_title_code,.quote_title_name,.quote_title_time,.quote_quotenums,.brief_info_c')].filter(visible).map(e=>e.getBoundingClientRect());
 const evidenceRegion=regions.length?{x:Math.min(...regions.map(r=>r.left)),y:Math.min(...regions.map(r=>r.top)),w:Math.max(...regions.map(r=>r.right))-Math.min(...regions.map(r=>r.left)),h:Math.max(...regions.map(r=>r.bottom))-Math.min(...regions.map(r=>r.top))}:undefined;
 return{code:text('.quote_title_code'),name:text('.quote_title_name'),price:text('.quote_quotenums .zxj'),open,dateText:text('.quote_title_time'),url:location.href,capturedAt:new Date().toISOString(),evidenceRegion,evidenceViewport:{width:innerWidth,height:innerHeight}};
}
export function assertStockQuote(q,item,{sourceName='东方财富',normalizeName=s=>s}={}){
 const placeholder=value=>!String(value??'').trim()||/^[\s\-—–－.·…]+$/.test(String(value).trim());
 if(placeholder(q.code)||placeholder(q.name))throw Object.assign(Error('可见股票名称/代码仍为横杠或空白，正在等待页面加载'),{code:'QUOTE_IDENTITY_NOT_READY'});
 if(q.code!==item.code||normalizeName(q.name)!==normalizeName(item.name))throw Object.assign(Error(`页面股票身份不符：预期${item.code} ${item.name}，实际${q.code} ${q.name}`),{code:'QUOTE_IDENTITY_MISMATCH'});
 if(!/^(?:\d+\.?\d*|\.\d+)$/.test(q.price)||!Number.isFinite(Number(q.price))||Number(q.price)<=0||!/^(?:\d+\.?\d*|\.\d+)$/.test(q.open)||Number(q.open)<=0)throw Object.assign(Error(sourceName+'个股可见现价/今开仍为空，等待网络加载后仍不能初筛'),{code:'QUOTE_NOT_READY'});
 if(item.expectedMarketDate||item.requireMarketDate){const date=q.dateText?.match(/20\d{2}-\d{2}-\d{2}/)?.[0];if(!date)throw Object.assign(Error('报价实际交易日尚未呈现，等待页面加载'),{code:'QUOTE_DATE_NOT_READY'});if(item.expectedMarketDate&&date!==item.expectedMarketDate)throw Object.assign(Error(`行情日已从原批次${item.expectedMarketDate}变为${date}，请用当天板块名单重新运行，不能混合旧图补采`),{code:'MARKET_DATE_CHANGED'});}
 return q;
}

// 科创板/北交所的站内跳转仍是同一只股票；避免报价刚就绪又重载，身份仍须由实际DOM核对。
export function sameStockPageURL(current,target){
 const a=new URL(safeQuoteURL(current)),b=new URL(safeQuoteURL(target));
 if(a.pathname===b.pathname)return true;
 const canonical=p=>p.replace(/^\/sh(688\d{3})\.html$/,'/kcb/$1.html').replace(/^\/bj(\d{6})\.html$/,'/bj/$1.html');
 return canonical(a.pathname)===canonical(b.pathname);
}

// 仅保存页面自身请求的传输错误/HTTP错误；不保存带参URL、请求头、响应体或行情值。
export function quoteNetworkRecord(request,{status,error}={}){
 try{
  const u=new URL(request.url());
  if(!(u.hostname==='eastmoney.com'||u.hostname.endsWith('.eastmoney.com'))||!u.pathname.startsWith('/api/'))return null;
  return{at:new Date().toISOString(),host:u.hostname,path:u.pathname,...(status?{status}:{}),...(error?{error:String(error).slice(0,160)}:{})};
 }catch{return null;}
}

// 只检查同屏渲染的标签和绘图元素是否就绪，不读取canvas像素、图表实例或行情变量。
// 这里的就绪检查不代替视觉判定，最终身份、均线与量柱仍由新截图复核。
export function readChartReadiness(region){
 const shown=e=>{if(!e)return false;const r=e.getBoundingClientRect();if(r.width<=0||r.height<=0||r.top<0||r.left<0||r.bottom>innerHeight||r.right>innerWidth)return false;for(let p=e;p;p=p.parentElement){const style=getComputedStyle(p);if(style.display==='none'||style.visibility!=='visible'||Number(style.opacity)===0)return false;}return true;};
 const inside=e=>{if(!shown(e))return false;const r=e.getBoundingClientRect();return r.left>=region.x-1&&r.top>=region.y-1&&r.right<=region.x+region.w+1&&r.bottom<=region.y+region.h+1;};
 const toRect=e=>{const r=e.getBoundingClientRect();return{tag:e.tagName,x:r.x,y:r.y,w:r.width,h:r.height};};
 const texts=[],walker=document.createTreeWalker(document.body,NodeFilter.SHOW_TEXT);while(walker.nextNode()){const n=walker.currentNode;if(n.textContent.trim()&&inside(n.parentElement))texts.push(n.textContent.trim());}
 const text=texts.join(' ').replace(/\s+/g,' '),labels=[5,10,20,60].map(n=>({period:n,visible:new RegExp('MA\\s*'+n+'\\s*[:：]\\s*\\d+(?:\\.\\d+)?(?![\\d.])','i').test(text)}));
 const volumeLabelVisible=/\bVOL\s*[:：]\s*\d+(?:\.\d+)?|成交量\s*[:：]?\s*\d+(?:\.\d+)?/i.test(text);
 const plots=[...document.querySelectorAll('canvas,svg,img')].filter(e=>inside(e)&&e.getBoundingClientRect().width>=300&&e.getBoundingClientRect().height>=60&&(!(e instanceof HTMLImageElement)||(e.complete&&e.naturalWidth>0&&e.naturalHeight>0))).map(toRect);
 // 东方财富动图的标签绘在canvas中。仅用可见DOM位置定位控件下方K线画布，绝不读取像素/内部实例。
 const control=[...document.querySelectorAll('.mainquotecharts .mqc_k_header a')].find(e=>shown(e)&&/^(15分钟|15分)$/.test(e.innerText.trim())),root=control?.closest('.mainquotecharts'),bar=control?.closest('.mqc_k_header')?.getBoundingClientRect();
 const boxes=root&&bar?[...root.querySelectorAll('.__emchatrs3_root_box')].filter(e=>{const r=e.getBoundingClientRect();return shown(e)&&r.top>=bar.bottom-1&&r.width>=400&&r.height>=250;}):[];
 const box=boxes.length===1?boxes[0]:null,canvasPlots=box?[...box.querySelectorAll('canvas')].filter(e=>shown(e)&&e.getBoundingClientRect().width>=400&&e.getBoundingClientRect().height>=250).map(toRect):[];
 const loading=box?[...box.querySelectorAll('.__em_loading')].some(shown):false;
 const canvasCandidate=!!box&&canvasPlots.length>0&&!loading,domReady=labels.every(l=>l.visible)&&volumeLabelVisible&&plots.length>0;
 return{maLabelsVisible:labels.every(l=>l.visible),labels,volumeLabelVisible,plots:canvasCandidate?canvasPlots:plots,loading,ready:domReady||canvasCandidate,renderMode:canvasCandidate?'eastmoney-canvas':'dom-labels',requiresVisualConfirmation:canvasCandidate,plotRegion:box?toRect(box):null,basis:canvasCandidate?'K线画布完整同屏且无可见加载遮罩；这里只确认截图可采，真实周期、均线和量柱须逐图视觉确认':'实际同屏DOM均线/成交量标签及绘图元素；仍须视觉复核'};
}

export async function loadPlaywright(){
  try{return await import('playwright');}catch{}
  try{return await import('playwright-core');}catch{}
  const entry=process.env.SCREENING_MODULE_ROOT||path.join(os.homedir(),'.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/screening-entry.js');
  try{return createRequire(entry)('playwright');}catch{throw Error('缺少Playwright。请在项目目录运行npm install playwright，再安装Chromium或设置SCREENING_BROWSER_EXE。');}
}
export async function findBrowser(chromium,explicit){
  if(explicit){await fs.access(explicit);return explicit;}
  const defaultPath=chromium.executablePath();try{await fs.access(defaultPath);return defaultPath;}catch{}
  const cache=path.join(process.env.LOCALAPPDATA||path.join(os.homedir(),'AppData/Local'),'ms-playwright');
  const entries=await fs.readdir(cache).catch(()=>[]);
  for(const name of entries.filter(n=>/^chromium-\d+$/.test(n)).sort((a,b)=>Number(b.split('-')[1])-Number(a.split('-')[1]))){
    for(const tail of ['chrome-win64/chrome.exe','chrome-win/chrome.exe']){const p=path.join(cache,name,tail);try{await fs.access(p);return p;}catch{}}
  }
  throw Error('未找到已安装的Chromium；请安装浏览器或设置SCREENING_BROWSER_EXE。');
}
export function selectSector(rankings,rank){
  const combined=[];
  for(const ranking of rankings){
    const rows=leaders(ranking.snapshot);
    if(rows.length<rank)throw Error(`当前${ranking.kind}榜可见行不足以确定合并第${rank}强板块`);
    if(rows.some((r,n)=>r.rank!==n+1||!sectorCode(r.url)||(n>0&&r.rate>rows[n-1].rate)))throw Error('可见榜单不是从第1名连续降序，拒绝选择板块');
    for(const row of rows)if(!combined.some(r=>sectorCode(r.url)===sectorCode(row.url)))combined.push({...row,kind:ranking.kind});
  }
  combined.sort((a,b)=>b.rate-a.rate);
  const picked=combined[rank-1];if(!picked)throw Error('没有足够的唯一板块');
  if(combined.some((r,n)=>n!==rank-1&&r.rate===picked.rate))throw Error('目标名次存在同涨幅板块，需明确选择，不能擅自打破并列');
  return {...picked,selectionRank:rank,selection:'行业/概念两榜合并涨幅降序',confirmed:false};
}

export class ScriptBrowser{
  constructor({page,context,root,signal,step,onVerification,evidenceDir,timeoutMs=12000,quoteTimeoutMs=30000,chartTimeoutMs=30000}){Object.assign(this,{page,context,root,signal,step,onVerification,evidenceDir,timeoutMs,quoteTimeoutMs,chartTimeoutMs});this.manualWaitMs=0;}
  async init(){
    const source=await fs.readFile(path.join(this.root,'extension/visible.js'),'utf8');
    // 在Node中构造函数，再由Playwright执行；只将原有DOM读取器局部绑定，不访问页面行情变量。
    this.reader=new Function('input',source.replace('globalThis.ScreenVision =','const ScreenVision =')+'\nreturn ScreenVision[input.method](input.arg);');
    this.networkFailures=[];
    this.chartRequests=[];const chartRecords=new WeakMap();
    this.page.on('request',request=>{const r=quoteNetworkRecord(request);if(r?.path==='/api/qt/stock/kline/get'){const record={...r,state:'pending'};chartRecords.set(request,record);this.chartRequests.push(record);if(this.chartRequests.length>100)this.chartRequests.shift();}});
    this.page.on('requestfinished',request=>{const r=chartRecords.get(request);if(r){r.state=r.status>=400?'failed':'complete';r.finishedAt=new Date().toISOString();}});
    const remember=record=>{if(record){this.networkFailures.push(record);if(this.networkFailures.length>30)this.networkFailures.shift();}};
    this.page.on('requestfailed',request=>{const r=chartRecords.get(request);if(r){r.state='failed';r.error=request.failure()?.errorText;r.finishedAt=new Date().toISOString();}remember(quoteNetworkRecord(request,{error:request.failure()?.errorText}));});
    this.page.on('response',response=>{const r=chartRecords.get(response.request());if(r)r.status=response.status();if(response.status()>=400)remember(quoteNetworkRecord(response.request(),{status:response.status()}));});
    this.page.setDefaultTimeout(5000);return this;
  }
  async assertNoGate(){
    this.signal?.throwIfAborted();let gate=await detectGate(this.page);if(!gate)return;
    if(this.onVerification){
      const start=Date.now();try{await this.onVerification(gate);}finally{this.manualWaitMs+=Date.now()-start;}
      this.signal?.throwIfAborted();gate=await detectGate(this.page);
      // 人工验证成功后沿用当前文档；立即重载可能再次触发验证或丢失已加载图表。
      if(!gate)return;
    }
    throw manualGateError(gate);
  }
  async read(method,arg){this.signal?.throwIfAborted();safeQuoteURL(this.page.url());await this.assertNoGate();const result=await this.page.evaluate(this.reader,{method,arg});if(result?.blocked)throw Error('行情页面出现验证码、访问拦截或服务器错误，停止');return result;}
  async wait(ms){await delay(ms,undefined,{signal:this.signal});}
  async poll(fn,{timeoutMs=this.timeoutMs}={}){
    let end=Date.now()+timeoutMs,last,manual=this.manualWaitMs;
    while(Date.now()<end){this.signal?.throwIfAborted();try{return await fn();}catch(e){if(['MANUAL_VERIFICATION_REQUIRED','MARKET_DATE_CHANGED','QUOTE_IDENTITY_MISMATCH','CHART_NETWORK_FAILED'].includes(e.code)||/验证码|访问拦截/.test(e.message))throw e;last=e;}end+=this.manualWaitMs-manual;manual=this.manualWaitMs;await this.wait(250);}
    throw last||Error('页面未在等待上限内就绪');
  }
  async goto(url){
    safeQuoteURL(url);this.signal?.throwIfAborted();
    // 同一行情中心只改hash会沿用旧表直至异步更新；重新加载文档，避免误读上一榜。
    const current=new URL(this.page.url()),next=new URL(url);
    if(current.origin===next.origin&&current.pathname===next.pathname&&current.hash!==next.hash)await this.page.goto('about:blank',{waitUntil:'domcontentloaded',timeout:this.timeoutMs});
    try{if(this.page.url()===url)await this.page.reload({waitUntil:'domcontentloaded',timeout:this.timeoutMs});else await this.page.goto(url,{waitUntil:'domcontentloaded',timeout:this.timeoutMs});}
    catch(e){if(!/Timeout/i.test(e.message))throw e;safeQuoteURL(this.page.url());if(this.page.url()!==url)throw e;}
  }
  async table(){
    return this.poll(async()=>{const scroll=await this.read('scrollTable');if(!scroll.ok)throw Error(scroll.reason);await this.wait(150);const s=await this.read('snapshot');if(!s.tables.length)throw Error('报价表仍在加载');return s;});
  }
  async ranking(kind){
    await this.goto(`https://quote.eastmoney.com/center/gridlist.html#${kind}_board`);
    const snapshot=await this.poll(async()=>{const s=await this.table();leaders(s);return s;});
    return {kind,snapshot,leaders:leaders(snapshot),image:await this.page.screenshot({type:'png',timeout:this.timeoutMs})};
  }
  async sectorCatalog(kind){
    await this.goto(`https://quote.eastmoney.com/center/gridlist.html#${kind}_board`);
    const entries=[],seen=new Set();let previous='',pages=0;
    for(;;){
      const rows=await this.poll(async()=>{await this.assertNoGate();const snapshot=await this.page.evaluate(readFullPage);const items=catalogRows(snapshot);if(items.map(i=>i.code).join(',')===previous)throw Error('目录翻页后尚未更新');return items;});
      const expected=entries.length+1;if(rows[0].position!==expected||rows.some((r,n)=>r.position!==expected+n))throw Error('板块目录页码或排名不连续，拒绝不完整范围');
      for(const row of rows){if(seen.has(row.code))throw Error('板块目录翻页重复，停止');seen.add(row.code);entries.push(row);}pages++;previous=rows.map(i=>i.code).join(',');
      if(this.evidenceDir){
        await fs.mkdir(this.evidenceDir,{recursive:true});
        const controls=await this.page.locator('a,button,[role="button"],input').evaluateAll(elements=>elements.filter(e=>e.getBoundingClientRect().width&&e.getBoundingClientRect().height).map(e=>({tag:e.tagName,text:(e.innerText||'').trim(),title:e.title||'',ariaLabel:e.getAttribute('aria-label')||'',className:e.className||'',parentClass:e.parentElement?.className||''})).filter(e=>/^\d{1,4}$|下一页|下页|上一页|上页|^[>»›<‹«]$|跳转/.test(e.text+' '+e.title+' '+e.ariaLabel)||/page|next|prev/i.test(e.className+' '+e.parentClass)));
        await fs.writeFile(path.join(this.evidenceDir,`${kind}-${pages}.json`),JSON.stringify({at:new Date().toISOString(),rows,controls},null,2));
        if(pages===1)await this.page.screenshot({path:path.join(this.evidenceDir,`${kind}-首页.png`),fullPage:true,timeout:this.timeoutMs});
      }
      const next=this.page.getByText(/^(下一页|下页)\s*[>»›]?$/).or(this.page.locator('a[title="下一页"],button[title="下一页"],[aria-label="下一页"],a.next,a.nextpage,.pagination .next,.pager .next')).filter({visible:true}),count=await next.count();
      if(!count)throw Error(`无法确认板块目录最后一页，拒绝将当前${entries.length}条当作完整范围；请查看目录证据`);
      if(count!==1)throw Error('目录下一页控件不唯一，无法确认完整范围');
      const disabled=await next.evaluate(e=>[e,e.parentElement].filter(Boolean).some(n=>n.hasAttribute('disabled')||n.getAttribute('aria-disabled')==='true'||/(^|\s)(disabled|disable)(\s|$)/i.test(n.className||'')));
      if(disabled)break;if(pages>=100)throw Error('目录超过100页，停止并提示检查范围');
      await next.click();
    }
    return{entries,pages};
  }
  async constituents(sector,limit){
    await this.goto(sector.url);
    await this.assertNoGate();
    const link=this.page.getByRole('link',{name:'板块成分股涨跌幅',exact:true});await link.waitFor({state:'visible',timeout:this.timeoutMs});
    const href=await link.getAttribute('href');if(!href)throw Error('没有实际可见成分表链接');
    const url=safeQuoteURL(new URL(href,sector.url).href);if(!sameSectorPage(url,sector.url))throw Error('成分表链接不属于选中板块');
    const boardContext={url:this.page.url(),title:await this.page.title(),constituentsURL:url,linkText:'板块成分股涨跌幅',capturedAt:new Date().toISOString()};
    const boardImage=await this.page.screenshot({type:'png',timeout:this.timeoutMs});
    await this.goto(url);const snapshot=await this.poll(async()=>{const s=await this.table();if(!sameSectorPage(s.url,sector.url))throw Error('成分表实际板块不符');extractStocks(s,limit);return s;});
    return {snapshot,items:extractStocks(snapshot,limit),image:await this.page.screenshot({type:'png',timeout:this.timeoutMs}),boardImage,boardContext};
  }
  async stockQuote(item){
    this.quoteStartedAt=new Date().toISOString();
    await this.goto(item.url);await this.assertNoGate();
    const read=async()=>{
      await this.assertNoGate();const title=this.page.locator('.quote_title');
      await title.waitFor({state:'visible',timeout:Math.min(1500,this.timeoutMs)});
      // 验证完成的重载、延迟布局会移动页面；每次读取前重新将标题及报价放回同屏。
      await title.evaluate(e=>e.scrollIntoView({block:'center',inline:'nearest'}));
      const q=await this.page.evaluate(readStockQuote);return assertStockQuote(q,item);
    };
    let quote;const first=Math.min(10000,this.quoteTimeoutMs/2);
    try{quote=await this.poll(read,{timeoutMs:first});}
    catch(e){
      if(this.signal?.aborted||['MANUAL_VERIFICATION_REQUIRED','MARKET_DATE_CHANGED','QUOTE_IDENTITY_MISMATCH'].includes(e.code))throw e;
      this.step?.(`${item.code}报价未加载，普通刷新一次后继续等待`);
      await this.assertNoGate();await this.goto(item.url);
      quote=await this.poll(read,{timeoutMs:this.quoteTimeoutMs-first});
    }
    // 截图前再次定位，保证保存的报价证据仍含名称、代码与报价，避免布局漂移误读。
    quote=await read();
    return{...quote,source:'eastmoney',image:await this.page.screenshot({type:'png',timeout:this.timeoutMs})};
  }
  async quoteDiagnostic(){await this.assertNoGate();return{snapshot:await this.page.evaluate(readStockQuote),networkFailures:(this.networkFailures||[]).filter(r=>!this.quoteStartedAt||r.at>=this.quoteStartedAt),image:await this.page.screenshot({type:'png',timeout:3000})};}
  async chartDiagnostic(){const snapshot=await this.read('chartInfo');return{snapshot,networkFailures:(this.networkFailures||[]).filter(r=>!this.chartStartedAt||Date.parse(r.at)>=this.chartStartedAt),image:await this.page.screenshot({type:'png',timeout:3000})};}
  async chart(item,{evidenceMode='compact'}={}){
    if(!sameStockPageURL(this.page.url(),item.url))await this.goto(item.url);await this.page.bringToFront();
    await this.poll(async()=>{const s=await this.read('identity');if(!stockIdentity(s,item.code,item.name))throw Error('新页面股票身份未就绪');return s;});
    let prepared=await this.read('prepareChart');
    if(!prepared.ok){const menu=this.page.getByText('分钟',{exact:true});if(await menu.count()===1)await menu.click();prepared=await this.read('prepareChart');}
    if(!prepared.ok)throw Error(prepared.reason);
    const control=this.page.locator('a').filter({hasText:/^(15分钟|15分)$/});
    if(await control.count()!==1)throw Error('15分钟链接不唯一或缺失');this.chartStartedAt=Date.now();await control.click();await this.wait(1200);
    const info=await this.poll(async()=>{
      const scroll=await this.read('scrollChart');if(!scroll.ok)throw Error(scroll.reason);
      const result=await this.read('chartInfo');if(!result.chartRegion||!/^(15分钟|15分)$/.test(result.selectedPeriod||'')||result.selectedPeriodCount!==1)throw Error('完整图表或15分钟唯一选中状态未明确');
      const requests=(this.chartRequests||[]).filter(r=>Date.parse(r.at)>=this.chartStartedAt),failed=requests.find(r=>r.state==='failed'||r.status>=400);
      if(failed)throw Object.assign(Error('页面K线请求失败：'+(failed.error||'HTTP '+failed.status)+'；本只未取得可用图证'),{code:'CHART_NETWORK_FAILED'});
      if(requests.some(r=>r.state==='pending'))throw Object.assign(Error('页面K线请求仍在加载，尚未采图'),{code:'CHART_NOT_READY'});
      result.readiness=await this.page.evaluate(readChartReadiness,result.chartRegion);
      if(!result.readiness.ready)throw Object.assign(Error('15分钟虽已选中，但图表区域、加载状态或DOM标签不满足截图条件，未采图'),{code:'CHART_NOT_READY'});
      result.chartRequests=requests.map(r=>({...r}));
      return result;
    },{timeoutMs:this.chartTimeoutMs});
    const before=await this.read('identity');if(!stockIdentity(before,item.code,item.name))throw Error('截图前股票身份变化');
    const outside={x:Math.max(0,info.chartRegion.x-12),y:info.chartRegion.y+15};
    await this.page.mouse.move(outside.x,outside.y);await this.wait(100);
    const mainQuoteSnapshot=await this.page.evaluate(readStockQuote);
    const image=await this.page.screenshot({type:'png',timeout:this.timeoutMs}),capturedAt=new Date().toISOString();
    const periodImages=[];
    if(evidenceMode!=='main-only'&&info.readiness.renderMode==='eastmoney-canvas'){
      const plot=info.readiness.plotRegion;
      for(const offset of [75,125]){
        const point={x:plot.x+plot.w-offset,y:plot.y+Math.min(100,plot.h/3)};
        await this.page.mouse.move(point.x,point.y);await this.wait(180);
        periodImages.push({image:await this.page.screenshot({type:'png',timeout:this.timeoutMs}),point,capturedAt:new Date().toISOString()});
      }
      await this.page.mouse.move(outside.x,outside.y);await this.wait(100);
    }
    const after=await this.read('chartInfo'),identity=await this.read('identity');
    const readiness=after.chartRegion&&await this.page.evaluate(readChartReadiness,after.chartRegion);
    if(!stockIdentity(identity,item.code,item.name)||after.url!==info.url||after.selectedPeriod!==info.selectedPeriod||after.selectedPeriodCount!==1||JSON.stringify(after.chartRegion)!==JSON.stringify(info.chartRegion)||!readiness?.ready)throw Error('截图期间身份、周期、图表位置或加载状态变化，图像不采纳');
    return {image,capturedAt,chartInfo:{...info,source:'eastmoney',mainQuoteSnapshot:{source:'eastmoney',...mainQuoteSnapshot},evidenceViewport:await this.page.viewportSize()},periodImages};
  }
  async diagnostics(directory,reason){
    const files=[];
    try{await this.page.screenshot({path:path.join(directory,'失败现场.png'),type:'png',timeout:3000});files.push('失败现场.png');}catch{}
    try{
      const url=new URL(this.page.url());url.search='';
      await fs.writeFile(path.join(directory,'失败页面.json'),JSON.stringify({at:new Date().toISOString(),reason,url:url.href,title:await this.page.title(),networkFailures:this.networkFailures||[]},null,2));files.push('失败页面.json');
    }catch{}
    return files;
  }
}
