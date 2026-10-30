import {ScriptBrowser,assertStockQuote} from './browser.mjs';
import {safeSinaURL,stockURL} from './sources.mjs';

const normalizeName=s=>String(s||'').normalize('NFKC').replace(/\s+/g,'');
export function readSinaQuote(){
 const visible=e=>{if(!e)return false;const r=e.getBoundingClientRect();if(r.width<=0||r.height<=0||r.top<0||r.bottom>innerHeight||r.left<0||r.right>innerWidth)return false;for(let p=e;p;p=p.parentElement){const s=getComputedStyle(p);if(s.display==='none'||s.visibility!=='visible'||Number(s.opacity)===0)return false;}return true;};
 const text=selector=>{const nodes=[...document.querySelectorAll(selector)].filter(visible);return nodes.length===1?nodes[0].innerText.trim():'';};
 const identity=text('#stockName'),code=identity.match(/\((\d{6})\.(?:SH|SZ|BJ)\)/)?.[1]||'';
 const labels=[...document.querySelectorAll('#hq th')].filter(e=>visible(e)&&/^今开[：:]$/.test(e.innerText.replace(/\s/g,'')));
 const regions=[...document.querySelectorAll('#stockName,#price,#hqTime,#hq'),...labels,...labels.map(e=>e.nextElementSibling)].filter(visible).map(e=>e.getBoundingClientRect());
 const evidenceRegion=regions.length?{x:Math.min(...regions.map(r=>r.left)),y:Math.min(...regions.map(r=>r.top)),w:Math.max(...regions.map(r=>r.right))-Math.min(...regions.map(r=>r.left)),h:Math.max(...regions.map(r=>r.bottom))-Math.min(...regions.map(r=>r.top))}:undefined;
 return{source:'sina',code,name:text('#stockName .c8_name'),price:text('#price'),open:labels.length===1&&visible(labels[0].nextElementSibling)?labels[0].nextElementSibling.innerText.trim():'',dateText:text('#hqTime'),url:location.href,capturedAt:new Date().toISOString(),evidenceRegion,evidenceViewport:{width:innerWidth,height:innerHeight}};
}
export function readSinaChart(){
 const visible=e=>{if(!e)return false;const r=e.getBoundingClientRect();if(r.width<=0||r.height<=0||r.top<0||r.bottom>innerHeight||r.left<0||r.right>innerWidth)return false;for(let p=e;p;p=p.parentElement){const s=getComputedStyle(p);if(s.display==='none'||s.visibility!=='visible'||Number(s.opacity)===0)return false;}return true;};
 const rect=e=>{const r=e.getBoundingClientRect();return{x:r.x,y:r.y,w:r.width,h:r.height};};
 const roots=[...document.querySelectorAll('[id^="tkChart_"]')].filter(visible),root=roots.length===1?roots[0]:null;
 const active=root?[...root.querySelectorAll('.kke_menus_tab_active')].filter(visible):[];
 const labels=root?[...root.querySelectorAll('span')].filter(visible).map(e=>e.innerText.trim()):[];
 const ma=[5,10,20,60].map(n=>({period:n,visible:labels.filter(t=>new RegExp('^MA'+n+':\\s*\\d+(?:\\.\\d+)?$').test(t)).length===1}));
 // MA5/10也可能出现在成交量副图，主图标签须限定在mainarea内。
 const mains=root?[...root.querySelectorAll('[id^="mainarea__"]')].filter(visible):[],main=mains.length===1?mains[0]:null;
 if(main){const texts=[...main.querySelectorAll('span')].filter(visible).map(e=>e.innerText.trim());for(const l of ma)l.visible=texts.filter(t=>new RegExp('^MA'+l.period+':\\s*\\d+(?:\\.\\d+)?$').test(t)).length===1;}
 const plots=main?[...main.querySelectorAll('canvas')].filter(e=>visible(e)&&e.getBoundingClientRect().width>=300&&e.getBoundingClientRect().height>=100).map(rect):[];
 const volumeComplete=labels.some(t=>/^VOL:\s*\d/.test(t))&&!!root&&[...root.querySelectorAll('canvas')].some(e=>visible(e)&&e.getBoundingClientRect().width>=300&&e.getBoundingClientRect().height>=40&&main&&e.getBoundingClientRect().top>=main.getBoundingClientRect().bottom-1);
 const loading=root?[...root.querySelectorAll('[class*="loading"]')].some(visible):false;
 return{source:'sina',url:location.href,at:new Date().toISOString(),selectedPeriod:active.length===1?active[0].innerText.trim():'',selectedPeriodCount:active.length,chartRegion:root?rect(root):null,
   readiness:{ready:!!main&&ma.every(l=>l.visible)&&volumeComplete&&plots.length>0&&!loading,labels:ma,maLabelsVisible:ma.every(l=>l.visible),volumeLabelVisible:volumeComplete,loading,plots,plotRegion:main?rect(main):null,renderMode:'sina-canvas',requiresVisualConfirmation:true,basis:'15分可见控件、主图MA5/10/20/60、成交量与画布同屏；实际K线周期/日期/形态仍须逐图视觉核对'}};
}
export function sinaNetworkRecord(request,{status,error}={}){
 try{const u=new URL(request.url());if(!/(?:^|\.)sina(?:img)?\.(?:com\.cn|cn)$/.test(u.hostname))return null;
  return{at:new Date().toISOString(),host:u.hostname,path:u.pathname,...(status?{status}:{}),...(error?{error:String(error).slice(0,160)}:{})};
 }catch{return null;}
}
export class SinaBrowser extends ScriptBrowser{
 async init(){
  this.networkFailures=[];this.chartRequests=[];const records=new WeakMap();
  this.page.on('request',request=>{const r=sinaNetworkRecord(request);if(r&&/getKLineData|kline/i.test(r.path)){const row={...r,state:'pending'};records.set(request,row);this.chartRequests.push(row);if(this.chartRequests.length>100)this.chartRequests.shift();}});
  const remember=r=>{if(r){this.networkFailures.push(r);if(this.networkFailures.length>30)this.networkFailures.shift();}};
  this.page.on('requestfinished',request=>{const r=records.get(request);if(r)r.state=r.status>=400?'failed':'complete';});
  this.page.on('requestfailed',request=>{const r=records.get(request);if(r){r.state='failed';r.error=request.failure()?.errorText;}remember(sinaNetworkRecord(request,{error:request.failure()?.errorText}));});
  this.page.on('response',response=>{const r=records.get(response.request());if(r)r.status=response.status();if(response.status()>=400)remember(sinaNetworkRecord(response.request(),{status:response.status()}));});
  this.page.setDefaultTimeout(5000);return this;
 }
 async goto(url){
  safeSinaURL(url);this.signal?.throwIfAborted();
  try{if(this.page.url()===url)await this.page.reload({waitUntil:'domcontentloaded',timeout:this.timeoutMs});else await this.page.goto(url,{waitUntil:'domcontentloaded',timeout:this.timeoutMs});}
  catch(e){if(!/Timeout/i.test(e.message)||this.page.url()!==url)throw e;safeSinaURL(this.page.url());}
 }
 async dismissOverlays(){
  await this.assertNoGate();
  // 先关闭最上层推广遮罩；否则它会挡住图表提示及右侧推广关闭按钮。
  for(const selector of ['.SFA-dark-market-layer .SFA-dark-close','.snp-btn-close-new','.btn-close-msg'])for(const e of await this.page.locator(selector).all())if(await e.isVisible())await e.click({timeout:1500});
  const hints=this.page.locator('[id^="tkChart_"] button').filter({hasText:/^x$/});
  for(const e of await hints.all())if(await e.isVisible())await e.click({timeout:1500});
 }
 async placeQuote(){
  const h=this.page.locator('#stockName');await h.waitFor({state:'visible',timeout:Math.min(this.timeoutMs,1500)});
  await this.page.mouse.move(20,20);await h.evaluate(e=>e.scrollIntoView({block:'center'}));
 }
 checkQuote(q,item){
  safeSinaURL(q.url);if(q.url!==stockURL(item,'sina'))throw Object.assign(Error('新浪实际个股URL与目标股票不符'),{code:'QUOTE_IDENTITY_MISMATCH'});
  return assertStockQuote(q,{...item,requireMarketDate:true},{sourceName:'新浪财经',normalizeName});
 }
 async stockQuote(item){
  this.quoteStartedAt=new Date().toISOString();const url=stockURL(item,'sina');await this.goto(url);await this.dismissOverlays();
  const read=async()=>{await this.dismissOverlays();await this.placeQuote();return this.checkQuote(await this.page.evaluate(readSinaQuote),item);};
  const first=Math.min(10000,this.quoteTimeoutMs/2);let q;
  try{q=await this.poll(read,{timeoutMs:first});}catch(e){
   if(this.signal?.aborted||['MANUAL_VERIFICATION_REQUIRED','MARKET_DATE_CHANGED','QUOTE_IDENTITY_MISMATCH'].includes(e.code))throw e;
   this.step?.(`${item.code}新浪报价未加载，普通刷新一次后继续等待`);await this.assertNoGate();await this.goto(url);q=await this.poll(read,{timeoutMs:this.quoteTimeoutMs-first});
  }
  q=await read();return{...q,image:await this.page.screenshot({type:'png',timeout:this.timeoutMs})};
 }
 async placeChart(){
  const root=this.page.locator('[id^="tkChart_"]').filter({visible:true});if(await root.count()!==1)throw Object.assign(Error('新浪可见图表容器缺失或不唯一'),{code:'CHART_NOT_READY'});
  await root.evaluate(e=>{const r=e.getBoundingClientRect();scrollTo(0,Math.max(0,scrollY+r.bottom-innerHeight+20));});return root;
 }
 async configureMA(){
  await this.dismissOverlays();await this.placeChart();
  const panel=this.page.locator('#sinafinancehtml5indicatorscfgpanel'),open=await panel.isVisible();
  // 读取当前股票主图上的实际标签，不沿用上一只股票的颜色或缓存设置。
  const current=await this.page.evaluate(readSinaChart);
  if(!open&&current.readiness.maLabelsVisible)return{parameters:[5,10,20,60],basis:'current-main-labels',changed:false};
  if(!open){
   const root=this.page.locator('[id^="tkChart_"]').filter({visible:true}),labels=root.locator('[id^="mainarea__"] span'),ma20=labels.filter({hasText:/^MA20\s*:/}),label=await ma20.count()===1?ma20:labels.filter({hasText:/^MA\d+\s*:/}).first();
   if(!await label.isVisible())throw Object.assign(Error('新浪可见主图MA参数入口缺失'),{code:'CHART_NOT_READY'});
   await label.click({timeout:this.timeoutMs});await this.assertNoGate();
  }
  const frame=this.page.frameLocator('#sinafinancehtml5indicatorscfgpanel');await frame.getByRole('button',{name:'确定',exact:true}).waitFor({state:'visible',timeout:this.timeoutMs});
  const parameters=[];for(const e of await frame.locator('input').all())if(await e.isVisible()&&/^\d+$/.test(await e.inputValue()))parameters.push(e);
  if(parameters.length!==4)throw Object.assign(Error('新浪当前MA设置不是四条均线，请在参数面板保留MA5/10/20/60后继续采集'),{code:'CHART_NOT_READY'});
  for(const [n,e]of parameters.entries())await e.fill(String([5,10,20,60][n]));
  const values=await Promise.all(parameters.map(e=>e.inputValue()));if(values.join(',')!=='5,10,20,60')throw Error('新浪MA参数未成功设置');
  const bounds=await this.page.locator('#sinafinancehtml5indicatorscfgpanel').boundingBox();
  const image=await this.page.screenshot({type:'png',timeout:this.timeoutMs});await frame.getByRole('button',{name:'确定',exact:true}).click();await panel.waitFor({state:'hidden',timeout:this.timeoutMs});return{image,parameters:values.map(Number),basis:'visible-parameter-panel',changed:true,evidenceRegion:bounds?{x:bounds.x,y:bounds.y,w:bounds.width,h:bounds.height}:undefined};
 }
 async chart(item,{evidenceMode='compact'}={}){
  const url=stockURL(item,'sina');if(this.page.url()!==url)await this.goto(url);await this.dismissOverlays();await this.placeQuote();this.checkQuote(await this.page.evaluate(readSinaQuote),item);
  const control=this.page.getByText('15分',{exact:true});await control.waitFor({state:'visible',timeout:this.timeoutMs});this.chartStartedAt=Date.now();await control.click();await this.wait(500);
  await this.poll(async()=>{await this.dismissOverlays();await this.placeChart();const root=this.page.locator('[id^="tkChart_"]').filter({visible:true});if(!await root.locator('[id^="mainarea__"] span').filter({hasText:/^MA\d+\s*:/}).first().isVisible())throw Object.assign(Error('新浪15分钟K线仍在加载'),{code:'CHART_NOT_READY'});});
  const parameter=await this.configureMA();
  const info=await this.poll(async()=>{
   await this.dismissOverlays();await this.placeChart();const data=await this.page.evaluate(readSinaChart);
   const requests=this.chartRequests.filter(r=>Date.parse(r.at)>=this.chartStartedAt),failed=requests.find(r=>r.state==='failed'||r.status>=400);
   if(failed)throw Object.assign(Error('新浪页面K线请求失败：'+(failed.error||'HTTP '+failed.status)),{code:'CHART_NETWORK_FAILED'});
   if(requests.some(r=>r.state==='pending')||data.selectedPeriod!=='15分'||data.selectedPeriodCount!==1||!data.readiness.ready)throw Object.assign(Error('新浪15分图、MA5/10/20/60或量柱尚未完整呈现'),{code:'CHART_NOT_READY'});
   return{...data,maParameters:parameter.parameters,maVerification:{basis:parameter.basis,changed:parameter.changed},chartRequests:requests.map(r=>({...r}))};
  },{timeoutMs:this.chartTimeoutMs});
  const q=await this.page.evaluate(readSinaQuote);if(q.code!==item.code||normalizeName(q.name)!==normalizeName(item.name))throw Object.assign(Error('新浪图表同屏股票身份未明确，未采图'),{code:'QUOTE_IDENTITY_MISMATCH'});
  await this.page.mouse.move(20,20);await this.wait(100);const image=await this.page.screenshot({type:'png',timeout:this.timeoutMs}),capturedAt=new Date().toISOString(),periodImages=[];
  if(evidenceMode!=='main-only')for(const offset of [12,30]){const plot=info.readiness.plotRegion,point={x:plot.x+plot.w-offset,y:plot.y+plot.h*.4};await this.page.mouse.move(point.x,point.y);await this.wait(150);periodImages.push({image:await this.page.screenshot({type:'png',timeout:this.timeoutMs}),point,capturedAt:new Date().toISOString()});}
  await this.page.mouse.move(20,20);const after=await this.page.evaluate(readSinaChart);
  if(after.url!==url||after.selectedPeriod!=='15分'||after.selectedPeriodCount!==1||!after.readiness.ready||JSON.stringify(after.chartRegion)!==JSON.stringify(info.chartRegion))throw Error('新浪截图期间身份、周期、布局或加载状态发生变化，图片不采纳');
  return{image,capturedAt,chartInfo:{...info,mainQuoteSnapshot:q,evidenceViewport:await this.page.viewportSize()},periodImages,parameterImages:parameter.image?[{image:parameter.image,parameters:parameter.parameters,evidenceRegion:parameter.evidenceRegion}]:[]};
 }
 async quoteDiagnostic(){await this.assertNoGate();return{snapshot:await this.page.evaluate(readSinaQuote),networkFailures:this.networkFailures.filter(r=>!this.quoteStartedAt||r.at>=this.quoteStartedAt),image:await this.page.screenshot({type:'png',timeout:3000})};}
 async chartDiagnostic(){await this.assertNoGate();return{snapshot:await this.page.evaluate(readSinaChart),networkFailures:this.networkFailures.filter(r=>!this.chartStartedAt||Date.parse(r.at)>=this.chartStartedAt),image:await this.page.screenshot({type:'png',timeout:3000})};}
}
