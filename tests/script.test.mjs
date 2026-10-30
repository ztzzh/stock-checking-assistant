// 独立脚本合成测试。全部浏览器和视觉应答为夹具，不产生真实行情成绩。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {EventEmitter} from 'node:events';
import {PassThrough} from 'node:stream';
import {options,runScreening,outcomeMessage,reviewSavedBatch} from '../script/screen.mjs';
import {selectSector} from '../script/browser.mjs';
import {applyReviews,codexArgs,reviewWithCodex,reviewInput,schemaForRun,makePrompt,reviewSchema} from '../script/vision.mjs';
import {ActiveBudget,budgetError,abortCause,historyStageWithBudget,reviewStageWithBudget} from '../script/budget.mjs';
import {createHash}from'node:crypto';
import {TENCENT_SOURCE} from '../script/tencent-history.mjs';

const date='2026-10-23';
const chosen={code:'pt01800001',name:'合成行业',kind:'industry',source:TENCENT_SOURCE};
const catalogLoader=async kind=>({kind,total:1,entries:[kind==='industry'?chosen:{code:'pt02GN0001',name:'合成概念',kind,source:TENCENT_SOURCE}]});
const memberLoader=async()=>({sector:chosen.code,source:TENCENT_SOURCE,total:3,items:['300001','300002','300003'].map(code=>({code,market:'sz',name:'合成'+code,url:'https://quote.eastmoney.com/sz'+code+'.html',membershipSource:TENCENT_SOURCE,membershipSector:chosen.code}))});
const specifiedOptions=(args=[])=>options(['--sectors',chosen.name,...args]);
function ranking(kind='industry',rates=kind==='industry'?[15.02,7.98,6.56]:[8.10,6.58,6.24]){
  const codes=kind==='industry'?['BK1295','BK1408','BK1296']:['BK2001','BK2002','BK2003'];
  const rows=rates.map((rate,n)=>({cells:[String(n+1),n===1&&kind==='industry'?'机器人':'合成板块'+codes[n],String(rate)+'%'],links:[[],[{url:'https://quote.eastmoney.com/unify/r/90.'+codes[n]}],[]]}));
  return{kind,snapshot:{url:'https://quote.eastmoney.com/center/gridlist.html#'+kind+'_board',at:new Date().toISOString(),tables:[{columns:['排名','板块名称','涨跌幅'],rows}]},leaders:rows,image:Buffer.from('软件合成榜单：非真实行情')};
}
const review=(code,extra={})=>({code,identityConfirmed:true,period15mConfirmed:true,latestBarDate:date,allMALabelsVisible:true,volumeComplete:true,chartPrice:12,ma5:12,ma10:11.9,ma20:11.8,ma60:11,shape:'pass',nearMA20:'pass',ma20Above60:'pass',redVolume:'pass',reason:'合成视觉应答，仅验证软件',...extra});
const payload=(stocks,extra={})=>({marketDate:date,marketPhase:'收盘',rankingEvidenceConfirmed:true,quoteEvidenceConfirmed:true,notes:'软件合成夹具，不能当作选股结果',stocks,...extra});
const item=(code='300001',extra={})=>({code,name:'合成'+code,price:'12',open:'11',url:'https://quote.eastmoney.com/sz'+code+'.html',chartFile:code+'-15分钟.png',imageSHA256:'synthetic',...extra});
function fakeBrowser({captureFailure=false,abort}={}){
  const charts=[],items=[item('300001',{chartFile:undefined}),item('300002',{price:'11',chartFile:undefined}),item('300003',{chartFile:undefined})];
  return{charts,stockQuote:async i=>({code:i.code,name:i.name,price:i.code==='300002'?'11':'12',open:'11',dateText:date,image:Buffer.from('合成报价')}),ranking:async kind=>ranking(kind),constituents:async()=>({snapshot:{url:'https://quote.eastmoney.com/center/gridlist.html#boards2-90.BK1408',tables:[]},items,image:Buffer.from('软件合成报价')}),chart:async i=>{
    charts.push(i.code);if(captureFailure&&i.code==='300003')throw Error('合成图表受阻');abort?.abort(Error('合成停止'));
    return{image:Buffer.from('软件合成图，不是真实K线 '+i.code),capturedAt:new Date().toISOString(),chartInfo:{selectedPeriod:'15分钟'}};
  }};
}
async function temporary(t){const dir=await fs.mkdtemp(path.join(os.tmpdir(),'visual-script-fixture-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));return dir;}

test('人工验证暂停自动预算，恢复后只使用剩余时间；总墙钟仍可另记',()=>{
  let now=0,expired=0;const timers=[],budget=new ActiveBudget(1000,()=>expired++,{now:()=>now,schedule:(fn,ms)=>{const timer={fn,ms,cancelled:false};timers.push(timer);return timer;},cancel:timer=>{timer.cancelled=true;}});
  now=400;budget.pause();assert.equal(budget.remaining,600);assert.equal(timers[0].cancelled,true);
  now=20000;budget.resume();assert.equal(timers[1].ms,600);assert.equal(expired,0);timers[1].fn();assert.equal(expired,1);assert.equal(budget.remaining,0);budget.dispose();
});
test('历史取数使用独立预算，不耗掉后续筛选的剩余时间；中止保留明确原因',async()=>{
 let now=0;const timers=[],controller=new AbortController(),screenBudget=new ActiveBudget(300000,()=>controller.abort(budgetError('筛选超时','SCREENING_TIMEOUT')),{now:()=>now,schedule:(fn,ms)=>{const t={fn,ms};timers.push(t);return t;},cancel:t=>{t.cancelled=true;}});
 now=1000;const historyTimers=[];
 await historyStageWithBudget(async()=>{now+=258553;assert.equal(screenBudget.started,null);},{screenBudget,milliseconds:600000,controller,schedule:(fn,ms)=>{const t={fn,ms};historyTimers.push(t);return t;},cancel:t=>{t.cancelled=true;}});
 assert.equal(screenBudget.remaining,299000);assert.equal(controller.signal.aborted,false);assert.equal(historyTimers[0].ms,600000);assert.equal(historyTimers[0].cancelled,true);assert.equal(timers.at(-1).ms,299000);screenBudget.dispose();
 const expired=new AbortController();await assert.rejects(historyStageWithBudget(async()=>42,{milliseconds:5000,controller:expired,schedule:(fn)=>{fn();return{};},cancel:()=>{}}),/板块历史取数达到5秒/);
 assert.equal(expired.signal.reason.code,'HISTORY_TIMEOUT');const mapped=abortCause(new Error('The operation was aborted'),expired.signal);assert.match(mapped.message,/板块历史取数达到5秒独立预算/);
});

test('脚本参数明确范围，保护日常浏览器目录，默认不需要工作台',()=>{
  const cfg=options(['--sectors','合成行业','--limit','10']);assert.equal(cfg.sectors,'合成行业');assert.equal(cfg.limit,10);assert.equal(cfg.seconds,300);assert.equal(cfg.lookback,30);
  assert.equal(options(['--rankings-only','--lookback','15']).lookback,15);assert.equal(options(['--rankings-only','--lookback','1']).lookback,1);assert.throws(()=>options(['--lookback','20']));
  assert.throws(()=>options(['--rank','0']));assert.throws(()=>options(['--limit','11']));assert.throws(()=>options(['--timeout-seconds','4']));
  assert.throws(()=>options(['--profile-dir','C:/Users/test/AppData/Local/Google/Chrome/User Data']),/专用profile/);
  assert.equal(cfg.reviewSeconds,180);assert.equal(options(['--review-timeout-seconds','240']).reviewSeconds,240);
  assert.throws(()=>options(['--review-timeout-seconds','4']),/review-timeout-seconds/);
});

test('模型累计预算独立计时，不消耗采集余额；多批共用余额且取消不恢复采集',async()=>{
 let now=0;const timers=[];
 const clock={now:()=>now,schedule:(fn,ms)=>{const t={fn,ms};timers.push(t);return t;},cancel:t=>{t.cancelled=true;}};
 const controller=new AbortController(),captureController=new AbortController();
 const captureSignal=AbortSignal.any([controller.signal,captureController.signal]);
 const screenBudget=new ActiveBudget(300000,()=>captureController.abort(budgetError('合成采集超时','SCREENING_TIMEOUT')),clock);
 const reviewBudget=new ActiveBudget(180000,()=>controller.abort(budgetError('合成模型超时','REVIEW_TIMEOUT')),clock);reviewBudget.pause();
 now=280000;
 await reviewStageWithBudget(async()=>{assert.equal(screenBudget.started,null);now+=47000;},{screenBudget,reviewBudget,signal:controller.signal,captureSignal});
 assert.equal(screenBudget.remaining,20000);assert.equal(reviewBudget.remaining,133000);assert.equal(reviewBudget.started,null);
 now+=1000;
 await reviewStageWithBudget(async()=>{now+=40000;},{screenBudget,reviewBudget,signal:controller.signal,captureSignal});
 assert.equal(screenBudget.remaining,19000);assert.equal(reviewBudget.remaining,93000);
 await assert.rejects(reviewStageWithBudget(async()=>{controller.abort(budgetError('合成取消','USER_CANCELLED'));throw controller.signal.reason;},{screenBudget,reviewBudget,signal:controller.signal,captureSignal}),e=>e.code==='USER_CANCELLED');
 assert.equal(screenBudget.started,null);assert.equal(reviewBudget.started,null);
 screenBudget.dispose();reviewBudget.dispose();
});

test('独立模型预算用尽仍中止模型并保留明确原因，不因暂停采集而无限等待',async()=>{
 const controller=new AbortController(),timers=[];
 const reviewBudget=new ActiveBudget(180000,()=>controller.abort(budgetError('合成模型预算用尽','REVIEW_TIMEOUT')),{schedule:fn=>{const timer={fn};timers.push(timer);return timer;},cancel:()=>{}});reviewBudget.pause();
 let captureResumed=0;const screenBudget={pause(){},resume(){captureResumed++;}};
 await assert.rejects(reviewStageWithBudget(async()=>{timers.at(-1).fn();throw new Error('The operation was aborted');},{screenBudget,reviewBudget,signal:controller.signal}),/operation was aborted/);
 assert.equal(abortCause(new Error('The operation was aborted'),controller.signal).code,'REVIEW_TIMEOUT');assert.equal(captureResumed,0);assert.equal(reviewBudget.remaining,0);reviewBudget.dispose();
});
test('两榜合并第3强实际选机器人；不能把行业第3当作合并第3',()=>{
  const sector=selectSector([ranking(),ranking('concept')],3);assert.equal(sector.name,'机器人');assert.equal(sector.rate,7.98);
});
test('排行榜缺首行、不是降序或目标名次并列时停止',()=>{
  assert.throws(()=>selectSector([ranking('industry',[7,8,6]),ranking('concept')],3),/连续降序/);
  assert.throws(()=>selectSector([ranking('industry',[10,8.1,7]),ranking('concept')],2),/同涨幅/);
  const missing=ranking();missing.snapshot.tables[0].rows.shift();assert.throws(()=>selectSector([missing,ranking('concept')],2),/榜首/);
});
test('四项视觉全通过且图证完整才能符合；图价回落至今开即淘汰',()=>{
  const run={items:[item(),item('300003')]};applyReviews(run,payload([review('300001'),review('300003',{chartPrice:11})]));
  assert.equal(run.items[0].result.status,'符合');assert.equal(run.items[0].reviewImageSHA256,'synthetic');
  assert.equal(run.items[1].result.status,'淘汰');assert.equal(run.items[1].review.shape,'not_checked');
});
test('任一条件失败后清空后续判定；模糊项不会变成符合',()=>{
  for(const [field,value,status]of[['shape','fail','淘汰'],['nearMA20','unclear','待确认']]){
    const run={items:[item()]};applyReviews(run,payload([review('300001',{[field]:value})]));assert.equal(run.items[0].result.status,status);assert.equal(run.items[0].review.redVolume,'not_checked');
  }
});
test('日期、身份、量柱、均线标签缺失及数值矛盾均拒绝误报通过',()=>{
  for(const extra of [{identityConfirmed:false},{volumeComplete:false},{allMALabelsVisible:false},{ma5:null},{latestBarDate:'2026-10-22'},{ma20:10,ma60:11}]){
    const run={items:[item()]};applyReviews(run,payload([review('300001',extra)]));assert.equal(run.items[0].result.status,'待确认');
  }
  const run={items:[item()]};applyReviews(run,payload([review('300001')],{rankingEvidenceConfirmed:false}));assert.equal(run.items[0].result.status,'待确认');
  const invalidDate={items:[item()]};applyReviews(invalidDate,payload([review('300001')],{marketDate:'2026-02-31'}));assert.equal(invalidDate.contextConfirmed,false);assert.equal(invalidDate.items[0].result.status,'待确认');
});
test('模型重复、漏项或新增代码时整批不采纳，不凭顺序错配图片',()=>{
  for(const stocks of [[],[review('300009')],[review('300001'),review('300001')]])assert.throws(()=>applyReviews({items:[item()]},payload(stocks)));
});
test('独立批次完整跑通终端流程；报价淘汰不打开，采图失败留待确认；不调用HTTP服务',async t=>{
  const directory=await temporary(t),browser=fakeBrowser({captureFailure:true});let invoked=0;
  const run=await runScreening(specifiedOptions(),{directory,catalogLoader,memberLoader,browser,log:()=>{},review:async r=>{invoked++;assert.equal(reviewInput(r).images.length,1);assert.equal(r.items.filter(i=>i.chartFile).length,1);return payload([review('300001')]);}});
  assert.equal(invoked,1);assert.deepEqual(browser.charts,['300001','300003']);assert.equal(run.status,'completed_with_capture_gaps');
  assert.deepEqual(run.counts,{candidates:3,quotePassed:2,newCharts:1,passed:1,eliminated:1,pending:1,visualReviewed:1,confirmedCharts:1,captureFailures:1,unvisited:0});
  assert.match(await fs.readFile(path.join(directory,'结果.md'),'utf8'),/名单外成分未检查/);assert.match(await fs.readFile(path.join(directory,'结果.csv'),'utf8'),/合成图表受阻/);
  assert.equal((await fs.readFile(path.join(directory,'300001-15分钟.png'),'utf8')).startsWith('软件合成'),true);
  const emptyDirectory=await temporary(t),emptyBrowser=fakeBrowser();emptyBrowser.chart=async()=>({image:Buffer.alloc(0)});
  const empty=await runScreening(specifiedOptions(['--capture-only']),{directory:emptyDirectory,catalogLoader,memberLoader,browser:emptyBrowser,log:()=>{}});
  assert.equal(empty.counts.newCharts,0);assert.equal(empty.counts.passed,0);assert(empty.items.filter(i=>i.captureError).every(i=>!i.chartFile));
});
test('只采图模式不调用模型；全自动模型失败不回退为通过',async t=>{
  const directory=await temporary(t);let invoked=false;
  const run=await runScreening(specifiedOptions(['--capture-only']),{directory,catalogLoader,memberLoader,browser:fakeBrowser(),log:()=>{},review:async()=>{invoked=true;throw Error('不应调用');}});
  assert.equal(invoked,false);assert.equal(run.counts.passed,0);assert.equal(run.status,'captured_only');
  const failed=await runScreening(specifiedOptions(),{directory,catalogLoader,memberLoader,browser:fakeBrowser(),log:()=>{},review:async()=>{throw Error('合成视觉引擎错误');}});
  assert.equal(failed.status,'failed');assert.equal(failed.counts.passed,0);assert.match(failed.error,/视觉引擎/);
});
test('采集中停止则拒绝正在返回的图片，保留批次和未完成状态',async t=>{
  const directory=await temporary(t),abort=new AbortController(),browser=fakeBrowser({abort});
  const run=await runScreening(specifiedOptions(),{directory,catalogLoader,memberLoader,browser,signal:abort.signal,log:()=>{},review:async()=>{throw Error('不应调用');}});
  assert.equal(run.status,'interrupted');assert.equal(run.counts.newCharts,0);assert.equal(run.counts.passed,0);assert.equal(browser.charts.length,1);
});
test('目录/接口失败保存诊断，明确没有开始个股筛选，不显示零只成功结果',async t=>{
  const directory=await temporary(t),browser=fakeBrowser();let diagnostics=0;
  const brokenCatalog=async()=>{throw Error('合成网络故障');};browser.diagnostics=async()=>{diagnostics++;return['失败现场.png'];};
  const run=await runScreening(specifiedOptions(),{directory,catalogLoader:brokenCatalog,memberLoader,browser,log:()=>{}});
  assert.equal(run.status,'failed');assert.equal(diagnostics,1);assert.deepEqual(run.diagnosticFiles,['失败现场.png']);
  assert.match(outcomeMessage(run,directory),/尚未进入个股筛选/);assert.doesNotMatch(outcomeMessage(run,directory),/结果：符合0/);
});
test('Codex图片通过参数数组提交，固定只读、禁用外部工具及多Agent，不经过shell',()=>{
  const args=codexArgs({directory:'D:/合成目录 a',schemaFile:'schema.json',outputFile:'result.json',images:['D:/合成目录 a/1.png']});
  assert.deepEqual(args.slice(0,2),['exec','-']);assert.equal(args[args.indexOf('--sandbox')+1],'read-only');assert(args.includes('D:/合成目录 a/1.png'));
  assert(args.includes('multi_agent'));assert(args.includes('shell_tool'));assert(!args.some(a=>/dangerously|bypass/.test(a)));
});
test('视觉引擎调用保留模型原始JSON和输入manifest，并校验进程退出码',async t=>{
  const directory=await temporary(t),run={rank:3,limit:10,items:[item()],images:[{file:'300001-15分钟.png',label:'合成图'}]};
  const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/lX8AAAAASUVORK5CYII=','base64');await fs.writeFile(path.join(directory,run.images[0].file),png);run.items[0].imageSHA256=createHash('sha256').update(png).digest('hex');
  let command;
  const spawnImpl=(exe,args,opts)=>{
    command={exe,args,opts};const child=new EventEmitter();Object.assign(child,{stdout:new PassThrough(),stderr:new PassThrough(),stdin:new PassThrough()});
    child.stdin.on('finish',async()=>{await fs.writeFile(args[args.indexOf('--output-last-message')+1],JSON.stringify(payload([review('300001')])));child.emit('close',0);});return child;
  };
  const result=await reviewWithCodex(run,directory,{executable:'synthetic-codex.exe',spawnImpl});assert.equal(result.stocks[0].code,'300001');assert.equal(command.opts.shell,false);assert.equal(command.opts.windowsHide,true);
  assert.match(await fs.readFile(path.join(directory,'视觉复核/prompt.txt'),'utf8'),/不发明固定百分比阈值/);
});

test('只向模型提交有15分钟图的两只，排除报价淘汰与缺失现场，并动态限定代码及数量',()=>{
  const run={rank:1,limit:10,lookback:15,items:[item('002724'),item('603278'),item('600838',{price:'11',chartFile:undefined}),item('600293',{price:undefined,open:undefined,chartFile:undefined})],images:[...['002724','603278'].flatMap(c=>[{file:c+'-报价.png'},{file:c+'-15分钟.png'}]),{file:'600838-报价.png'},{file:'600293-报价缺失.png'}]};
  const input=reviewInput(run),schema=schemaForRun(run),prompt=makePrompt(run);
  assert.deepEqual(input.codes,['002724','603278']);assert.equal(input.images.length,4);assert.equal(run.images.length,6);
  assert.deepEqual(schema.properties.stocks.items.properties.code.enum,input.codes);assert.equal(schema.properties.stocks.minItems,2);assert.equal(schema.properties.stocks.maxItems,2);assert.equal(reviewSchema.properties.stocks.items.properties.code.enum,undefined);
  assert.match(prompt,/本次唯一复核名单：\["002724","603278"\]/);assert.doesNotMatch(prompt,/600838|600293/);
  assert.throws(()=>applyReviews(run,payload([review('002724'),review('603278'),review('600293')])),/非复核名单代码600293/);
  assert.throws(()=>applyReviews(run,payload([review('002724'),review('002724')])),/重复股票代码002724/);
  assert.throws(()=>reviewInput({...run,images:input.images.slice(0,2)}),/缺少/);
});
test('保存原图重评校验SHA256、另存新结果并保留未取图候选，不改原批次或重采行情',async t=>{
  const source=await temporary(t),output=await temporary(t),image=Buffer.from('合成原图'),hash=createHash('sha256').update(image).digest('hex');
  const original={kind:'standalone-visual-script',id:'合成失败批次',rank:1,limit:10,lookback:1,startedAt:'2026-10-25T08:00:00Z',finishedAt:'2026-10-25T08:01:00Z',status:'failed',error:'旧模型新增代码',items:[item('300001',{imageSHA256:hash}),item('300002',{price:undefined,open:undefined,chartFile:undefined,captureError:'缺报价'})],images:[{file:'300001-15分钟.png',label:'合成原图'}]};
  const saved=JSON.stringify(original);await fs.writeFile(path.join(source,'run.json'),saved);await fs.writeFile(path.join(source,'300001-15分钟.png'),image);
  const cfg=options(['--review-only',source,'--output-dir',output]);let calls=0;
  const {run,directory}=await reviewSavedBatch(cfg,{review:async()=>{calls++;return payload([review('300001',{shape:'fail'})]);},log:()=>{}});
  assert.equal(calls,1);assert.notEqual(directory,source);assert.equal(run.replayOf.id,original.id);assert.equal(run.status,'completed_with_quote_gaps');assert.equal(run.counts.eliminated,1);assert.equal(run.counts.pending,1);assert.equal(await fs.readFile(path.join(source,'run.json'),'utf8'),saved);assert.match(await fs.readFile(path.join(directory,'结果.md'),'utf8'),/不代表当前实时行情/);
  await fs.writeFile(path.join(source,'300001-15分钟.png'),'被改动的图');await assert.rejects(reviewSavedBatch(cfg,{review:async()=>{calls++;},log:()=>{}}),/SHA256不符/);assert.equal(calls,1);
});
