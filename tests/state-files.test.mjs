import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {spawn} from 'node:child_process';
import {atomicJSON} from '../script/state-files.mjs';

async function temp(t){const d=await fs.mkdtemp(path.join(os.tmpdir(),'stock-state-'));t.after(async()=>{assert.equal(path.dirname(d),path.resolve(os.tmpdir()));assert(path.basename(d).startsWith('stock-state-'));await fs.rm(d,{recursive:true,force:true});});return d;}
test('Windows短暂替换失败只重试本地保存，等待时保留完整旧记录',async t=>{
 const d=await temp(t),file=path.join(d,'run.json');await atomicJSON(file,{status:'running'});let attempts=0;const delays=[];
 await atomicJSON(file,{status:'completed'},{io:{...fs,rename:async(...args)=>{if(++attempts<=2)throw Object.assign(Error('软件夹具占用'),{code:'EPERM'});return fs.rename(...args);}},sleep:async ms=>{delays.push(ms);assert.deepEqual(JSON.parse(await fs.readFile(file,'utf8')),{status:'running'});}});
 assert.equal(attempts,3);assert.deepEqual(delays,[20,40]);assert.deepEqual(JSON.parse(await fs.readFile(file,'utf8')),{status:'completed'});assert.deepEqual(await fs.readdir(d),['run.json']);
});
test('同一文件并发保存按调用顺序，调用后的对象变化不污染已排队快照',async t=>{
 const d=await temp(t),file=path.join(d,'run.json'),value={sequence:1};let release;const gate=new Promise(r=>release=r);const io={...fs,rename:async(...args)=>{await gate;return fs.rename(...args);}};
 const first=atomicJSON(file,value,{io});value.sequence=2;const second=atomicJSON(file,value,{io});value.sequence=99;release();await Promise.all([first,second]);assert.deepEqual(JSON.parse(await fs.readFile(file,'utf8')),{sequence:2});assert.deepEqual(await fs.readdir(d),['run.json']);
});
test('持续占用有等待上限，旧记录与新临时记录保留，后续保存仍能工作',async t=>{
 const d=await temp(t),file=path.join(d,'run.json');await atomicJSON(file,{sequence:1});let attempts=0;let failed;
 await assert.rejects(atomicJSON(file,{sequence:2},{io:{...fs,rename:async()=>{attempts++;throw Object.assign(Error('persistent sharing violation'),{code:'EPERM'});}},sleep:async()=>{}}),e=>{failed=e;return e.code==='STATE_SAVE_FAILED'&&e.ioCode==='EPERM'&&e.file===file;});
 assert.equal(attempts,9);assert.deepEqual(JSON.parse(await fs.readFile(file,'utf8')),{sequence:1});assert.deepEqual(JSON.parse(await fs.readFile(failed.temporaryFile,'utf8')),{sequence:2});await atomicJSON(file,{sequence:3});assert.equal(JSON.parse(await fs.readFile(file,'utf8')).sequence,3);
});
test('非占用类错误不做无效重试，保留具体底层错误',async t=>{
 const d=await temp(t);let attempts=0;await assert.rejects(atomicJSON(path.join(d,'run.json'),{}, {io:{...fs,rename:async()=>{attempts++;throw Object.assign(Error('missing destination directory'),{code:'ENOENT'});}},sleep:()=>{throw Error('不应等待');}}),e=>e.ioCode==='ENOENT');assert.equal(attempts,1);
});
test('Windows真实文件共享锁释放后能完成替换，等待期间旧JSON保持可读',{skip:process.platform!=='win32'},async t=>{
 const d=await temp(t),file=path.join(d,'run.json');await atomicJSON(file,{status:'running'});
 const command="$stream=[IO.File]::Open($env:SCREENING_STATE_LOCK_TARGET,[IO.FileMode]::Open,[IO.FileAccess]::Read,[IO.FileShare]::Read); try { [Console]::Out.WriteLine('locked'); [Console]::Out.Flush(); Start-Sleep -Milliseconds 600 } finally { $stream.Dispose() }";
 const child=spawn('powershell.exe',['-NoProfile','-NonInteractive','-Command',command],{env:{...process.env,SCREENING_STATE_LOCK_TARGET:file},windowsHide:true,stdio:['ignore','pipe','pipe']});
 const closed=new Promise(resolve=>child.on('close',resolve));let observed=0;
 try{
  await new Promise((resolve,reject)=>{child.once('error',reject);child.stdout.on('data',b=>{if(b.toString().includes('locked'))resolve();});child.on('close',code=>reject(Error('锁进程提前退出：'+code)));});
  await atomicJSON(file,{status:'completed'},{io:{...fs,rename:async(...args)=>{try{return await fs.rename(...args);}catch(e){if(['EPERM','EACCES','EBUSY'].includes(e.code))observed++;throw e;}}}});
  assert(observed>0,'必须确实遇到Windows文件替换占用');assert.equal(JSON.parse(await fs.readFile(file,'utf8')).status,'completed');assert.equal(await closed,0);
 }finally{if(child.exitCode===null){child.kill();await closed;}}
});
