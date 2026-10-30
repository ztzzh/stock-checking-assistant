// 增量桌面副本：同一批次只建一个任务目录，图片只复制一次；后台合并快照，不阻塞采图/审核。
import fs from 'node:fs/promises';import path from 'node:path';import {createHash} from 'node:crypto';
import {desktopDirectory,safeFolderName,archiveNames} from './archive.mjs';
import {atomicJSON,atomicWrite} from './state-files.mjs';import {resultCSV} from './result-csv.mjs';
const relative=p=>p.split(path.sep).join('/');
function inside(root,target){const rel=path.relative(path.resolve(root),path.resolve(target));if(!rel||rel==='..'||rel.startsWith('..'+path.sep)||path.isAbsolute(rel))throw Error('归档路径超出任务目录');return path.resolve(target);}
const readJSON=async file=>JSON.parse((await fs.readFile(file,'utf8')).replace(/^\uFEFF/,''));
export class LiveArchiveSession {
 constructor(source,cfg={}, {desktopDir,log=console.log}={}){Object.assign(this,{source:path.resolve(source),cfg,desktopDir,log});this.pending=null;this.worker=null;this.manifest=null;this.lastError=null;}
 schedule(run){if(run.status==='members_only'||run.rankingsOnly||!run.items?.length)return;this.pending=structuredClone(run);this.start();}
 start(){if(this.worker||!this.pending)return;this.worker=(async()=>{while(this.pending){const run=this.pending;this.pending=null;try{await this.write(run);this.lastError=null;}catch(e){if(e.message!==this.lastError?.message)this.log('桌面归档暂未完成：'+e.message+'；原始记录仍保留');this.lastError=e;await atomicJSON(path.join(this.source,'桌面归档.json'),{...(this.manifest||{}),status:'failed',directory:this.manifest?.directory||'',error:e.message}).catch(()=>{});}}})().finally(()=>{this.worker=null;this.start();});}
 async flush(run){this.schedule(run);while(this.worker)await this.worker;return this.lastError?{status:'failed',error:this.lastError.message,directory:this.manifest?.directory||''}:this.manifest||{status:'skipped'};}
 async initialize(run){
  if(this.manifest)return;
  const stockRoot=path.join(this.desktopDir||await desktopDirectory(),'股票'),names=archiveNames(run,{taskName:this.cfg['task-name']});
  let old;try{old=await readJSON(path.join(this.source,'桌面归档.json'));}catch(e){if(e.code!=='ENOENT')throw e;}
  if(old?.archiveMode==='incremental'&&old.batchId===run.id&&path.resolve(old.sourceDirectory)===this.source){inside(stockRoot,old.directory);const real=await fs.realpath(old.directory),realStockRoot=await fs.realpath(stockRoot);inside(realStockRoot,real);this.manifest=await readJSON(path.join(real,'其他','归档清单.json'));if(this.manifest.batchId!==run.id||path.resolve(this.manifest.sourceDirectory)!==this.source)throw Error('增量归档身份不符');return;}
  await fs.mkdir(path.join(stockRoot,names.date),{recursive:true});let directory;
  for(let n=1;n<1001;n++){directory=inside(stockRoot,path.join(stockRoot,names.date,names.task+(n===1?'':'_'+n)));try{await fs.mkdir(directory);break;}catch(e){if(e.code!=='EEXIST'||n===1000)throw e;}}
  await fs.mkdir(path.join(directory,'其他','原始记录'),{recursive:true});
  this.manifest={archiveMode:'incremental',layoutVersion:2,status:'writing',batchId:run.id,sourceDirectory:this.source,directory,taskName:names.task,dateFolder:names.date,files:[],stocks:[],quickView:{csv:'结果.csv',stocks:[]},warnings:[]};
  await atomicJSON(path.join(directory,'其他','归档清单.json'),this.manifest);await atomicJSON(path.join(this.source,'桌面归档.json'),this.manifest);this.log('桌面实时归档：'+directory);
 }
 async write(run){
  if(!Array.isArray(run.items)||run.items.some(i=>!/^\d{6}$/.test(i.code))||new Set(run.items.map(i=>i.code)).size!==run.items.length)throw Error('归档股票代码无效或重复');
  await this.initialize(run);const m=this.manifest,root=m.directory,other=inside(root,path.join(root,'其他')),files=new Map(m.files.map(f=>[f.file,f])),warnings=new Set(m.warnings||[]),stocks=new Map(m.stocks.map(s=>[s.code,s]));
  const addWarning=(file,e)=>warnings.add(file+'：'+e.message);
  const write=async(rel,bytes,source=rel)=>{const target=inside(root,path.join(root,rel));await fs.mkdir(path.dirname(target),{recursive:true});const old=files.get(relative(rel));if(rel==='结果.csv'&&old){const current=await fs.readFile(target).catch(e=>{if(e.code==='ENOENT')return null;throw e;});if(current&&(m.csvUserEdited||createHash('sha256').update(current).digest('hex')!==old.sha256)){const actualSHA=createHash('sha256').update(current).digest('hex');m.csvUserEdited={originalExportSHA256:m.csvUserEdited?.originalExportSHA256||old.sha256,preservedSHA256:actualSHA};files.set('结果.csv',{...old,bytes:current.length,sha256:actualSHA,note:'用户重新保存的CSV，保持原样'});warnings.add('结果.csv已由用户修改，保留根目录文件；最新生成版本在其他/原始记录/结果_最新生成.csv');return write(path.join('其他','原始记录','结果_最新生成.csv'),bytes,source);}}await atomicWrite(target,bytes);files.set(relative(rel),{source,file:relative(rel),bytes:Buffer.byteLength(bytes),sha256:createHash('sha256').update(bytes).digest('hex')});};
  const copy=async(file,rel,hash)=>{
   if(typeof file!=='string'||path.basename(file)!==file||/[\\/]/.test(file))throw Error('归档图片文件名无效');
   const target=inside(root,path.join(root,rel)),previous=files.get(relative(rel));
   if(previous&&previous.source===file&&(!hash||previous.sha256===hash)&&await fs.access(target).then(()=>true,()=>false))return true;
   try{const source=inside(this.source,path.join(this.source,file)),info=await fs.lstat(source);if(!info.isFile()||info.isSymbolicLink()||info.size>20*1024*1024)throw Error('不是普通文件或超过20MB');const bytes=await fs.readFile(source),sha=createHash('sha256').update(bytes).digest('hex');if(hash&&hash!==sha)throw Error('原图SHA256不符');await fs.mkdir(path.dirname(target),{recursive:true});try{await fs.copyFile(source,target,fs.constants.COPYFILE_EXCL);}catch(e){if(e.code!=='EEXIST')throw e;const existing=await fs.lstat(target);if(!existing.isFile()||existing.isSymbolicLink()||createHash('sha256').update(await fs.readFile(target)).digest('hex')!==sha)throw Error('同名文件已有且内容不同，保留原文件');}files.set(relative(rel),{source:file,file:relative(rel),bytes:info.size,sha256:sha});return true;}catch(e){addWarning(file,e);return false;}
  };
  const realOther=await fs.realpath(other);
  const counts={'符合':0,'淘汰':0,'待审核':0},matched=new Map(m.quickView.stocks.map(s=>[s.code,s])),used=new Set(['结果.csv','其他',...m.quickView.stocks.map(s=>s.file.toLowerCase())]);
  for(const item of run.items){
   const group=['符合','淘汰'].includes(item.result?.status)?item.result.status:'待审核';counts[group]++;
   const folder=relative(path.join('其他',group,item.code+'_'+safeFolderName(item.name,36))),prior=stocks.get(item.code);
   const signature=JSON.stringify({status:run.status,name:item.name,group,result:item.result,quote:item.quoteSnapshot,capturedAt:item.capturedAt,chart:item.chartFile,hash:item.imageSHA256,period:item.periodFiles,parameters:item.parameterFiles,model:item.reviewEngine});
   if(prior?.signature===signature)continue;
   if(prior&&prior.folder!==folder){const from=inside(other,path.join(root,prior.folder)),to=inside(other,path.join(root,folder));await fs.mkdir(path.dirname(to),{recursive:true});if(await fs.access(from).then(()=>true,()=>false)){inside(realOther,await fs.realpath(from));await fs.rename(from,to);}else if(await fs.access(to).then(()=>true,()=>false))inside(realOther,await fs.realpath(to));for(const [key,entry]of[...files])if(key.startsWith(prior.folder+'/')){files.delete(key);entry.file=folder+key.slice(prior.folder.length);files.set(entry.file,entry);}}
   await fs.mkdir(inside(root,path.join(root,folder)),{recursive:true});
   const images=new Map();for(const image of run.images||[])if(image.file?.startsWith(item.code+'-')&&/\.(png|jpe?g|webp)$/i.test(image.file))images.set(image.file,null);if(item.chartFile)images.set(item.chartFile,item.imageSHA256);for(const p of [...(item.periodFiles||[]),...(item.parameterFiles||[])])images.set(p.file,p.imageSHA256);
   for(const [file,hash]of images)await copy(file,path.join(folder,file),hash);
   let primary=matched.get(item.code);
   if(group==='符合'&&item.chartFile){if(!primary){const ext=path.extname(item.chartFile).toLowerCase();if(!['.png','.jpg','.jpeg','.webp'].includes(ext))throw Error('符合主图格式无效');let name=safeFolderName(item.name,60)+ext;if(used.has(name.toLowerCase()))name=safeFolderName(item.name,60)+'_'+item.code+ext;if(used.has(name.toLowerCase()))throw Error('符合图片重名');used.add(name.toLowerCase());primary={code:item.code,name:item.name,file:name};}if(await copy(item.chartFile,primary.file,item.imageSHA256))matched.set(item.code,primary);}
   const note=['股票：'+item.code+' '+item.name,'分类：'+group,'判定说明：'+(item.result?.reason||item.captureError||'尚未完成'),'任务状态：'+run.status+'；运行中结果仅为已保存进度','所属板块：'+(item.memberships?.map(s=>s.name).join('、')||run.sector?.name||''),'图表采集时点：'+(item.capturedAt||'未取得'),'行情日期：'+(item.quoteSnapshot?.dateText||'未取得'),'复核模型：'+(item.reviewEngine?.model||'未复核'),'原始记录：'+this.source,'',...images.keys()].join('\r\n');
   await write(path.join(folder,'判定说明.txt'),'\ufeff'+note,'逐只判定说明');stocks.set(item.code,{code:item.code,name:item.name,group,folder,signature});
  }
  await write('结果.csv',resultCSV(run),'结果.csv');await write(path.join('其他','原始记录','run.json'),JSON.stringify(run,null,2),'run.json');
  for(const file of ['指定板块.json','板块成分目录.json'])if(await fs.access(path.join(this.source,file)).then(()=>true,e=>{if(e.code==='ENOENT')return false;throw e;}))await copy(file,path.join('其他','原始记录',file));
  const common=new Set((run.images||[]).filter(i=>!/^\d{6}-/.test(i.file||'')).map(i=>i.file));for(const file of ['验证现场.png','失败页面.png'])if(await fs.access(path.join(this.source,file)).then(()=>true,()=>false))common.add(file);for(const file of common)await copy(file,path.join('其他','任务现场',file));
  const lines=run.items.map(i=>{const stock=stocks.get(i.code),primary=matched.get(i.code),folder=stock.folder.replace(/^其他\//,''),preferred=i.chartFile&&files.has(stock.folder+'/'+i.chartFile)?i.chartFile:(run.images||[]).find(p=>p.file?.startsWith(i.code+'-')&&files.has(stock.folder+'/'+p.file))?.file;const image=primary?'[主图](<../'+primary.file+'>)':preferred?'[截图](<'+folder+'/'+preferred+'>)':'无截图';return '| '+[i.code,i.name,i.result?.status||'待确认',String(i.result?.reason||'未完成').replaceAll('|','／').replace(/[\r\n]/g,' '),image,'[说明](<'+folder+'/判定说明.txt>)'].join(' | ')+' |';});
  await write(path.join('其他','本次筛选结果.md'),'# 本次筛选结果\n\n批次：'+run.id+'；任务状态：'+run.status+'。'+(run.status==='running'?'运行中快照，不能作为完整筛选结果。':'')+'\n\n符合'+counts['符合']+'、淘汰'+counts['淘汰']+'、待审核'+counts['待审核']+'。\n\n'+(run.error||'')+'\n\n| 代码 | 名称 | 判定 | 原因 | 图证 | 说明 |\n| --- | --- | --- | --- | --- | --- |\n'+lines.join('\n'),'本次筛选结果.md');
  Object.assign(m,{status:warnings.size?'partial':run.status==='running'?'writing':'completed',runStatus:run.status,marketDate:run.marketDate||run.quoteMarketDate||'',counts,stocks:[...stocks.values()],files:[...files.values()],quickView:{csv:'结果.csv',stocks:[...matched.values()]},warnings:[...warnings],updatedAt:new Date().toISOString()});
  await atomicJSON(path.join(other,'归档清单.json'),m);await atomicJSON(path.join(this.source,'桌面归档.json'),m);return m;
 }
}
