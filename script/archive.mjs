// 只复制筛选记录，不更改筛选判定、原始图片或原批次。
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {createHash} from 'node:crypto';
import {sourceName} from './sources.mjs';

const execute=promisify(execFile),groups=['符合','淘汰','待审核'];
const md=s=>String(s??'').replaceAll('|','／').replace(/[\r\n]/g,' ');
const time=value=>Number.isFinite(Date.parse(value))?new Date(value).toLocaleString('sv-SE',{timeZone:'Asia/Shanghai'})+'（北京时间）':'未取得';
export function safeFolderName(value,max=60){
 let text=String(value??'').normalize('NFC').replace(/[<>:"/\\|?*\x00-\x1f]/g,'_').trim().replace(/[. ]+$/g,'');
 text=Array.from(text).slice(0,max).join('').replace(/[. ]+$/g,'');
 if(!text||/^\.+$/.test(text))text='未命名';
 if(/^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)/i.test(text))text='_'+text;
 return text;
}
export function archiveNames(run,{taskName}={}){
 const d=new Date(run.startedAt);if(!Number.isFinite(d.getTime()))throw Error('任务开始时间缺失，不能确定归档日期');
 const parts=Object.fromEntries(new Intl.DateTimeFormat('en-GB',{timeZone:'Asia/Shanghai',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',hourCycle:'h23'}).formatToParts(d).map(p=>[p.type,p.value]));
 const names=run.sectors?.map(s=>s.name).join('_')||run.sector?.name||'选股任务';
 const suffix=run.resumeOf?'_补采':run.replayOf?'_原图重评':'';
 return{date:`${parts.year}年${Number(parts.month)}月${Number(parts.day)}日`,task:safeFolderName(taskName||names,56)+suffix+'_'+parts.hour+parts.minute+parts.second};
}
export async function desktopDirectory(){
 if(process.platform!=='win32')return path.join(os.homedir(),'Desktop');
 // Windows真实桌面可能已被用户移动或由OneDrive接管，不能写死USERPROFILE/Desktop。
 const {stdout}=await execute('powershell.exe',['-NoProfile','-NonInteractive','-Command',"[Console]::OutputEncoding=[System.Text.UTF8Encoding]::new($false); [Environment]::GetFolderPath([Environment+SpecialFolder]::DesktopDirectory)"],{windowsHide:true,timeout:10000,encoding:'utf8'});
 const desktop=stdout.replace(/^\uFEFF/,'').trim();if(!desktop||!path.isAbsolute(desktop))throw Error('Windows未返回有效桌面目录');return desktop;
}
async function uniqueDirectory(parent,name){
 await fs.mkdir(parent,{recursive:true});
 for(let n=1;n<=1000;n++){const dir=path.join(parent,name+(n===1?'':'_'+n));try{await fs.mkdir(dir);return dir;}catch(e){if(e.code!=='EEXIST')throw e;}}
 throw Error('同名任务目录过多，请使用其他任务名称');
}
const relative=p=>p.split(path.sep).join('/');
function within(root,target){const rel=path.relative(root,target);if(!rel||rel==='..'||rel.startsWith('..'+path.sep)||path.isAbsolute(rel))throw Error('归档路径超出任务目录');return target;}
function archiveFile(root,file){if(typeof file!=='string'||path.isAbsolute(file)||file.split(/[\\/]/).some(p=>!p||p==='.'||p==='..'))throw Error('归档文件相对路径异常');return within(root,path.resolve(root,file));}
export async function compactArchive(directory,run,{stockRoot,preserveEditedCSV=false}={}){
 const dir=path.resolve(directory);if(!stockRoot)throw Error('整理归档必须指定股票根目录');within(path.resolve(stockRoot),dir);
 const other=within(dir,path.join(dir,'其他'));
 const current=await fs.readFile(path.join(other,'归档清单.json'),'utf8').then(JSON.parse,e=>{if(e.code==='ENOENT')return null;throw e;});
 if(current?.layoutVersion===2){if(path.resolve(current.directory)!==dir||current.batchId!==run.id)throw Error('任务归档身份不符');return current;}
 const manifest=JSON.parse(await fs.readFile(path.join(dir,'归档清单.json'),'utf8'));
 if(path.resolve(manifest.directory)!==dir||manifest.batchId!==run.id)throw Error('任务归档身份不符');
 const top=await fs.readdir(dir);if(top.includes('其他'))throw Error('已有其他目录，停止整理以保留现有文件');
 const promotions=[],used=new Set(['结果.csv','其他']);
 const csv=manifest.files.find(f=>f.source==='结果.csv');if(csv)promotions.push({old:csv.file,file:'结果.csv'});
 for(const item of run.items.filter(i=>i.result?.status==='符合')){
  const entry=manifest.files.find(f=>f.source===item.chartFile);if(!entry)continue;
  const ext=path.extname(item.chartFile).toLowerCase();if(!['.png','.jpg','.jpeg','.webp'].includes(ext))throw Error('符合主图不是支持的图片格式');
  const name=safeFolderName(item.name,60);let file=name+ext;
  if(used.has(file.toLowerCase()))file=name+'_'+item.code+ext;
  if(used.has(file.toLowerCase()))throw Error('符合图片名称重复');used.add(file.toLowerCase());promotions.push({old:entry.file,file,code:item.code,name:item.name});
 }
 // 在移动目录之前核对全部提取项，任何路径/哈希问题都不触碰已有归档。
 const realDir=await fs.realpath(dir);
 for(const p of promotions){const from=archiveFile(dir,p.old),real=await fs.realpath(from);within(realDir,real);const stat=await fs.lstat(from);if(!stat.isFile()||stat.isSymbolicLink())throw Error('归档提取项不是普通文件');const entry=manifest.files.find(f=>f.file===p.old),sha=createHash('sha256').update(await fs.readFile(from)).digest('hex');if(sha!==entry.sha256){if(p.file==='结果.csv'&&entry.source==='结果.csv'&&preserveEditedCSV){manifest.preservedEdits=[...(manifest.preservedEdits||[]),{file:p.file,originalExportSHA256:entry.sha256,preservedSHA256:sha,note:'当前CSV在归档后被重新保存；整理仅保留当前字节，不回填旧版'}];entry.sha256=sha;entry.bytes=stat.size;}else throw Error('归档文件SHA256不符：'+p.old);}}
 await fs.mkdir(other);
 for(const name of top){const from=within(dir,path.join(dir,name)),to=within(other,path.join(other,name));await fs.rename(from,to);}
 for(const p of promotions){const from=archiveFile(other,p.old),to=within(dir,path.join(dir,p.file));if(await fs.lstat(to).then(()=>true,e=>{if(e.code==='ENOENT')return false;throw e;}))throw Error('任务根目录已有同名文件，未覆盖：'+p.file);await fs.rename(from,to);}
 const mapping=new Map(promotions.map(p=>[p.old,p.file]));
 manifest.files=manifest.files.map(f=>({...f,file:mapping.get(f.file)||'其他/'+f.file}));
 Object.assign(manifest,{layoutVersion:2,compactedAt:new Date().toISOString(),quickView:{csv:csv?'结果.csv':null,stocks:promotions.filter(p=>p.code).map(({old,...p})=>p)}});
 const reportFile=path.join(other,'本次筛选结果.md');let report=await fs.readFile(reportFile,'utf8');
 for(const p of promotions)report=report.replaceAll('(<'+p.old+'>)','(<../'+p.file+'>)');
 await fs.writeFile(reportFile,report);await fs.writeFile(path.join(other,'归档清单.json'),JSON.stringify(manifest,null,2));return manifest;
}
export async function archiveBatch(run,directory,{desktopDir,taskName}={}){
 if(run.rankingsOnly||run.selectionMode==='rankings-only'||run.status==='members_only')return{status:'skipped',reason:'仅排名或成分预览，不创建截图归档'};
 if(!Array.isArray(run.items)||run.items.some(i=>!/^\d{6}$/.test(i.code))||new Set(run.items.map(i=>i.code)).size!==run.items.length)throw Error('归档名单代码无效或重复');
 const source=path.resolve(directory),desktop=desktopDir||await desktopDirectory();if(!path.isAbsolute(desktop))throw Error('桌面目录必须为绝对路径');
 const names=archiveNames(run,{taskName}),destination=await uniqueDirectory(path.join(desktop,'股票',names.date),names.task);
 const manifest={status:'writing',batchId:run.id,sourceDirectory:source,directory:destination,taskName:names.task,dateFolder:names.date,archivedAt:new Date().toISOString(),runStatus:run.status,marketDate:run.marketDate||run.quoteMarketDate||'',originalBatch:run.resumeOf||run.replayOf||null,counts:Object.fromEntries(groups.map(g=>[g,0])),files:[],warnings:[]};
 const warn=message=>manifest.warnings.push(message);
 async function copy(file,target,{required=true,expectedHash}={}){
  if(typeof file!=='string'||path.basename(file)!==file||/[\\/]/.test(file)){warn('文件名不安全，未复制：'+String(file));return false;}
  try{
   const from=path.join(source,file),info=await fs.lstat(from);if(!info.isFile()||info.isSymbolicLink()||info.size>20*1024*1024)throw Error('不是普通文件或超过20MB');
   const bytes=await fs.readFile(from),sha256=createHash('sha256').update(bytes).digest('hex');if(expectedHash&&sha256!==expectedHash)throw Error('SHA256与筛选图证不符');
   const to=path.join(destination,target);await fs.copyFile(from,to,fs.constants.COPYFILE_EXCL);
   manifest.files.push({source:file,file:relative(target),bytes:info.size,sha256});return true;
  }catch(e){if(required||e.code!=='ENOENT')warn(file+'：'+e.message);return false;}
 }
 const summary=[];
 for(const group of groups)await fs.mkdir(path.join(destination,group));
 for(const item of run.items){
  const group=['符合','淘汰'].includes(item.result?.status)?item.result.status:'待审核';manifest.counts[group]++;
  const folder=path.join(group,item.code+'_'+safeFolderName(item.name,36));await fs.mkdir(path.join(destination,folder));
  const files=new Map(),add=(file,hash)=>{if(file)files.set(file,hash||files.get(file));};
  for(const image of run.images||[])if(image.file?.startsWith(item.code+'-')&&/\.(png|jpe?g|webp)$/i.test(image.file))add(image.file);
  add(item.chartFile,item.imageSHA256);add(item.quoteFile);
  for(const p of [...(item.periodFiles||[]),...(item.parameterFiles||[])])add(p.file,p.imageSHA256);
  const copied=[],before=manifest.warnings.length;
  for(const [file,hash]of files)if(await copy(file,path.join(folder,file),{expectedHash:hash}))copied.push(file);
  const reason=item.result?.reason||item.captureError||'未完成判定';
  let provider;try{provider=sourceName(item.marketSource||item.quoteSnapshot?.source||run.marketSource||'eastmoney');}catch{provider='来源未确认';}
  const notes=[`股票：${item.code} ${item.name}`,`分类：${group}；脚本原判定：${item.result?.status||'待确认'}`,`原因：${reason}`,`任务批次：${run.id}；任务状态：${run.status}`,`行情来源：${provider}`,`所属板块：${item.memberships?.map(m=>m.name).join('、')||run.sector?.name||''}`,`报价时点：${time(item.quoteSnapshot?.capturedAt)}；页面日期：${item.quoteSnapshot?.dateText||'未取得'}`,`图表采集时点：${time(item.capturedAt)}`,`现价：${item.price??'缺失'}；今开：${item.open??'缺失'}`,`沿用原图：${run.replayOf||run.resumeOf&&!(run.resumeCaptureCodes||run.resumePendingCodes||[]).includes(item.code)?'是，保留原采集时点':'否'}`,`原始记录：${source}`,'',...(copied.length?['已保存截图：',...copied]:['本只没有可复制截图。未采到图不生成占位行情图；请查看缺项原因。']),...manifest.warnings.slice(before).map(w=>'归档缺项：'+w)];
  await fs.writeFile(path.join(destination,folder,'判定说明.txt'),'\ufeff'+notes.join('\r\n'));
  const preferred=copied.includes(item.chartFile)?item.chartFile:copied[0],link=preferred?'[截图](<'+relative(path.join(folder,preferred))+'>)':'无截图';
  summary.push('| '+[item.code,md(item.name),group,md(provider),md(reason),link].join(' | ')+' |');
 }
 const records=path.join(destination,'原始记录');await fs.mkdir(records);
 for(const file of ['run.json','结果.csv','指定板块.json','板块成分目录.json','原批次.json'])await copy(file,path.join('原始记录',file),{required:['run.json','结果.csv'].includes(file)});
 // 无代码前缀的验证/失败现场单独保存，不能归给某只股票或当作有效图证。
 const common=(run.images||[]).filter(i=>!/^\d{6}-/.test(i.file||''));
 const listed=new Set(common.map(i=>i.file));for(const file of ['验证现场.png','失败页面.png'])if(!listed.has(file))common.push({file,optional:true});
 if(common.length){await fs.mkdir(path.join(destination,'任务现场'));for(const p of common)await copy(p.file,path.join('任务现场',String(p.file)),{required:!p.optional});}
 manifest.status=manifest.warnings.length?'partial':'completed';
 const complete=run.status==='completed'&&!run.error&&manifest.counts['待审核']===0;
 const report=`# 本次筛选结果\n\n任务：${names.task}\n\n批次：${run.id}；原任务状态：${run.status}；${complete?'本批判定已完成。':'本批仍有未完成、待审核或仅采集项目，不能作为完整筛选结果。'}\n\n行情日：${manifest.marketDate||'未确认'}；开始：${run.startedAt}；结束：${run.finishedAt||'未记录'}。\n\n符合${manifest.counts['符合']}只，淘汰${manifest.counts['淘汰']}只，待审核${manifest.counts['待审核']}只。待审核对应脚本“待确认”，包括证据不清、采集失败及未访问项。\n\n${run.error?'未完成原因：'+md(run.error)+'\n\n':''}原始记录目录：${source}\n\n${run.resumeOf||run.replayOf?'本任务包含原批次沿用项；每只说明和原图均保留实际来源、采集时点，不能把旧图当成本次新图。\n\n':''}| 代码 | 名称 | 分类 | 来源 | 原因 | 图证 |\n| --- | --- | --- | --- | --- | --- |\n${summary.join('\n')}\n\n归档状态：${manifest.status}。${manifest.warnings.length?'存在归档缺项，详见下列记录。':'原始文件均保留，本目录为分类副本。'}\n${manifest.warnings.map(w=>'- '+md(w)).join('\n')}\n`;
 await fs.writeFile(path.join(destination,'本次筛选结果.md'),report);
 await fs.writeFile(path.join(destination,'归档清单.json'),JSON.stringify(manifest,null,2));return compactArchive(destination,run,{stockRoot:path.join(desktop,'股票')});
}

export async function archiveAfterRun(run,directory,cfg={}, {archive=archiveBatch,log=console.log}={}){
 if(run.rankingsOnly||run.selectionMode==='rankings-only'||run.status==='members_only')return{status:'skipped'};
 let receipt;try{receipt=await archive(run,directory,{taskName:cfg['task-name']});log('桌面归档：'+receipt.directory+(receipt.status==='partial'?'（部分文件未复制，详见归档清单）':''));}
 catch(e){receipt={status:'failed',error:e.message,at:new Date().toISOString()};log('桌面归档失败：'+e.message+'；筛选结果仍保存在：'+directory);}
 try{await fs.writeFile(path.join(directory,'桌面归档.json'),JSON.stringify(receipt,null,2));}catch(e){log('归档状态记录未写入：'+e.message);}
 return receipt;
}
