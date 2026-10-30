// 归档文件系统测试。使用合成图片字节，不生成真实股票判定，不写用户桌面。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {archiveNames,safeFolderName,archiveBatch,archiveAfterRun,compactArchive} from '../script/archive.mjs';
import {options} from '../script/screen.mjs';
const bytes=Buffer.from('合成图片，不是真实行情'),sha=createHash('sha256').update(bytes).digest('hex');
async function fixture(t){
 const temp=await fs.mkdtemp(path.join(os.tmpdir(),'stock-archive-'));
 t.after(async()=>{assert.equal(path.dirname(temp),path.resolve(os.tmpdir()));assert(path.basename(temp).startsWith('stock-archive-'));await fs.rm(temp,{recursive:true,force:true});});
 const source=path.join(temp,'原始批次'),desktopDir=path.join(temp,'模拟已重定向的桌面');await fs.mkdir(source);await fs.mkdir(desktopDir);
 const statuses=['符合','淘汰','待确认'],items=statuses.map((status,n)=>({code:String(300001+n),name:['合成通过','合成报价淘汰','合成待审核'][n],marketSource:'sina',price:'12',open:'11',quoteSnapshot:{source:'sina',dateText:'2026-10-26 15:00',capturedAt:'2026-10-26T04:00:00Z'},result:{status,reason:'合成'+status+'原因'}}));
 items[0].chartFile='300001-15分钟.png';items[0].imageSHA256=sha;items[0].capturedAt='2026-10-26T04:00:01Z';items[0].periodFiles=[{file:'300001-周期1.png',imageSHA256:sha}];items[0].parameterFiles=[{file:'300001-MA参数1.png',parameters:[5,10,20,60],imageSHA256:sha}];
 const images=['300001-15分钟.png','300001-报价.png','300001-周期1.png','300001-MA参数1.png','300002-报价.png','300003-图表未就绪.png'].map(file=>({file,label:'合成证据'}));
 const run={id:'synthetic-archive',kind:'standalone-visual-script',status:'completed',startedAt:'2026-10-26T03:30:12Z',finishedAt:'2026-10-26T03:31:00Z',marketDate:'2026-10-26',marketSource:'sina',sectors:[{name:'合成板块A'},{name:'合成板块B'}],items,images};
 for(const i of images)await fs.writeFile(path.join(source,i.file),bytes);await fs.writeFile(path.join(source,'run.json'),JSON.stringify(run));await fs.writeFile(path.join(source,'结果.csv'),'合成结果');
 return{temp,source,desktopDir,run};
}
test('按北京时间开始日归档，自动任务名与手动名均安全且保留补采/重评标识',()=>{
 assert.deepEqual(archiveNames({startedAt:'2026-10-26T16:00:01Z',sectors:[{name:'物理AI'},{name:'数字媒体'}]}),{date:'2026年10月27日',task:'物理AI_数字媒体_000001'});
 assert.equal(archiveNames({startedAt:'2026-10-26T03:30:00Z',resumeOf:{},sectors:[{name:'原板块'}]},{taskName:'午盘/第一轮'}).task,'午盘_第一轮_补采_113000');
 assert.match(archiveNames({startedAt:'2026-10-26T03:30:00Z',replayOf:{}}).task,/_原图重评_/);assert.throws(()=>archiveNames({startedAt:'bad'}),/开始时间/);
 for(const name of ['CON','prn.txt','LPT1','A/B:C*D?','..','  ','尾部. ']){const safe=safeFolderName(name);assert(!/[<>:"/\\|?*]/.test(safe));assert(!/[. ]$/.test(safe));assert(!/^(CON|PRN|LPT1)(?:\.|$)/i.test(safe));}assert.equal(Array.from(safeFolderName('长'.repeat(120))).length,60);
 assert.equal(options(['--sectors','合成','--task-name','午盘'])['task-name'],'午盘');
});
test('按最终判定复制所有截图、参数与周期图；报价淘汰不伪造15分图，原文件不变',async t=>{
 const f=await fixture(t),before=JSON.stringify(f.run),original=await fs.readFile(path.join(f.source,'run.json'));
 const r=await archiveBatch(f.run,f.source,{desktopDir:f.desktopDir});assert.equal(r.status,'completed');assert.deepEqual(r.counts,{符合:1,淘汰:1,待审核:1});assert(r.directory.startsWith(path.join(f.desktopDir,'股票','2026年10月26日')));
 const chart=path.join(r.directory,'合成通过.png');assert.deepEqual(await fs.readFile(chart),bytes);assert.deepEqual((await fs.readdir(r.directory)).sort(),['其他','合成通过.png','结果.csv'].sort());assert.deepEqual(await fs.readFile(path.join(r.directory,'结果.csv')),await fs.readFile(path.join(f.source,'结果.csv')));
 assert.equal((await fs.readdir(path.join(r.directory,'其他','符合','300001_合成通过'))).length,4);assert.equal((await fs.readdir(path.join(r.directory,'其他','淘汰','300002_合成报价淘汰'))).length,2);
 assert.equal(r.files.filter(f=>/300001-/.test(f.source)).length,4);assert(r.files.every(f=>f.sha256.length===64));
 const report=await fs.readFile(path.join(r.directory,'其他','本次筛选结果.md'),'utf8');assert.match(report,/待审核1只/);assert.match(report,/不能作为完整筛选结果/);assert.match(report,/\.\.\/合成通过.png/);
 const notes=await fs.readFile(path.join(r.directory,'其他','待审核','300003_合成待审核','判定说明.txt'),'utf8');assert.match(notes,/合成待确认原因/);assert.match(notes,/新浪财经/);assert.match(notes,/2026-10-26 15:00/);
 assert.equal(JSON.stringify(f.run),before);assert.deepEqual(await fs.readFile(path.join(f.source,'run.json')),original);for(const i of f.run.images)assert.deepEqual(await fs.readFile(path.join(f.source,i.file)),bytes);
});
test('同日同名同秒任务另建目录，已有日期、任务和无关文件都不覆盖',async t=>{
 const f=await fixture(t),a=await archiveBatch(f.run,f.source,{desktopDir:f.desktopDir,taskName:'午盘'});await fs.writeFile(path.join(a.directory,'人工备注.txt'),'保留');
 const b=await archiveBatch(f.run,f.source,{desktopDir:f.desktopDir,taskName:'午盘'});assert.notEqual(a.directory,b.directory);assert.equal(b.directory,a.directory+'_2');assert.equal(await fs.readFile(path.join(a.directory,'人工备注.txt'),'utf8'),'保留');assert.equal((await fs.readdir(path.dirname(a.directory))).length,2);
});
test('中断、未访问和仅采图保存待审核说明，沿用证据明确原时间且不改旧判定',async t=>{
 const f=await fixture(t);f.run.status='interrupted';f.run.error='合成采集超时';f.run.resumeOf={id:'older'};f.run.resumeCaptureCodes=['300003'];f.run.items[2].result.reason='尚未访问';f.run.images=f.run.images.filter(i=>!i.file.startsWith('300003-'));delete f.run.items[2].quoteSnapshot;
 const r=await archiveBatch(f.run,f.source,{desktopDir:f.desktopDir});assert.equal(r.status,'completed');
 const notes=await fs.readFile(path.join(r.directory,'其他','待审核','300003_合成待审核','判定说明.txt'),'utf8');assert.match(notes,/尚未访问/);assert.match(notes,/没有可复制截图/);assert.match(notes,/报价时点：未取得/);
 const old=await fs.readFile(path.join(r.directory,'其他','符合','300001_合成通过','判定说明.txt'),'utf8');assert.match(old,/沿用原图：是/);assert.match(old,/12:00:01（北京时间）/);
 const report=await fs.readFile(path.join(r.directory,'其他','本次筛选结果.md'),'utf8');assert.match(report,/合成采集超时/);assert.match(report,/保留实际来源、采集时点/);assert.equal(f.run.items[0].result.status,'符合');
});
test('截图缺失或SHA变化给出归档缺项，其他图仍保留，不把坏文件当作有效图',async t=>{
 const f=await fixture(t);await fs.unlink(path.join(f.source,'300002-报价.png'));await fs.writeFile(path.join(f.source,'300001-15分钟.png'),'tampered');
 const r=await archiveBatch(f.run,f.source,{desktopDir:f.desktopDir});assert.equal(r.status,'partial');assert(r.warnings.some(w=>/SHA256/.test(w)));assert(r.warnings.some(w=>/300002-报价/.test(w)));assert(!r.files.some(f=>f.source==='300001-15分钟.png'));
 assert(r.files.some(f=>f.source==='300001-周期1.png'));assert.equal(f.run.items[0].result.status,'符合');const report=await fs.readFile(path.join(r.directory,'其他','本次筛选结果.md'),'utf8');assert.match(report,/存在归档缺项/);assert.deepEqual((await fs.readdir(r.directory)).sort(),['其他','结果.csv'].sort());
});
test('旧布局整理核对边界与SHA后才移动，额外资料收进其他，重复执行保持原样',async t=>{
 const f=await fixture(t),dir=path.join(f.desktopDir,'股票','2026年10月26日','旧归档'),file=f.run.items[0].chartFile;await fs.mkdir(path.join(dir,'符合'),{recursive:true});await fs.mkdir(path.join(dir,'原始记录'));
 await fs.writeFile(path.join(dir,'符合',file),bytes);await fs.writeFile(path.join(dir,'原始记录','结果.csv'),bytes);await fs.writeFile(path.join(dir,'人工备注.txt'),'保留');await fs.writeFile(path.join(dir,'本次筛选结果.md'),'[截图](<符合/'+file+'>)');
 const manifest={directory:dir,batchId:f.run.id,status:'completed',files:[{source:file,file:'符合/'+file,sha256:sha},{source:'结果.csv',file:'原始记录/结果.csv',sha256:sha}]};await fs.writeFile(path.join(dir,'归档清单.json'),JSON.stringify(manifest));
 await assert.rejects(compactArchive(dir,f.run,{stockRoot:path.join(f.temp,'无关目录')}),/超出任务目录/);
 await fs.writeFile(path.join(dir,'符合',file),'changed');await assert.rejects(compactArchive(dir,f.run,{stockRoot:path.join(f.desktopDir,'股票')}),/SHA256不符/);assert.equal(await fs.access(path.join(dir,'其他')).then(()=>true,()=>false),false);await fs.writeFile(path.join(dir,'符合',file),bytes);
 await fs.writeFile(path.join(dir,'原始记录','结果.csv'),'用户后来保存的CSV');await assert.rejects(compactArchive(dir,f.run,{stockRoot:path.join(f.desktopDir,'股票')}),/结果.csv/);
 const r=await compactArchive(dir,f.run,{stockRoot:path.join(f.desktopDir,'股票'),preserveEditedCSV:true});assert.equal(r.layoutVersion,2);assert.equal(r.preservedEdits[0].originalExportSHA256,sha);assert.equal(await fs.readFile(path.join(dir,'结果.csv'),'utf8'),'用户后来保存的CSV');assert.equal(await fs.readFile(path.join(dir,'其他','人工备注.txt'),'utf8'),'保留');assert.deepEqual(await fs.readFile(path.join(dir,'合成通过.png')),bytes);
 const twice=await compactArchive(dir,f.run,{stockRoot:path.join(f.desktopDir,'股票')});assert.deepEqual(twice,r);for(const e of r.files)assert.equal(createHash('sha256').update(await fs.readFile(path.join(dir,e.file))).digest('hex'),e.sha256);
});
test('符合图只以股票名命名，名称清理后重名时加代码且不会相互覆盖',async t=>{
 const f=await fixture(t);f.run.items[0].name='重名/股';const second=f.run.items[1];Object.assign(second,{name:'重名:股',result:{status:'符合'},chartFile:'300002-15分钟.png',imageSHA256:sha});await fs.writeFile(path.join(f.source,second.chartFile),bytes);f.run.images.push({file:second.chartFile});
 const r=await archiveBatch(f.run,f.source,{desktopDir:f.desktopDir});assert.deepEqual((await fs.readdir(r.directory)).sort(),['其他','结果.csv','重名_股.png','重名_股_300002.png'].sort());assert.equal(r.quickView.stocks.length,2);
});
test('带路径的图片清单不能复制目录外文件，归档错误不污染筛选状态',async t=>{
 const f=await fixture(t);await fs.writeFile(path.join(f.temp,'private.png'),'never-copy');f.run.items[2].chartFile='../private.png';
 const r=await archiveBatch(f.run,f.source,{desktopDir:f.desktopDir});assert.equal(r.status,'partial');assert(r.warnings.some(w=>/文件名不安全/.test(w)));assert(!r.files.some(f=>f.source.includes('private')));
 const logs=[],before=JSON.stringify(f.run);const receipt=await archiveAfterRun(f.run,f.source,{}, {archive:async()=>{throw Error('合成桌面拒绝写入');},log:m=>logs.push(m)});assert.equal(receipt.status,'failed');assert.equal(JSON.stringify(f.run),before);assert(logs.some(m=>/结果仍保存在/.test(m)));assert.equal(JSON.parse(await fs.readFile(path.join(f.source,'桌面归档.json'),'utf8')).status,'failed');
});
test('归档收尾写入本地路径回执；只预览和排名不创建桌面目录',async t=>{
 const f=await fixture(t);let calls=0;const archive=async(r,d,o)=>{calls++;assert.equal(o.taskName,'收尾测试');return archiveBatch(r,d,{...o,desktopDir:f.desktopDir});};
 const receipt=await archiveAfterRun(f.run,f.source,{'task-name':'收尾测试'},{archive,log:()=>{}});assert.equal(receipt.status,'completed');assert.equal(JSON.parse(await fs.readFile(path.join(f.source,'桌面归档.json'),'utf8')).directory,receipt.directory);
 for(const change of [{rankingsOnly:true},{selectionMode:'rankings-only'},{status:'members_only'}])assert.equal((await archiveAfterRun({...f.run,...change},f.source,{}, {archive,log:()=>{}})).status,'skipped');assert.equal(calls,1);
 assert.throws(()=>options(['--sectors','合成','--task-name',' ']),/不能是空白/);assert.equal(options(['--sectors','合成','--task-name','午盘'])['task-name'],'午盘');
});
