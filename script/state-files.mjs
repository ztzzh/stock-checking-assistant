// 本地状态写入：先写完整副本，再替换；Windows短暂占用只重试文件替换，不重跑选股。
import fs from 'node:fs/promises';
import path from 'node:path';
import {randomBytes} from 'node:crypto';

const pending=new Map(),transient=new Set(['EPERM','EACCES','EBUSY']);
const delays=[20,40,80,160,250,350,500,600];
export function atomicJSON(file,value,options){return atomicWrite(file,JSON.stringify(value,null,2),options);}
export async function atomicWrite(file,bytes,{io=fs,sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms))}={}){
 const target=path.resolve(file);
 // 调用时固定快照，按同一文件的调用顺序保存，避免并发写者覆盖较新的状态。
 const previous=pending.get(target)||Promise.resolve();
 const task=previous.catch(()=>{}).then(async()=>{
  const temp=target+'.'+process.pid+'-'+randomBytes(6).toString('hex')+'.tmp';
  try{
   await io.writeFile(temp,bytes);
   for(let attempt=0;;attempt++)try{await io.rename(temp,target);break;}
   catch(e){if(!transient.has(e.code)||attempt>=delays.length)throw e;await sleep(delays[attempt]);}
  }catch(cause){
   throw Object.assign(new Error(`保存 ${path.basename(target)} 失败（${cause.code||'IO_ERROR'}）：${cause.message}；上次记录未删除，本次临时记录：${temp}`,{cause}),{code:'STATE_SAVE_FAILED',ioCode:cause.code||'',file:target,temporaryFile:temp});
  }
 });
 pending.set(target,task);
 try{await task;}finally{if(pending.get(target)===task)pending.delete(target);}
}
