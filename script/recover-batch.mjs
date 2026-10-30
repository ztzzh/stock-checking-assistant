// 后端意外退出时只导出已保存快照，不重采、不调用模型、不覆盖原run.json。
import fs from 'node:fs/promises';import path from 'node:path';import {pathToFileURL} from 'node:url';import {createHash} from 'node:crypto';
import {LiveArchiveSession} from './live-archive.mjs';import {refreshResultCounts} from './screen.mjs';import {guiSnapshot} from './gui-protocol.mjs';import {atomicJSON} from './state-files.mjs';
export async function recoverSavedBatch(directory,{exitCode,error='后端意外结束',desktopDir,log=()=>{}}={}){
 const source=path.resolve(directory),bytes=await fs.readFile(path.join(source,'run.json'),'utf8'),run=JSON.parse(bytes.replace(/^\uFEFF/,''));
 if(run.status==='members_only'||run.rankingsOnly||!run.items?.length)return{status:'skipped',message:'本次没有个股筛选记录，无需归档'};
 if(run.status==='running'){run.status='interrupted';run.finishedAt=new Date().toISOString();run.error=error+'（退出码'+exitCode+'），已按最后保存的快照补存桌面；未完成项保留待审核';run.errorCode='RECOVERED_AFTER_PROCESS_EXIT';}
 if(run.pipeline){run.pipeline.capture={...run.pipeline.capture,status:'interrupted',detail:'进程已结束，原图和已完成判定已补存'};run.pipeline.review={...run.pipeline.review,status:'interrupted',detail:'未收到的判定仍待审核',active:0};}
 refreshResultCounts(run);const session=new LiveArchiveSession(source,{}, {desktopDir,log}),receipt=await session.flush(run);
 if(receipt.status==='failed')throw Error('异常退出后的桌面归档仍未完成：'+receipt.error);
 await atomicJSON(path.join(source,'异常退出归档.json'),{exitCode,error,archivedAt:new Date().toISOString(),originalSHA256:createHash('sha256').update(bytes).digest('hex'),desktop:receipt.directory,counts:run.counts,policy:'仅导出最后已保存快照，原始run.json保留，不重采或调用模型'});
 return{status:receipt.status,archiveDirectory:receipt.directory,archiveError:receipt.status==='partial'?'部分文件未归档，请查看其他/归档清单.json':'',message:run.error||error,snapshot:guiSnapshot(run,source)};
}
if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href){recoverSavedBatch(process.argv[2],{exitCode:Number(process.argv[3]||1)}).then(result=>console.log(JSON.stringify(result))).catch(e=>{console.log(JSON.stringify({status:'failed',message:e.message}));process.exitCode=2;});}
