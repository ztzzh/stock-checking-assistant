// 窗口通信软件夹具；不访问行情、真实模型或用户桌面。
import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs/promises';import path from 'node:path';import os from 'node:os';import {PassThrough} from 'node:stream';
import {requestArgs,resolveBatchDirectory,guiSnapshot,GuiControl,serveGUI} from '../script/gui-protocol.mjs';
import {EventEmitter} from 'node:events';import {bindTaskStop,ActiveBudget} from '../script/budget.mjs';import {TaskPause} from '../script/task-pause.mjs';
const base={command:'start',mode:'normal',source:'sina',sectors:['合成行业','合成概念'],limit:10,captureSeconds:300,reviewSeconds:180,taskName:''};
async function temp(t){const d=await fs.mkdtemp(path.join(os.tmpdir(),'stock-gui-'));t.after(async()=>{assert.equal(path.dirname(d),path.resolve(os.tmpdir()));assert(path.basename(d).startsWith('stock-gui-'));await fs.rm(d,{recursive:true,force:true});});return d;}
test('窗口各方式直接调用现有参数，正常选股不混入历史排名；参数始终为独立argv',async t=>{
 const dir=await temp(t),args=await requestArgs(base,dir);assert(args.includes('--sectors'));assert.equal(args[args.indexOf('--sectors')+1],'合成行业,合成概念');assert.equal(args[args.indexOf('--source')+1],'sina');assert(!args.includes('--rank'));
 for(const [mode,flag]of[['members','--members-only'],['capture','--capture-only'],['login','--login'],['check','--check'],['browser','--check-browser']])assert((await requestArgs({...base,mode},dir)).includes(flag));
 const literal='午盘 " & echo no-command';const named=await requestArgs({...base,taskName:literal},dir);assert.equal(named[named.indexOf('--task-name')+1],literal);
 for(const change of [{mode:'unknown'},{source:'toString'},{sectors:[]},{sectors:['a,b']},{limit:11},{captureSeconds:0},{reviewSeconds:4000}])await assert.rejects(requestArgs({...base,...change},dir));
});
test('全部成分开关在新任务传到脚本，原图复核和继续任务继承原范围',async t=>{
 const root=await temp(t),batch=path.join(root,'full');await fs.mkdir(batch);await fs.writeFile(path.join(batch,'run.json'),JSON.stringify({id:'full'}));
 for(const mode of ['normal','members','capture'])assert((await requestArgs({...base,mode,allMembers:true},root)).includes('--all-members'));
 for(const mode of ['resume','review'])assert(!(await requestArgs({...base,mode,allMembers:true,batchDirectory:batch},root)).includes('--all-members'));
 assert(!(await requestArgs({...base,allMembers:false},root)).includes('--all-members'));await assert.rejects(requestArgs({...base,allMembers:'true'},root),/须为开关/);
});
test('窗口支持选择项目批次或精简桌面目录，重评不传source，补采沿用原名单',async t=>{
 const root=await temp(t),batch=path.join(root,'batch'),archive=path.join(root,'desktop');await fs.mkdir(batch);await fs.mkdir(path.join(archive,'其他'),{recursive:true});await fs.writeFile(path.join(batch,'run.json'),JSON.stringify({id:'same'}));
 const manifest=path.join(archive,'其他','归档清单.json');await fs.writeFile(manifest,JSON.stringify({sourceDirectory:batch,batchId:'same'}));assert.equal(await resolveBatchDirectory(archive),batch);
 for(const [mode,flag]of[['resume','--resume'],['review','--review-only']]){const args=await requestArgs({...base,mode,batchDirectory:archive},root);assert.equal(args[args.indexOf(flag)+1],batch);assert(!args.includes('--sectors'));if(mode==='review')assert(!args.includes('--source'));}
 await fs.writeFile(manifest,JSON.stringify({sourceDirectory:batch,batchId:'other'}));await assert.rejects(resolveBatchDirectory(archive),/身份不一致/);
});
test('进度只依据本任务run.json，待审核包含未访问，完成前不伪造100%',()=>{
 const run={id:'fixture',status:'running',items:[{result:{status:'符合'},attemptedAt:'now',chartFile:'x',review:{},reviewImageSHA256:'sha',imageSHA256:'sha'},{result:{status:'淘汰'},quoteSnapshot:{}},{result:{status:'待确认'}}]};const s=guiSnapshot(run,'/test');assert.equal(s.passed,1);assert.equal(s.eliminated,1);assert.equal(s.pending,1);assert.equal(s.unvisited,1);assert.equal(s.visited,2);assert.equal(s.reviewed,1);assert(s.percent<100);
});
test('人工继续只接受当前确认编号；停止/预算中断解除等待，不自动处理验证',async()=>{
 const events=[],c=new GuiControl(e=>events.push(e));let done=false;const p=c.waitForUser({message:'软件验证'}).then(()=>done=true);c.continue(9);await Promise.resolve();assert.equal(done,false);c.continue(1);await p;assert.equal(done,true);assert.equal(events.at(-1).type,'waiting-ended');
 const abort=new AbortController(),q=c.waitForUser({signal:abort.signal});abort.abort(Error('软件预算停止'));await assert.rejects(q,/预算停止/);assert.equal(c.pending,null);
 const z=c.waitForUser({});c.stop();await assert.rejects(z,e=>e.code==='USER_CANCELLED');
});
test('完整握手、保存快照和收尾，重复开始不能并发两批',async t=>{
 const root=await temp(t),input=new PassThrough(),events=[];let calls=0;
 const emit=e=>{events.push(e);if(e.type==='waiting')input.write(JSON.stringify({command:'continue',id:e.id})+'\n');};
 const promise=serveGUI({root,input,emit,interrupt:()=>{},run:async(args,ui)=>{
  calls++;const output=args[args.indexOf('--output-dir')+1],dir=path.join(output,'fixture');await fs.mkdir(dir);const run={id:'fixture',status:'running',items:[{code:'300001',result:{status:'待确认'}}]};await fs.writeFile(path.join(dir,'run.json'),JSON.stringify(run));
  await ui.waitForUser({kind:'verification',message:'软件合成验证'});run.status='completed';run.items[0].result={status:'淘汰'};run.items[0].quoteSnapshot={};await fs.writeFile(path.join(dir,'run.json'),JSON.stringify(run));await fs.writeFile(path.join(dir,'桌面归档.json'),JSON.stringify({status:'completed',directory:path.join(root,'archive')}));return 0;
 }});
 input.write(JSON.stringify(base)+'\n');input.write(JSON.stringify(base)+'\n');await promise;input.destroy();assert.equal(calls,1);const last=events.find(e=>e.type==='finished');assert.equal(last.exitCode,0);assert.equal(last.stopped,false);assert.equal(last.snapshot.eliminated,1);assert.equal(last.snapshot.batchId,'fixture');assert(last.archiveDirectory.endsWith('archive'));assert(events.some(e=>e.type==='log'&&e.message.includes('重复')));
});
test('窗口关闭输入管道也会停止并保留中断快照',async t=>{
 const root=await temp(t),input=new PassThrough(),events=[];let interrupts=0;
 const p=serveGUI({root,input,emit:e=>{events.push(e);if(e.type==='waiting')input.end();},interrupt:()=>interrupts++,run:async(args,ui)=>{const out=args[args.indexOf('--output-dir')+1],dir=path.join(out,'fixture');await fs.mkdir(dir);const r={id:'fixture',status:'running',items:[]};try{await ui.waitForUser({kind:'verification'});}catch(e){r.status='interrupted';r.error=e.message;await fs.writeFile(path.join(dir,'run.json'),JSON.stringify(r));return 2;}}});input.write(JSON.stringify(base)+'\n');await p;const last=events.find(e=>e.type==='finished');assert.equal(last.stopped,true);assert.equal(last.snapshot.status,'interrupted');assert(interrupts>0);
});

test('窗口停止直接中断任务，不广播会使浏览器库退出130的SIGINT；启动中的停止也不丢失',async t=>{
 const root=await temp(t),input=new PassThrough(),events=[];let globalStops=0,settled=false;
 const browserListener=()=>globalStops++;process.on('SIGINT',browserListener);t.after(()=>process.off('SIGINT',browserListener));
 const p=serveGUI({root,input,emit:e=>events.push(e),run:async(args,ui)=>{
  // 模拟停止发生在浏览器/模型登录检查完成前，稍后才建立本任务控制器。
  input.write('{"command":"stop"}\n');await Promise.resolve();
  const controller=new AbortController(),release=bindTaskStop(controller,{signal:ui.signal});
  try{assert.equal(controller.signal.aborted,true);assert.equal(controller.signal.reason.code,'USER_CANCELLED');settled=true;return 2;}finally{release();}
 }});input.write(JSON.stringify(base)+'\n');await p;input.destroy();
 assert.equal(settled,true);assert.equal(globalStops,0);assert.equal(events.at(-1).type,'finished');assert.equal(events.at(-1).stopped,true);assert(events.some(e=>e.type==='log'&&/收到窗口停止请求/.test(e.message)));
});

test('任务停止绑定保留原中断原因，CLI重复Ctrl+C仍走保存流程，收尾移除监听',()=>{
 const processEvents=new EventEmitter(),ui=new AbortController(),controller=new AbortController();const release=bindTaskStop(controller,{signal:ui.signal,processEvents});
 const reason=Object.assign(Error('窗口停止保存'),{code:'USER_CANCELLED'});ui.abort(reason);assert.equal(controller.signal.reason,reason);processEvents.emit('SIGINT');assert.equal(controller.signal.reason,reason);release();assert.equal(processEvents.listenerCount('SIGINT'),0);
 const cli=new AbortController(),cleanup=bindTaskStop(cli,{message:'命令行停止',processEvents});processEvents.emit('SIGINT');processEvents.emit('SIGINT');assert.equal(cli.signal.reason.message,'命令行停止');assert.equal(cli.signal.reason.code,'USER_CANCELLED');cleanup();assert.equal(processEvents.listenerCount('SIGINT'),0);
});
test('暂停等待在途保存后确认，继续只释放剩余工作；暂停期间停止可解除等待',async()=>{
 const pause=new TaskPause(),controller=new AbortController(),states=[];pause.subscribe(s=>states.push(s.status));const release=await pause.enter(controller.signal);pause.pause();assert.equal(pause.state().status,'pausing');
 let entered=false;const next=pause.run(()=>{entered=true;},controller.signal);await Promise.resolve();assert.equal(entered,false);release();release();assert.equal(pause.active,0);assert.equal(pause.state().status,'paused');pause.resume();await next;assert.equal(entered,true);assert.equal(pause.active,0);assert(states.includes('pausing')&&states.includes('paused'));
 pause.pause();const waiting=pause.wait(controller.signal);controller.abort(Object.assign(Error('暂停中停止'),{code:'USER_CANCELLED'}));await assert.rejects(waiting,/暂停中停止/);assert.equal(pause.waiters.size,0);
});

test('用户暂停后阶段resume不能重启预算；继续时仍保留空闲阶段的暂停状态',async()=>{
 let now=0;const clock={now:()=>now,schedule:()=>1,cancel:()=>{}},budget=new ActiveBudget(1000,()=>{},clock),pause=new TaskPause({now:clock.now}),unbind=pause.bindBudget(budget);const release=await pause.enter();now=200;pause.pause();assert.equal(budget.started,0);release();assert.equal(budget.remaining,800);assert.equal(budget.started,null);
 now=5200;assert.equal(pause.pausedMs,5000);budget.resume();assert.equal(budget.started,null);pause.resume();assert.equal(pause.pausedMs,5000);assert.equal(budget.started,5200);now=5300;pause.pause();assert.equal(budget.remaining,700);budget.pause();pause.resume();assert.equal(budget.started,null);assert.equal(budget.shouldRun,false);unbind();budget.dispose();
});

test('GUI暂停继续命令保持同一run调用与人工确认编号，完成前不会提前结束',async t=>{
 const root=await temp(t),input=new PassThrough(),events=[];let calls=0,continued=false;
 const p=serveGUI({root,input,emit:e=>{events.push(e);if(e.type==='pause-state'&&e.status==='paused')setImmediate(()=>input.write('{"command":"resume"}\n'));},run:async(_args,ui)=>{
  calls++;input.write('{"command":"pause"}\n');assert(ui.pause.requested);await ui.pause.wait(ui.signal);continued=true;return 0;
 }});input.write(JSON.stringify(base)+'\n');await p;input.destroy();assert.equal(calls,1);assert.equal(continued,true);assert.equal(events.at(-1).exitCode,0);assert(events.find(e=>e.type==='pause-state'&&e.status==='paused'));
});

test('主脚本返回2但没有抛异常时，完成事件携带落盘失败原因，不丢失全部已判定数量',async t=>{
 const root=await temp(t),input=new PassThrough(),events=[];
 const p=serveGUI({root,input,emit:e=>events.push(e),interrupt:()=>{},run:async args=>{const out=args[args.indexOf('--output-dir')+1],dir=path.join(out,'fixture');await fs.mkdir(dir);await fs.writeFile(path.join(dir,'run.json'),JSON.stringify({status:'running',items:[{code:'300001',result:{status:'淘汰'},quoteSnapshot:{}}]}));await fs.writeFile(path.join(dir,'启动失败.json'),JSON.stringify({error:"EPERM: operation not permitted, rename 'run.json.tmp' -> 'run.json'",errorCode:'EPERM'}));return 2;}});
 input.write(JSON.stringify(base)+'\n');await p;input.destroy();const last=events.at(-1);assert.equal(last.type,'finished');assert.equal(last.exitCode,2);assert.match(last.error,/EPERM/);assert.match(last.errorSummary,/保存结果失败.*EPERM.*run.json/);assert.equal(last.snapshot.eliminated,1);assert.equal(last.snapshot.pending,0);assert.equal(last.archiveDirectory,'');
});
test('失败记录也写不出时仍通过回调传递原因；归档失败和股票判定分别呈现',async t=>{
 for(const archiveFailure of [false,true]){
  const root=await temp(t),input=new PassThrough(),events=[];const p=serveGUI({root,input,emit:e=>events.push(e),interrupt:()=>{},run:async(args,ui)=>{if(!archiveFailure){ui.onFailure({error:'磁盘写入失败的详细原因',errorCode:'STATE_SAVE_FAILED',ioCode:'EPERM',failedFile:'run.json'});return 2;}
   const dir=path.join(args[args.indexOf('--output-dir')+1],'fixture');await fs.mkdir(dir);await fs.writeFile(path.join(dir,'run.json'),JSON.stringify({status:'completed',items:[]}));await fs.writeFile(path.join(dir,'桌面归档.json'),JSON.stringify({status:'failed',error:'桌面目标被占用'}));return 0;}});
  input.write(JSON.stringify(base)+'\n');await p;input.destroy();const e=events.at(-1);if(archiveFailure){assert.equal(e.exitCode,0);assert.equal(e.archiveError,'桌面目标被占用');assert.equal(e.archiveDirectory,'');}else{assert.equal(e.errorCode,'STATE_SAVE_FAILED');assert.match(e.errorSummary,/EPERM/);assert.equal(e.error,'磁盘写入失败的详细原因');}
 }
});
