import {ScriptBrowser} from './browser.mjs';
import {SinaBrowser} from './sina-browser.mjs';
import {sourceName} from './sources.mjs';
import {captureWorkers} from './capture-pool.mjs';
export function createMarketBrowser(source,options){sourceName(source);return source==='sina'?new SinaBrowser(options):new ScriptBrowser(options);}
export async function createCaptureBrowsers(source,{context,count=6,optionsForPage=()=>({})}){
 const browsers=[];for(let n=0;n<captureWorkers(count);n++){
  const page=context.pages()[n]||await context.newPage();
  if(browsers.some(b=>b.page===page))throw Error('采图页面重复，停止创建');
  browsers.push(await createMarketBrowser(source,{...optionsForPage(page,n),page,context}).init());
 }return browsers;
}
