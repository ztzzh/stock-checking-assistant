import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {fileURLToPath} from 'node:url';
import {EVIDENCE_VERSION} from './review-settings.mjs';
const execute=promisify(execFile),sha=b=>createHash('sha256').update(b).digest('hex');
export function pngDimensions(bytes){
  if(bytes.length<24||bytes.subarray(0,8).toString('hex')!=='89504e470d0a1a0a')throw Error('送审图证不是有效PNG');
  const width=bytes.readUInt32BE(16),height=bytes.readUInt32BE(20);
  if(!width||!height||width*height>40000000)throw Error('送审PNG尺寸无效或过大');return{width,height};
}
const validRegion=(r,v)=>!!r&&!!v&&[r.x,r.y,r.w,r.h,v.width,v.height].every(Number.isFinite)&&v.width>0&&v.height>0&&r.x>=0&&r.y>=0&&r.w>=20&&r.h>=15&&r.x+r.w<=v.width+1&&r.y+r.h<=v.height+1;
const sameViewport=(a,b)=>!!a&&!!b&&a.width===b.width&&a.height===b.height;
const sameName=(a,b)=>String(a||'').normalize('NFKC').replace(/\s/g,'')===String(b||'').normalize('NFKC').replace(/\s/g,'');
// 主图只用可核对的DOM边界。历史新浪报价与主图有过滚动差异，不能套用旧报价的纵坐标。
export function mainChartRectangle(item,{width,height}){
  const info=item?.chartInfo,v=info?.evidenceViewport,chart=info?.chartRegion;
  if(!validRegion(chart,v)||!info.readiness?.ready)return null;
  const sx=width/v.width,sy=height/v.height;if(!Number.isFinite(sx)||sx<=0||Math.abs(sx-sy)>.01)return null;
  const identity=q=>q?.code===item.code&&sameName(q.name,item.name)&&q.source===info.source&&q.url===info.url&&sameViewport(q.evidenceViewport,v)&&validRegion(q.evidenceRegion,v);
  const q=info.mainQuoteSnapshot;let region;
  if(Object.hasOwn(info,'mainQuoteSnapshot')&&!identity(q))return null;
  if(identity(q)){
    const r=q.evidenceRegion,left=Math.min(chart.x,r.x),top=Math.min(chart.y,r.y);
    region={x:left,y:top,w:Math.max(chart.x+chart.w,r.x+r.w)-left,h:Math.max(chart.y+chart.h,r.y+r.h)-top};
  }else{
    const old=item.quoteSnapshot;
    // 同视口、同股票、同新浪固定列宽时只裁左右，整幅高度保留；其他旧图交原图。
    if(info.source!=='sina'||info.readiness.renderMode!=='sina-canvas'||!identity(old)||Math.abs(old.evidenceRegion.x-chart.x)>2||Math.abs(old.evidenceRegion.w-chart.w)>2)return null;
    region={x:Math.min(chart.x,old.evidenceRegion.x),y:0,w:Math.max(chart.x+chart.w,old.evidenceRegion.x+old.evidenceRegion.w)-Math.min(chart.x,old.evidenceRegion.x),h:v.height};
  }
  const pad=16*sx,x=Math.max(0,Math.floor(region.x*sx-pad)),y=Math.max(0,Math.floor(region.y*sy-pad));
  const right=Math.min(width,Math.ceil((region.x+region.w)*sx+pad)),bottom=Math.min(height,Math.ceil((region.y+region.h)*sy+pad));
  const r={x,y,w:right-x,h:bottom-y};return r.w*r.h<width*height*.9?r:null;
}
// 只按实际DOM坐标裁边，不缩放、不改色、不重绘K线；无法可靠定位则保留原图。
export function evidenceRectangle(image,item,{width,height}){
  if(!item)return null;
  if(image.file===item.chartFile)return mainChartRectangle(item,{width,height});
  const period=item.periodFiles?.find(p=>p.file===image.file),parameter=item.parameterFiles?.find(p=>p.file===image.file);
  const quote=image.file===(item.quoteFile||item.code+'-报价.png');
  let r=quote?item.quoteSnapshot?.evidenceRegion:parameter?.evidenceRegion||period?.evidenceRegion;
  let padding=12;
  // 老批次只有图表坐标，周期悬停保留整幅图表及四周余量，不猜测报价或设置框的位置。
  if(!r&&period){r=item.chartInfo?.chartRegion;padding=120;}
  if(!r||![r.x,r.y,r.w,r.h].every(Number.isFinite)||r.w<20||r.h<15)return null;
  const viewport=quote?item.quoteSnapshot?.evidenceViewport:item.chartInfo?.evidenceViewport;
  if(viewport){const sx=width/viewport.width,sy=height/viewport.height;if(!Number.isFinite(sx)||sx<=0||Math.abs(sx-sy)>.01)return null;r={x:r.x*sx,y:r.y*sy,w:r.w*sx,h:r.h*sy};padding*=sx;}
  if(r.x<0||r.y<0||r.x+r.w>width+1||r.y+r.h>height+1)return null;
  const x=Math.max(0,Math.floor(r.x-padding)),y=Math.max(0,Math.floor(r.y-padding));
  const right=Math.min(width,Math.ceil(r.x+r.w+padding)),bottom=Math.min(height,Math.ceil(r.y+r.h+padding));
  const rect={x,y,w:right-x,h:bottom-y};
  return rect.w*rect.h<width*height*.9?rect:null;
}
export async function cropEvidence(planFile,{signal}={}){
  await execute('powershell.exe',['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',fileURLToPath(new URL('./crop-evidence.ps1',import.meta.url)),'-PlanFile',planFile],{windowsHide:true,shell:false,signal,timeout:30000,maxBuffer:1024*1024});
}
export async function prepareReviewEvidence(input,directory,reviewDir,{compact=true,cropMain=false,signal,crop=cropEvidence}={}){
  const images=[],jobs=[];let originalPixels=0,submittedPixels=0;
  for(const [n,image]of input.images.entries()){
    signal?.throwIfAborted();const source=path.join(directory,image.file),bytes=await fs.readFile(source),dimensions=pngDimensions(bytes),hash=sha(bytes);
    if(bytes.length>32*1024*1024)throw Error('原图超过32MB限制');
    const item=input.targets.find(i=>i.chartFile===image.file||(i.quoteFile||i.code+'-报价.png')===image.file||[...(i.periodFiles||[]),...(i.parameterFiles||[])].some(p=>p.file===image.file));
    const evidence=[...(item?.periodFiles||[]),...(item?.parameterFiles||[])].find(p=>p.file===image.file);
    const expected=[image.sha256,image.imageSHA256,evidence?.imageSHA256,item?.chartFile===image.file?item.imageSHA256:undefined].filter(Boolean);
    if(expected.some(value=>value!==hash))throw Error('提交原图SHA256不符：'+image.file);
    const rect=compact&&(cropMain||image.file!==item?.chartFile)?evidenceRectangle(image,item,dimensions):null;
    const file=rect?String(n+1).padStart(2,'0')+'-'+image.file:image.file;
    const row={...image,file,originalFile:image.file,originalSHA256:hash,sha256:hash,path:source,width:dimensions.width,height:dimensions.height,...(rect?{crop:rect}:{}),label:image.label};images.push(row);
    originalPixels+=dimensions.width*dimensions.height;
    if(rect)jobs.push({source,target:path.join(reviewDir,file),rect,index:n});
  }
  let fallback='';
  if(jobs.length){
    const planFile=path.join(reviewDir,'裁边计划.json');
    await fs.writeFile(planFile,JSON.stringify({sourceRoot:path.resolve(directory),targetRoot:path.resolve(reviewDir),jobs},null,2));
    try{
      await crop(planFile,{signal});signal?.throwIfAborted();
      // 先全部验证成功，再替换提交路径，避免半批图证改变或丢失。
      const replacements=[];
      for(const job of jobs){const bytes=await fs.readFile(job.target),size=pngDimensions(bytes);if(size.width!==job.rect.w||size.height!==job.rect.h)throw Error('局部图尺寸不符');replacements.push({job,hash:sha(bytes)});}
      for(const {job,hash}of replacements)Object.assign(images[job.index],{path:job.target,width:job.rect.w,height:job.rect.h,sha256:hash});
    }catch(error){signal?.throwIfAborted();fallback='局部图生成失败，已提交完整原图：'+error.message.slice(0,160);for(const job of jobs){const row=images[job.index];row.file=row.originalFile;delete row.crop;}}
  }
  for(const row of images)submittedPixels+=row.width*row.height;
  // 裁边工具再次读取原图，提交前复核来源，防止期间被外部更换。
  for(const row of images){signal?.throwIfAborted();if(sha(await fs.readFile(path.join(directory,row.originalFile)))!==row.originalSHA256)throw Error('送审准备期间原图SHA256发生变化：'+row.originalFile);}
  const manifest={version:compact?EVIDENCE_VERSION:'full-v1',mainCropPolicy:'dom-native-v1',mainCropRequested:!!cropMain,codes:input.codes,images:images.map(({path:_,...i})=>i),originalPixels,submittedPixels,croppedImages:images.filter(i=>i.crop).length,fallback,quoteConfirmationScope:'only-review-targets'};
  return{images,manifest};
}
