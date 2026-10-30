#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {randomBytes,createHash} from 'node:crypto';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {parseArgs} from 'node:util';
import {createInterface} from 'node:readline/promises';
import {prefilter} from '../extension/core.js';
import {loadPlaywright,findBrowser,selectSector} from './browser.mjs';
import {createCaptureBrowsers} from './market-browser.mjs';
import {SOURCES,sourceName,assignSource,assertCaptureSource,sourceFromURL} from './sources.mjs';
import {resolveVisionEngine} from './vision-engines.mjs';
import {normalizeQwenBaseURL} from './qwen-models.mjs';
import {findCodex,codexStatus,reviewWithCodex,applyReviews,reviewInput,reviewTargets,reviewInBatches} from './vision.mjs';
import {validateLookback,periodLabel,selectHistoricalSector,validDay} from './period.mjs';
import {SectorHistoryProvider} from './history.mjs';
import {ActiveBudget,budgetError,bindTaskStop,abortCause,historyStageWithBudget,reviewStageWithBudget,reviewTimes} from './budget.mjs';
import {sectorFetch,loadSectorCatalog} from './sector-http.mjs';
import {TencentHistoryProvider,TENCENT_SOURCE,loadTencentMembers} from './tencent-history.mjs';
import {readSelection,resolveSectors,collectSelectedMembers,selectedMembershipConfirmed} from './selected-sectors.mjs';
import {archiveAfterRun} from './archive.mjs';
import {atomicJSON} from './state-files.mjs';
import {ReviewQueue,reviewWorkers} from './review-queue.mjs';
import {CaptureCoordinator,captureWorkers} from './capture-pool.mjs';
import {detectGate} from './gate.mjs';
import {LiveArchiveSession} from './live-archive.mjs';
import {resultCSV} from './result-csv.mjs';
import {validateMemberScope,memberScopeLabel} from './member-scope.mjs';
import {reviewSettings,reasoningEffort,evidenceMode,evidenceLabel} from './review-settings.mjs';

export const ROOT=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
export const HELP=`视觉选股脚本 v1.5 · 行情与复核模型选择

  .\\选股.cmd --sectors "出版,机器人概念" --limit 10   指定多个板块，每板块最多10只，重复股票仅分析一次
  .\\选股.cmd --sectors "出版" --source sina          新浪可见报价与15分钟图
  .\\选股.cmd --sectors "人形机器人" --all-members --timeout-seconds 3600 --review-timeout-seconds 3600   全部成分股，时间预算独立生效
  .\\选股.cmd                                    读取当天板块名单.json；空名单直接提示，不自动选板块
  .\\选股.cmd --sectors "出版,机器人概念" --member-percent 30   分别取各板块总成分的前30%，向上取整
  .\\选股.cmd --sectors-file "板块名单.json"         使用指定名单文件，日期须为今天
  .\\选股.cmd --sectors "出版" --members-only         只预览成分及去重，不打开浏览器、不调用模型
  .\\选股.cmd --resume "脚本结果/批次目录"            沿用原板块和名单，继续缺项，不重新排名
  .\\选股.cmd --review-only "脚本结果/批次目录"       只复核保存原图
  .\\选股.cmd --login                              专用浏览器人工登录
  .\\选股.cmd --check                              检查依赖和会话
  .\\选股.cmd --check-browser                      只测试浏览器启动

选项：--limit 1..10（每板块，默认10） --all-members（全部成分，忽略数量上限） --member-percent 1..100（每板块按百分比向上取整，与全部互斥）
      --timeout-seconds 300（采集预算）
      --capture-workers 1—6（默认6路独立页面采图）
      --review-workers 1—32（默认单路审核）
      --source eastmoney|sina（行情及图表一起切换；新批次默认eastmoney，续跑默认继承）
      --task-name "午盘第一轮"（可选归档任务名称；默认板块名＋开始时间）
      --review-timeout-seconds 180（模型复核累计预算，独立于采集；人工等待另计）
      --capture-only --headless --no-pause --browser-exe 路径 --profile-dir 路径 --output-dir 路径
      --model gpt-6.1-sol|gpt-6.1-terra|gpt-6-luna|deepseek-flash|qwen3.5-omni-flash（千问使用DASHSCOPE_API_KEY）
      --qwen-base-url 地址（千问OpenAI兼容地址；默认用户业务空间专属地址，也可配置DASHSCOPE_BASE_URL）
      --reasoning-effort low|medium|high|default（Sol默认low；其他模型默认档位；DeepSeek不使用此选项）
      --full-evidence（等价于--evidence-mode full，提交完整辅助原图和详细上下文；原图仍完整保存）
      --evidence-mode main-auto|main-only|compact|full|main-auto-crop|main-only-crop（默认主图优先；图证缺失最多补审一次，形态边界不补图）

板块名称按腾讯行业/概念目录精确匹配，同名时必须指定目录中的pt01…/pt02…代码。
只查目录及所选板块成分代码/名称，不读取板块历史、不比较涨幅、不自行替你选板块。
现价/今开只读所选网站可见页面；新15分钟图交给所选视觉模型批量复核，滑块人工处理。
新浪自动通过网页MA设置面板配置5/10/20/60。两来源共用原来的四项视觉策略，不自动回退或拼接不同来源的个股报价与图。
每天午盘重新确定名单；跨交易日不能补采旧批次。默认每板块最多10只；全量模式取齐成分，预算到期保存缺项，用--resume继续。
旧--rank/--lookback不能用于筛股。历史排名仅保留为独立参考工具，必须显式加--rankings-only，且不进入个股筛选。
结果保存在脚本结果/；任务结束或中断后另存桌面/股票/日期/任务名/。
任务根目录只放最终CSV和符合股票的15分钟主图（股票名命名），其余截图、说明和记录保存在“其他”。
仅排名、成分预览、登录和依赖检查不生成截图归档。归档失败保留筛选结果，不需要工作台；Sol/Terra/Luna使用Codex登录，DeepSeek需API密钥。不执行买卖。
退出码：0=流程完成或成分预览完成；2=中断/有未完成项；1=参数或名单错误。
`;

export function options(argv){
  const {values}=parseArgs({args:argv,options:{
    help:{type:'boolean'},login:{type:'boolean'},check:{type:'boolean'},'check-browser':{type:'boolean'},
    'capture-only':{type:'boolean'},'review-only':{type:'string'},resume:{type:'string'},sectors:{type:'string'},'sectors-file':{type:'string'},'members-only':{type:'boolean'},'all-members':{type:'boolean'},'member-percent':{type:'string'},headless:{type:'boolean'},'no-pause':{type:'boolean'},rank:{type:'string'},limit:{type:'string',default:'10'},
    lookback:{type:'string'},source:{type:'string'},'task-name':{type:'string'},'sector-source':{type:'string',default:'tencent'},'rankings-only':{type:'boolean'},'refresh-history':{type:'boolean'},
    'timeout-seconds':{type:'string',default:'300'},'capture-workers':{type:'string',default:'6'},'review-workers':{type:'string',default:'1'},'review-timeout-seconds':{type:'string',default:'180'},'history-timeout-seconds':{type:'string',default:'600'},'browser-exe':{type:'string'},'profile-dir':{type:'string'},'output-dir':{type:'string'},model:{type:'string'},'qwen-base-url':{type:'string'},'reasoning-effort':{type:'string'},'full-evidence':{type:'boolean'},'evidence-mode':{type:'string'}
  },strict:true,allowPositionals:false});
  const rank=Number(values.rank||1),limit=Number(values.limit),seconds=Number(values['timeout-seconds']),reviewSeconds=Number(values['review-timeout-seconds']),historySeconds=Number(values['history-timeout-seconds']),lookback=validateLookback(values.lookback||30);
  const memberPercent=values['member-percent']===undefined?undefined:Number(values['member-percent']);validateMemberScope({limit,allMembers:!!values['all-members'],memberPercent});
  if(memberPercent!==undefined&&(values.resume||values['review-only']||values['rankings-only']||values.login||values.check||values['check-browser']))throw Error('--member-percent仅用于指定板块的新任务；继续/复核沿用原名单范围');
  const source=values.source??'eastmoney';sourceName(source);
  if(values['reasoning-effort']!==undefined)reasoningEffort(values['reasoning-effort']);
  if(values['full-evidence']&&values['evidence-mode']&&values['evidence-mode']!=='full')throw Error('--full-evidence不能与其他图证模式混用');
  const selectedEvidenceMode=evidenceMode(values['evidence-mode'],{compactEvidence:!values['full-evidence']});
  if(values['task-name']!==undefined&&!values['task-name'].trim())throw Error('task-name不能是空白');
  if(values['all-members']&&(values.resume||values['review-only']||values['rankings-only']||values.login||values.check||values['check-browser']))throw Error('--all-members仅用于指定板块的新任务；继续/复核沿用原名单范围');
  if(values['review-only']&&values.source)throw Error('原图重评不切换来源；换源补采请用 --resume 批次目录 --source sina或eastmoney');
  if(values['rankings-only']&&values.source)throw Error('--source只用于个股报价和图表，不与独立板块排名工具混用');
  if(values.sectors&&values['sectors-file'])throw Error('--sectors与--sectors-file只选一种');
  if(values['members-only']&&(values['capture-only']||values.login||values.check||values['check-browser']||values['review-only']))throw Error('成分预览不能与采图、登录、检查或重评混用');
  if(values['review-only']&&(values.sectors||values['sectors-file']))throw Error('原图重评不能重新指定板块');
  if(!values.help&&!values['rankings-only']&&!values.resume&&!values['review-only']&&values['sector-source']!=='tencent')throw Error('指定板块当前按腾讯行业/概念目录核对，不自动切换来源；请使用对应名称或pt代码');
  if(values['rankings-only']&&(values.sectors||values['sectors-file']||values['members-only']))throw Error('指定板块筛股与独立排名工具不能混用');
  if(values.resume&&(values.sectors||values['sectors-file']||values['members-only']||values.rank||values.lookback))throw Error('断点继续沿用原板块和名单，不能重新指定板块或排名参数');
  if(!values.help&&!values['rankings-only']&&(values.rank||values.lookback||values['refresh-history']))throw Error('已改为指定板块筛股，不再用--rank/--lookback自动选板块。请用 --sectors "板块名称1,板块名称2"；独立查排名才使用 --rankings-only');
  if(!['tencent','eastmoney'].includes(values['sector-source']))throw Error('sector-source仅支持tencent或eastmoney');
  if(values['review-only']&&(values.login||values['rankings-only']||values['capture-only']||values.check||values['check-browser']))throw Error('review-only不能与登录、检查、只排名或只采图同时使用');
  if(values.resume&&(values['review-only']||values.login||values['rankings-only']||values.check||values['check-browser']))throw Error('resume不能与登录、检查、只排名或原图重评同时使用');
  if(!Number.isInteger(rank)||rank<1||rank>10||!Number.isInteger(limit)||limit<1||limit>10||!Number.isFinite(seconds)||seconds<5||seconds>3600)throw Error('rank和limit须为1—10整数；timeout-seconds须为5—3600秒');
  if(!Number.isFinite(historySeconds)||historySeconds<5||historySeconds>3600)throw Error('history-timeout-seconds须为5—3600秒');
  if(!Number.isFinite(reviewSeconds)||reviewSeconds<5||reviewSeconds>3600)throw Error('review-timeout-seconds须为5—3600秒');
  const profileDir=path.resolve(values['profile-dir']||path.join(ROOT,'.script-browser'));
  // 避免误用正在使用的日常浏览器目录；专用目录由本脚本创建并标记。
  if(/(?:Chrome|Edge|Chromium)[\\/]User Data(?:[\\/]|$)/i.test(profileDir))throw Error('请使用脚本专用profile目录，不使用日常Chrome/Edge的User Data');
  return {...values,qwenBaseUrl:values['qwen-base-url']===undefined?undefined:normalizeQwenBaseURL(values['qwen-base-url']),captureWorkers:captureWorkers(values['capture-workers']),reviewWorkers:reviewWorkers(values['review-workers']),evidenceMode:selectedEvidenceMode,reasoningEffort:values['reasoning-effort'],compactEvidence:selectedEvidenceMode!=='full',allMembers:!!values['all-members'],memberPercent,source,sourceExplicit:values.source!==undefined,rank,limit,seconds,reviewSeconds,historySeconds,lookback,profileDir,sectorsFile:path.resolve(values['sectors-file']||path.join(ROOT,'板块名单.json')),outputRoot:path.resolve(values['output-dir']||path.join(ROOT,'脚本结果')),browserExe:values['browser-exe']||process.env.SCREENING_BROWSER_EXE,model:values.model||process.env.SCREENING_VISION_MODEL};
}
export async function waitForEnter(message,signal){
  const input=createInterface({input:process.stdin,output:process.stdout});
  input.once('SIGINT',()=>{process.emit('SIGINT');input.close();});
  try{await input.question(message,{signal});}finally{input.close();}
}
export function outcomeMessage(run,directory){
  if(run.error)return `本批未完成：${run.error}\n${run.items.length?'已保存部分进度，不能作为完整筛选结果。':'尚未进入个股筛选，未生成选股结论。'}共${(run.elapsedSeconds||0).toFixed(1)}秒。\n已完成判定：符合${run.counts?.passed||0} 淘汰${run.counts?.eliminated||0} 待确认${run.counts?.pending||0}；已复核${run.counts?.visualReviewed||0}，本次截图${run.counts?.newCharts||0}，采集失败${run.counts?.captureFailures||0}，未访问${run.counts?.unvisited||0}。\n诊断与结果：${directory}${reviewTargets(run).length?'\n继续缺项可运行：.\\选股.cmd --resume "'+directory+'"':''}`;
  if(run.rankingsOnly)return `板块排名状态：${run.status}；共${run.elapsedSeconds.toFixed(1)}秒\n${directory}`;
  if(run.status==='members_only')return `指定板块成分预览：去重后${run.items.length}只；未读取个股报价、未采图、未调用模型。共${run.elapsedSeconds.toFixed(1)}秒\n${path.join(directory,'结果.md')}`;
  return `结果：符合${run.counts.passed} 淘汰${run.counts.eliminated} 待确认${run.counts.pending}；共${run.elapsedSeconds.toFixed(1)}秒\n已复核${run.counts.visualReviewed||0}，图证确认${run.counts.confirmedCharts||0}，本次截图${run.counts.newCharts||0}，采集失败${run.counts.captureFailures||0}，未访问${run.counts.unvisited||0}；状态：${run.status}\n${path.join(directory,'结果.md')}`;
}
const csv=value=>{let s=String(value??'');if(/^[=+@\-\t\r]/.test(s))s="'"+s;return '"'+s.replaceAll('"','""')+'"';};
const resultWrites=new Map();
function queueResultWrite(directory,task){const key=path.resolve(directory),previous=resultWrites.get(key)||Promise.resolve(),next=previous.catch(()=>{}).then(task);resultWrites.set(key,next);return next.finally(()=>{if(resultWrites.get(key)===next)resultWrites.delete(key);});}
export function refreshResultCounts(run){
  const now=Date.now();run.elapsedSeconds=(Date.parse(run.finishedAt||new Date(now).toISOString())-Date.parse(run.startedAt))/1000;
  run.activeSeconds=Math.max(0,run.elapsedSeconds-(run.manualWaitSeconds||0)-(run.pauseSeconds||0));
  const timing=reviewTimes(run.events||[]);run.reviewSeconds=timing.seconds;run.reviewWorkSeconds=timing.workSeconds;
  run.counts={candidates:run.items.length,quotePassed:run.items.filter(i=>prefilter(i)==='通过初筛').length,newCharts:run.items.filter(i=>i.chartFile&&!run.replayOf&&(!run.resumeOf||(run.resumeCaptureCodes||run.resumePendingCodes).includes(i.code))).length,
    passed:run.items.filter(i=>i.result?.status==='符合').length,eliminated:run.items.filter(i=>i.result?.status==='淘汰').length,pending:run.items.filter(i=>!i.result||i.result.status==='待确认').length};
  Object.assign(run.counts,{visualReviewed:run.items.filter(i=>i.review&&i.reviewImageSHA256===i.imageSHA256).length,confirmedCharts:run.items.filter(i=>i.chartVisualConfirmed===true).length,captureFailures:run.items.filter(i=>i.captureError).length,unvisited:run.items.filter(i=>!i.attemptedAt&&!i.quoteSnapshot).length});
  if(run.replayOf)run.counts.retainedCharts=run.items.filter(i=>i.chartFile).length;
  if(run.resumeOf)run.counts.retainedCharts=run.items.filter(i=>i.chartFile&&!(run.resumeCaptureCodes||run.resumePendingCodes).includes(i.code)).length;
}
export async function saveResults(run,directory){refreshResultCounts(run);const snapshot=structuredClone(run);await queueResultWrite(directory,()=>writeResultSnapshot(snapshot,directory));}
async function saveRunProgress(run,directory){const snapshot=structuredClone(run);await queueResultWrite(directory,()=>atomicJSON(path.join(directory,'run.json'),snapshot));}
async function writeResultSnapshot(run,directory){
  await atomicJSON(path.join(directory,'run.json'),run);
  // 窗口选择/继续大名单时只读概要，不在UI线程解析全部截图诊断。
  await atomicJSON(path.join(directory,'任务概要.json'),{schemaVersion:1,id:run.id,marketSource:run.marketSource||'eastmoney',marketDate:run.marketDate||run.quoteMarketDate||'',sectors:run.sectors||[],limit:run.limit,allMembers:!!run.allMembers,memberPercent:run.memberPercent,visionModel:run.visionModel,visionProvider:run.visionProvider,reviewWorkers:run.reviewWorkers||1,reasoningEffort:run.reasoningEffort,compactEvidence:run.compactEvidence,evidenceMode:run.evidenceMode,status:run.status});
  const names=i=>i.memberships?.map(m=>m.name).join('、')||run.sector?.name||'';
  const itemSource=i=>sourceName(i.marketSource||i.quoteSnapshot?.source||sourceFromURL(i.quoteSnapshot?.url)||run.marketSource||'eastmoney');
  await fs.writeFile(path.join(directory,'结果.csv'),resultCSV(run));
  const c=run.counts,escape=s=>String(s??'').replaceAll('|','／').replace(/[\r\n]/g,' '),manual=run.selectionMode==='specified-sectors';
  let scope;
  if(manual){
    const proof=run.membershipEvidence,groups=proof?.groups||[];
    scope='选择方式：用户指定板块；名单日期：'+(run.selection?.date||'')+'。只核对目录和成分，不读取历史指数，不计算排名。\n\n'+
      '| 板块 | 代码 | 总成分数 | 纳入名单 | 已访问 | 有图 | 待确认 |\n| --- | --- | --- | --- | --- | --- | --- |\n'+
      groups.map(g=>{const selected=run.items.filter(i=>i.memberships?.some(m=>m.code===g.sector));return '| '+[escape(g.name),g.sector,g.total,g.items.length,selected.filter(i=>i.attemptedAt||i.quoteSnapshot).length,selected.filter(i=>i.chartFile).length,selected.filter(i=>i.result?.status==='待确认').length].join(' | ')+' |';}).join('\n')+
      '\n\n按板块累计成分'+(proof?.totalMembershipRows??0)+'条（跨板块含重复），本轮'+(run.allMembers?'纳入全部成分股':memberScopeLabel(run))+'，纳入'+(proof?.selectedMembershipRows??0)+'条，去重后'+run.items.length+'只。'+(run.allMembers||run.memberPercent===100?'全部成分已列入名单；是否完成仍以已访问及判定数量为准。':'名单外成分未检查；')+'不同板块的同一股票只分析一次，保留全部入选板块归属。\n';
    if(run.status==='members_only')scope+='\n本次仅预览指定成分，全部股票尚未开展报价和图形筛选。\n';
  }else{
    scope='板块强度口径：'+periodLabel(run.lookback||1)+'；来源：'+(run.periodEvidence?.source||'东方财富可见当日榜单')+'。板块：'+(run.sector?.name||'尚未确定')+' '+(run.sector?.rate??'')+'%；合并第'+run.rank+'强。\n';
    if(run.periodEvidence)scope+='区间截止：'+run.periodEvidence.asOf+'；目录'+run.periodEvidence.universeCount+'个，可比'+run.periodEvidence.eligibleCount+'个，历史不足排除'+run.periodEvidence.excludedCount+'个。详见原批次排名证据。\n';
    scope+='本批仅检查选中板块成分表前'+run.limit+'只，其他成分未检查。\n';
  }
  scope+=`\n本轮采集来源：${sourceName(run.marketSource||'eastmoney')}。报价和15分钟图使用同一来源，选股策略不随来源改变。${run.resumeOf?.sourceChanged?'本轮显式换源，只重新采集待确认股票；已完成项沿用原来源和判定。':''}\n\n逐只来源：${run.items.map(i=>i.code+' '+itemSource(i)).join('；')}。\n`;
  if(run.reviewBudgetSeconds)scope+=`\n预算分开累计：采集${run.screenBudgetSeconds}秒；模型复核${run.reviewBudgetSeconds}秒。审核${run.reviewWorkers||1}路，本轮模型复核已用${run.reviewSeconds.toFixed(1)}秒（多路重叠不重复计时；各请求耗时合计${run.reviewWorkSeconds.toFixed(1)}秒）；等待新图不耗审核预算，人工验证只暂停采图，已在审核的任务继续。\n`;
  scope+='\n本轮视觉模型：'+(run.visionModel||'Codex（旧记录）')+'；服务：'+(run.visionProvider||'codex')+'；推理：'+(run.reasoningEffort||'default')+'；图证：'+evidenceLabel(run.evidenceMode)+'。继续任务只对缺项使用当前模型；已完成项保留原判定和原模型。\n';
  const timing=run.replayOf?'仅保存原图复核':run.resumeOf?'仅断点继续及复核，不重新选择板块':manual?'指定板块成分、报价、采图及复核':'板块排名';
  const source=run.resumeOf?'断点来源：'+run.resumeOf.id+'；原行情日：'+(run.resumeOf.expectedMarketDate||'尚未读取')+'。保留图'+c.retainedCharts+'张，继续采集'+(run.resumeCaptureCodes||run.resumePendingCodes).length+'只，原图待复核'+(run.resumeReviewFromSavedCodes?.length||0)+'只。旧现场在恢复前现场。\n':run.replayOf?'原批次：'+run.replayOf.id+'；原采集结束：'+run.replayOf.finishedAt+'。重用原图，不代表当前实时行情。\n':'';
  const text='# 自动视觉选股结果\n\n批次：'+run.id+'\n开始：'+run.startedAt+'\n结束：'+(run.finishedAt||'进行中')+'\n累计：'+run.elapsedSeconds.toFixed(3)+'秒（'+timing+'）；自动执行'+run.activeSeconds.toFixed(1)+'秒，人工等待'+(run.manualWaitSeconds||0).toFixed(1)+'秒，暂停等待'+(run.pauseSeconds||0).toFixed(1)+'秒\n\n'+source+'\n'+scope+'\n行情日：'+(run.marketDate||run.quoteMarketDate||'未完成日期核对')+'；'+(run.marketPhase||'')+'。\n候选'+c.candidates+'只，报价通过'+c.quotePassed+'只，本次截图'+c.newCharts+'张（有效图证需视觉确认）；已复核'+c.visualReviewed+'只，图证确认'+c.confirmedCharts+'只，采集失败'+c.captureFailures+'只，未访问'+c.unvisited+'只；符合'+c.passed+'、淘汰'+c.eliminated+'、待确认'+c.pending+'。\n\n状态：'+run.status+'。'+(run.error||run.visualNotes||'')+'\n\n| 代码 | 名称 | 所属板块 | 判定 | 原因 | 图证 |\n| --- | --- | --- | --- | --- | --- |\n'+run.items.map(i=>'| '+[i.code,escape(i.name),escape(names(i)),i.result?.status||'待确认',escape(i.result?.reason||i.captureError||'尚未完成'),i.chartFile?'[原图]('+i.chartFile+')':'无'].join(' | ')+' |').join('\n')+'\n\n个股图形判断仅来自截图视觉复核，报价只读实际可见页面；不使用个股接口或公式替代看图，不执行买卖。软件测试不作为真实选股速度。\n';
  await fs.writeFile(path.join(directory,'结果.md'),text);
}

export async function runScreening(cfg,{browser,browsers,captureControl,pause,review=reviewWithCodex,reviewStage=task=>task(),reviewSignal=undefined,historyProvider,historyStage=task=>task(),memberLoader=loadTencentMembers,catalogLoader,seed,directory,signal,executable,onProgress=()=>{},onCaptureDone=()=>{},log=console.log}={}){
  reviewSignal??=signal;const browserPool=(browsers||[browser]).slice(0,cfg.captureWorkers||6);browser??=browserPool[0];const captureCoordinator=captureControl||new CaptureCoordinator({signal,pause});
  const startedAt=new Date().toISOString(),id=path.basename(directory),run=seed?{...structuredClone(seed),id,kind:'standalone-visual-script',startedAt,status:'running',events:[],visionBatches:[]}:{id,kind:'standalone-visual-script',startedAt,status:'running',selectionMode:cfg['rankings-only']?'rankings-only':'specified-sectors',rank:cfg['rankings-only']?cfg.rank:null,limit:cfg.limit,allMembers:!!cfg.allMembers,memberPercent:cfg.memberPercent,lookback:cfg['rankings-only']?cfg.lookback:0,rankingsOnly:!!cfg['rankings-only'],screenBudgetSeconds:cfg.seconds,historyBudgetSeconds:cfg['rankings-only']&&cfg.lookback>1?cfg.historySeconds:0,items:[],rankings:[],images:[],events:[],visionBatches:[]};
  run.visionModel=cfg.model||'gpt-6.1-sol';run.visionProvider=cfg.visionProvider||'codex';
  Object.assign(run,reviewSettings(cfg));
  run.taskPause=pause?.state()||{requested:false,status:'running',active:0};
  run.reviewBatchSequence=0;run.reviewWorkers=reviewWorkers(cfg.reviewWorkers);run.screenBudgetSeconds=cfg.seconds;run.reviewBudgetSeconds=cfg.reviewSeconds;run.marketSource=cfg.source||seed?.marketSource||'eastmoney';
  run.pipeline={capture:{status:'running',detail:'准备名单'},review:{status:cfg['capture-only']||cfg['members-only']||cfg['rankings-only']?'disabled':'waiting',detail:cfg['capture-only']?'仅采图，不审核':'等待完整图证',queued:0,active:0,completed:0,batches:0}};
  let captureDone=false;const finishCapture=(status='completed',detail='采图结束')=>{if(captureDone)return;captureDone=true;Object.assign(run.pipeline.capture,{status,detail});onCaptureDone();};
  const persist=async()=>{await saveResults(run,directory);onProgress(run);};
  const initialPauseMs=pause?.pausedMs||0;run.pauseSeconds=0;let pauseSignature='';const unsubscribePause=pause?.subscribe(state=>{const key=state.requested+':'+state.status;if(key===pauseSignature)return;pauseSignature=key;run.taskPause=state;run.pauseSeconds=Math.max(0,pause.pausedMs-initialPauseMs)/1000;void saveRunProgress(run,directory).catch(e=>log('暂停状态未保存：'+e.message));});
  const unsubscribeCapture=captureCoordinator.subscribe(state=>{Object.assign(run.pipeline.capture,state);if(state.workers>1)run.pipeline.capture.detail=state.lanes.map(l=>'采图'+l.id+' '+(l.code||'')+' '+(l.status==='waiting-manual'?'等人工验证':l.status==='waiting-review'?'等审核队列':l.detail)).join('；');void saveRunProgress(run,directory).catch(e=>log('采图进度未保存：'+e.message));});
  const checkpoint=async(stage,fn,stageSignal=signal,lane)=>{
    const execute=async()=>{
    stageSignal?.throwIfAborted();if(lane){lane.detail=stage.startsWith('可见报价')?'报价':'取图';captureCoordinator.publish();}log(stage+(lane&&browserPool.length>1?' [采图'+lane.id+']':''));run.currentStage=stage;(stage.startsWith('视觉复核')?run.pipeline.review:run.pipeline.capture).detail=stage;await saveRunProgress(run,directory);const start=Date.now();let error;
    try{if(lane)await captureCoordinator.beforeStage(lane);const value=await fn();stageSignal?.throwIfAborted();return value;}catch(e){error=e;throw e;}finally{run.events.push({stage,...(lane?{captureLane:lane.id}:{}),startedAt:new Date(start).toISOString(),elapsedMs:Date.now()-start,...(error?{error:error.message}:{})});await saveRunProgress(run,directory);}
    };
    return pause&&!lane&&!stage.startsWith('视觉复核')?pause.run(execute,stageSignal):execute();
  };
  const saveImage=async(file,buffer,label)=>{await fs.writeFile(path.join(directory,file),buffer);run.images.push({file,label,sha256:createHash('sha256').update(buffer).digest('hex')});};
  const pendingVisual=()=>reviewTargets(run).filter(i=>!i.review||i.reviewImageSHA256!==i.imageSHA256);
  const queue=new ReviewQueue({workers:run.reviewWorkers,signal:reviewSignal,pause,onState:state=>{captureCoordinator.wake();Object.assign(run.pipeline.review,state);if(state.status==='waiting')run.pipeline.review.detail=state.queued?'已就绪'+state.queued+'只，审核空闲时最多等'+state.maxWaitSeconds+'秒成批':'等待新图';if(state.status==='failed')run.pipeline.review.detail='审核暂停：'+state.error;if(state.status==='completed')run.pipeline.review.detail='审核队列已处理完';void saveRunProgress(run,directory).catch(e=>log('队列进度未保存：'+e.message));},process:async codes=>{
    await reviewInBatches(run,directory,{pause,review:(...args)=>{if(queue.error)throw queue.error;return reviewStage(()=>review(...args));},checkpoint:(stage,fn)=>checkpoint(stage,fn,reviewSignal),executable,model:cfg.model,provider:cfg.visionProvider,signal:reviewSignal,codes,append:true,onResults:async items=>{for(const i of items)log(`判定 ${i.code} ${i.name}：${i.result.status}；${i.result.reason}`);await persist();}});await persist();
  }});
  const scheduleVisual=(flush=false)=>{if(!cfg['capture-only'])queue.add(pendingVisual().map(i=>i.code),{flush});};
  let reviewFinishing;const finishVisual=()=>reviewFinishing??= (async()=>{if(cfg['capture-only']||cfg['members-only']||cfg['rankings-only'])return;scheduleVisual(true);await queue.finish();await persist();})();
  try{
    if(!seed){
    if(run.selectionMode==='specified-sectors'){
      run.selection=cfg.selection||await readSelection(cfg);
      const resolved=await checkpoint('核对指定板块名称/代码（只查目录，不读取历史、不计算排名）',()=>resolveSectors(run.selection,{catalogLoader,signal}));
      run.sectors=resolved.sectors;run.catalogs=resolved.catalogs;await atomicJSON(path.join(directory,'指定板块.json'),{selection:run.selection,sectors:run.sectors});
      log('按指定板块筛股：'+run.sectors.map(s=>s.name+' '+s.code).join('；'));
      run.membershipEvidence=await checkpoint(`读取指定${run.sectors.length}个板块成分代码/名称，${memberScopeLabel(run)}`,()=>collectSelectedMembers(run.sectors,{limit:cfg.limit,allMembers:run.allMembers,memberPercent:run.memberPercent,memberLoader,signal,onBoard:async group=>log(`${group.name}：共${group.total}只，纳入${group.items.length}只`)}));
      run.items=run.membershipEvidence.items.map(i=>assignSource(structuredClone(i),run.marketSource));
      await atomicJSON(path.join(directory,'板块成分目录.json'),run.membershipEvidence);
      log(`合并${run.membershipEvidence.selectedMembershipRows}条板块成分，去重后${run.items.length}只，仅分析一次并保留所属板块`);
      if(!selectedMembershipConfirmed(run))throw Error('指定板块归属核验失败，停止');
      if(cfg['members-only']){run.status='members_only';return run;}
    }else{
    if(run.lookback===1){
      for(const kind of ['industry','concept']){
        const ranking=await checkpoint('采集'+(kind==='industry'?'行业':'概念')+'降序榜',()=>browser.ranking(kind));
        const file=kind+'-排行.png';await saveImage(file,ranking.image,kind==='industry'?'行业涨幅降序榜':'概念涨幅降序榜');
        const {image,...metadata}=ranking;run.rankings.push({...metadata,imageFile:file});
      }
      run.sector=selectSector(run.rankings,cfg.rank);
    }else{
      if(!historyProvider&&cfg['sector-source']!=='eastmoney')historyProvider=new TencentHistoryProvider({signal,refresh:!!cfg['refresh-history'],onCatalog:async catalogs=>{run.catalogs=catalogs;await atomicJSON(path.join(directory,'板块目录.json'),catalogs);},onProgress:p=>{if(p.stage==='catalog')log(`${p.kind==='industry'?'行业':'概念'}目录 ${p.count}个 / ${p.pages}页`);else if(p.stage==='cache-check')log(p.closedCacheValidated?`旧收盘缓存已在线核验，截止${p.asOf}`:'参考指数已更新或不匹配，重取需要更新的历史');else if(p.done%30<3||p.done===p.total)log(`历史指数 ${p.done}/${p.total}，缓存命中${p.cacheHits}`);}});
      const fetchImpl=sectorFetch(browser.context,{onFailure:record=>{browser.networkFailures??=[];browser.networkFailures.push(record);}});
      historyProvider??=new SectorHistoryProvider({fetchImpl,catalogLoader:kind=>loadSectorCatalog(kind,{fetchImpl,signal}),cacheDir:path.join(ROOT,'历史缓存'),signal,refresh:!!cfg['refresh-history'],onCatalog:async catalogs=>{run.catalogs=catalogs;await atomicJSON(path.join(directory,'板块目录.json'),catalogs);},onProgress:p=>{if(p.stage==='catalog')log(`${p.kind==='industry'?'行业':'概念'}目录 ${p.count}个 / ${p.pages}页`);else if(p.done===1||p.done%20===0||p.done===p.total)log(`历史指数 ${p.done}/${p.total}，缓存命中${p.cacheHits}`);}});
      const data=await checkpoint(`获取完整行业/概念目录并计算${periodLabel(run.lookback)}`,()=>historyStage(()=>historyProvider.collect(run.lookback)));
      run.periodEvidence=data.evidence;run.sector=selectHistoricalSector(data.ranking,cfg.rank);
      run.rankings=['industry','concept'].map(kind=>({kind,source:data.evidence.source,leaders:data.ranking.ranked.filter(r=>r.kind===kind).slice(0,10)}));
      await atomicJSON(path.join(directory,'区间指数数据.json'),data.entries);await atomicJSON(path.join(directory,'板块排名.json'),data.ranking);
      const rows=[['排名','代码','名称','类型',periodLabel(run.lookback)+'(%)','基准交易日','截止交易日','基准收盘字段','最新收盘字段'],...data.ranking.ranked.map(r=>[r.rank,r.code,r.name,r.kind,r.rate.toFixed(6),r.baseDate,r.endDate,r.baseClose,r.endClose])];
      await fs.writeFile(path.join(directory,'板块排名.csv'),'\ufeff'+rows.map(r=>r.map(csv).join(',')).join('\r\n'));
    }
    log(`${periodLabel(run.lookback)}：${run.sector.name} ${run.sector.rate.toFixed(2)}%`);
    run.status='rankings_only';run.marketDate=run.periodEvidence?.asOf||'';return run;
    }
    }else{
      log(`沿用已选${run.sectors?.map(s=>s.name).join('、')||run.sector?.name}板块，只补采${(run.resumeCaptureCodes||run.resumePendingCodes).length}只待确认股票，不重新排名`);
      if(run.resumeReviewFromSavedCodes?.length){log(`将${run.resumeReviewFromSavedCodes.length}张已保存缺项原图交给审核，采图同时继续`);scheduleVisual(true);}
    }
    await persist();
    log(`行情及图表来源：${sourceName(run.marketSource)}；报价初筛和四项视觉策略不变`);
    if(run.resumeOf?.sourceChanged)log(`本轮换源：待确认股票重新读取${sourceName(run.marketSource)}报价并采图；已完成项保留原来源及判定`);
    const tencent=run.selectionMode==='specified-sectors'||run.periodEvidence?.source===TENCENT_SOURCE;
    let consecutiveBlankQuotes=[],consecutiveChartFailures=[];
    const captureItems=run.items.filter(item=>!seed||(run.resumeCaptureCodes||run.resumePendingCodes).includes(item.code));
    const unclaimed=()=>captureItems.filter(i=>!captureCoordinator.claimed.has(i.code));
    await captureCoordinator.run(captureItems,browserPool,async(item,captureBrowser,lane)=>{
      const checkpointItem=(stage,fn)=>checkpoint(stage,fn,signal,lane);
      item.captureLane=lane.id;item.captureReady=false;
      signal?.throwIfAborted();
      assignSource(item,run.marketSource);
      item.attemptedAt=new Date().toISOString();
      if(run.selectionMode==='specified-sectors'&&run.quoteMarketDate)item.expectedMarketDate=run.quoteMarketDate;
      if(tencent||seed){
        try{
          const quote=await checkpointItem(`可见报价 ${item.code} ${item.name}`,()=>captureBrowser.stockQuote(item));
          consecutiveBlankQuotes=[];
          assertCaptureSource(quote,run.marketSource);signal?.throwIfAborted();
          if(run.selectionMode==='specified-sectors'){
            const actualDate=quote.dateText?.match(/20\d{2}-\d{2}-\d{2}/)?.[0];
            if(!validDay(actualDate))throw Object.assign(Error('可见报价实际交易日缺失，不能混用不同交易日'),{code:'QUOTE_DATE_NOT_READY'});
            if(run.quoteMarketDate&&run.quoteMarketDate!==actualDate)throw Object.assign(Error('批次报价交易日发生变化，请重新运行当天名单'),{code:'MARKET_DATE_CHANGED'});
            run.quoteMarketDate=actualDate;
          }
          const {image,...snapshot}=quote;item.quoteSnapshot={...snapshot,source:snapshot.source||run.marketSource};item.price=quote.price;item.open=quote.open;
          await saveImage(item.code+'-报价.png',image,`${item.code} ${item.name} 本次可见现价/今开及日期`);
          item.result={status:prefilter(item)==='淘汰'?'淘汰':'待确认',reason:prefilter(item)==='淘汰'?'可见现价≤今开':'等待新15分钟图'};
          log(`报价初筛 ${item.code}：${prefilter(item)==='淘汰'?'淘汰（现价≤今开）':'通过（现价>今开）'}`);
        }catch(e){
          if(signal?.aborted||['MANUAL_VERIFICATION_REQUIRED','MARKET_DATE_CHANGED'].includes(e.code))throw e;
          item.captureError=e.message;item.captureErrorCode=e.code||'';item.result={status:'待确认',reason:e.message};
          log(`报价失败 ${item.code} ${item.name}：${e.message}`);
          try{
            const d=await captureBrowser.quoteDiagnostic();item.quoteSnapshot=d.snapshot;item.quoteNetworkFailures=d.networkFailures||[];
            await saveImage(item.code+'-报价缺失.png',d.image,`${item.code} 可见报价缺失现场`);
            await atomicJSON(path.join(directory,item.code+'-报价诊断.json'),{code:item.code,name:item.name,errorCode:e.code||'',snapshot:d.snapshot,networkFailures:item.quoteNetworkFailures});
          }catch(diagnosticError){if(signal?.aborted||diagnosticError.code==='MANUAL_VERIFICATION_REQUIRED')throw diagnosticError;}
          const q=item.quoteSnapshot,blank=q?.code===item.code&&q?.name===item.name&&['','-','--'].includes(q.price)&&['','-','--'].includes(q.open);
          consecutiveBlankQuotes=e.code==='QUOTE_NOT_READY'&&blank?[...consecutiveBlankQuotes,item.code]:[];
          if(consecutiveBlankQuotes.length>=2){
            const later=unclaimed();
            run.quoteConnection={status:'unavailable',observedCodes:consecutiveBlankQuotes,unvisitedCodes:later.map(i=>i.code),basis:'连续两只页面身份明确，等待并普通刷新后现价/今开仍为空；不据此断言网络或网站限制'};
            for(const next of later)next.result={status:'待确认',reason:'连续空报价后提前停止，尚未访问此股票'};
            if(later.length){scheduleVisual(true);throw Object.assign(Error(`连续2只页面现价/今开均为空，已停止剩余${later.length}只，避免逐只重复等待；可能是网络或网站访问限制，详见报价诊断和失败页面`),{code:'QUOTE_SOURCE_UNAVAILABLE'});}
          }
          await persist();return;
        }
      }
      if(prefilter(item)!=='通过初筛')return;
      try{
        const capture=await checkpointItem(`尝试采图 ${item.code} ${item.name}`,()=>captureBrowser.chart(item,{evidenceMode:run.evidenceMode}));
        assertCaptureSource(capture.chartInfo||{},run.marketSource);
        consecutiveChartFailures=[];
        signal?.throwIfAborted();if(!capture.image?.length)throw Error('截图为空，不计作有效新图');
        const chartFile=item.code+'-15分钟.png';
        await saveImage(chartFile,capture.image,`${item.code} ${item.name} 本次15分钟图`);
        Object.assign(item,{chartFile,capturedAt:capture.capturedAt,chartInfo:{...capture.chartInfo,source:capture.chartInfo?.source||run.marketSource},imageSHA256:createHash('sha256').update(capture.image).digest('hex')});
        item.periodFiles=[];
        for(const [n,frame] of (capture.periodImages||[]).entries()){
          const file=`${item.code}-周期${n+1}.png`;await saveImage(file,frame.image,`${item.code} ${item.name} K线右侧悬停${n+1}，只作周期时间证据，可能是历史位置，须目视核对`);
          item.periodFiles.push({file,point:frame.point,capturedAt:frame.capturedAt,imageSHA256:createHash('sha256').update(frame.image).digest('hex')});
        }
        item.parameterFiles=[];
        for(const[n,frame]of(capture.parameterImages||[]).entries()){
          const file=`${item.code}-MA参数${n+1}.png`;await saveImage(file,frame.image,`${item.code} ${item.name} 本次可见MA周期参数设置，不作为现价或图形判定`);
          item.parameterFiles.push({file,parameters:frame.parameters,evidenceRegion:frame.evidenceRegion,imageSHA256:createHash('sha256').update(frame.image).digest('hex')});
        }
        signal?.throwIfAborted();item.captureReady=true;delete item.captureError;delete item.captureErrorCode;
        item.result={status:'待确认',reason:'新图已保存，等待视觉模型复核'};
        log(`截图已保存 ${item.code} ${item.name}；等待模型核对真实周期、均线及量柱`);
      }catch(e){
        item.captureError=abortCause(e,signal).message;item.captureErrorCode=abortCause(e,signal).code||e.code||'';item.result={status:'待确认',reason:item.captureError};log(`采图失败 ${item.code} ${item.name}：${item.captureError}`);if(signal?.aborted||e.code==='MANUAL_VERIFICATION_REQUIRED'||/验证码|访问拦截|captureBrowser.*closed|Target.*closed/i.test(e.message))throw e;
        if(captureBrowser.chartDiagnostic)try{const d=await captureBrowser.chartDiagnostic();item.chartFailureSnapshot=d.snapshot;item.chartNetworkFailures=d.networkFailures||[];await saveImage(item.code+'-图表未就绪.png',d.image,`${item.code} 图表采集失败现场，不是有效15分钟图`);await atomicJSON(path.join(directory,item.code+'-图表诊断.json'),{snapshot:d.snapshot,errorCode:item.captureErrorCode,networkFailures:item.chartNetworkFailures});}catch(d){if(signal?.aborted||d.code==='MANUAL_VERIFICATION_REQUIRED')throw d;}
        consecutiveChartFailures=['CHART_NETWORK_FAILED','CHART_NOT_READY'].includes(e.code)?[...consecutiveChartFailures,item.code]:[];
        if(consecutiveChartFailures.length>=2){
          const later=unclaimed();
          run.chartConnection={status:'unavailable',observedCodes:consecutiveChartFailures,unvisitedCodes:later.map(i=>i.code)};
          scheduleVisual(true);
          if(later.length)throw Object.assign(Error(`连续2只K线采集受阻，已停止剩余${later.length}只；已保存的图证和判定保留，详见图表诊断`),{code:'CHART_SOURCE_UNAVAILABLE'});
        }
      }
      await persist();
      scheduleVisual();
    },{queue:cfg['capture-only']?undefined:queue});
    finishCapture();
    const quoteGaps=(tencent||seed)&&run.items.some(i=>prefilter(i)==='待确认');
    if(quoteGaps&&!reviewTargets(run).length){run.status='incomplete_quotes';run.error='板块及名单已确定，待采个股可见报价缺失；本批未完成图形筛选';}
    else if(cfg['capture-only'])run.status=quoteGaps?'captured_with_quote_gaps':'captured_only';
    else if(!reviewTargets(run).length){run.status=run.items.some(i=>prefilter(i)!=='淘汰'&&(!seed||run.resumePendingCodes.includes(i.code)))?'completed_with_capture_gaps':'completed';run.visualNotes='没有需要复核的有效15分钟图，未调用视觉模型';}
    else{
      await finishVisual();run.status=quoteGaps?'completed_with_quote_gaps':run.items.some(i=>(!i.chartFile||i.captureReady===false)&&prefilter(i)==='通过初筛')?'completed_with_capture_gaps':'completed';
    }
  }catch(e){
    const reason=abortCause(e,signal);run.status=signal?.aborted?'interrupted':'failed';run.error=reason.message;run.errorCode=reason.code||'';
    if(!captureDone)finishCapture(signal?.aborted?'interrupted':'failed','采图停止：'+reason.message);
    if(reason.code==='SCREENING_TIMEOUT'&&!reviewSignal?.aborted&&!cfg['capture-only'])log('采集预算已到，停止新增采集；使用独立模型预算复核已保存原图');
    try{await finishVisual();}catch(reviewError){const cause=abortCause(reviewError,reviewSignal);run.reviewError=cause.message;run.reviewErrorCode=cause.code||'';if(cause.message!==run.error)run.error+='；原图复核未完成：'+cause.message;}
    for(const item of run.items)if(prefilter(item)!=='淘汰'&&(!seed||run.resumePendingCodes.includes(item.code))&&!(item.review&&item.reviewImageSHA256===item.imageSHA256&&['符合','淘汰'].includes(item.result?.status)))item.result={status:'待确认',reason:item.captureError||(run.quoteConnection?.unvisitedCodes.includes(item.code)?'连续空报价后提前停止，尚未访问此股票':run.chartConnection?.unvisitedCodes.includes(item.code)?'连续K线请求失败后提前停止，尚未访问此股票':'批次未完成：'+reason.message)};
  }
  finally{
    if(!queue.closed&&!cfg['capture-only']&&!cfg['members-only']&&!cfg['rankings-only'])await finishVisual().catch(()=>{});
    if(!captureDone)finishCapture(run.error?'failed':'completed');
    if(run.error){run.diagnosticFiles=[];for(const [n,b]of browserPool.entries())if(b?.diagnostics)try{const dir=browserPool.length>1?path.join(directory,'失败现场','采图'+(n+1)):directory;await fs.mkdir(dir,{recursive:true});const files=await b.diagnostics(dir,run.error);run.diagnosticFiles.push(...files.map(f=>path.relative(directory,path.join(dir,f))));}catch{}}
    unsubscribeCapture();unsubscribePause?.();run.taskPause=pause?.state()||run.taskPause;run.pauseSeconds=Math.max(0,(pause?.pausedMs||0)-initialPauseMs)/1000;run.manualWaitSeconds=Math.max(captureCoordinator.manualWaitMs,...browserPool.map(b=>b?.manualWaitMs||0))/1000;run.finishedAt=new Date().toISOString();await persist();
  }
  return run;
}

export async function reviewSavedBatch(cfg,{review=reviewWithCodex,signal,pause,executable,onProgress=()=>{},log=console.log}={}){
  const source=path.resolve(cfg['review-only']),original=JSON.parse(await fs.readFile(path.join(source,'run.json'),'utf8'));
  if(original.kind!=='standalone-visual-script'&&!original.replayOf)throw Error('仅支持本脚本保存的批次');
  const input=reviewInput(original,{includeAuxiliary:true,requireAuxiliary:!reviewSettings(cfg).singleChartOnly}),stamp=new Date().toISOString().replace(/[-:]/g,'').slice(0,15).replace('T','-'),directory=path.join(cfg.outputRoot,stamp+'-'+randomBytes(3).toString('hex')+'-重评');
  // 检查各图存在，再核对15分钟图的原采集SHA256；缺图或K线原图改动时禁止补抓和继续。
  const retainedImages=[];
  for(const image of input.images){
    const item=input.targets.find(i=>i.chartFile===image.file),period=input.targets.flatMap(i=>[...(i.periodFiles||[]),...(i.parameterFiles||[])]).find(p=>p.file===image.file);let bytes;
    try{bytes=await fs.readFile(path.join(source,image.file));}catch(error){if(error.code==='ENOENT'&&!item&&reviewSettings(cfg).singleChartOnly){log('本地辅助图缺失，主图模式继续：'+image.file);continue;}throw error;}
    if(!bytes.length||bytes.length>20*1024*1024)throw Error('原图为空或超过大小限制：'+image.file);
    if(item&&(!item.imageSHA256||createHash('sha256').update(bytes).digest('hex')!==item.imageSHA256))throw Error('原15分钟图SHA256不符：'+image.file);
    if(period&&(!period.imageSHA256||createHash('sha256').update(bytes).digest('hex')!==period.imageSHA256))throw Error('原'+(period.parameters?'MA参数图':'周期悬停图')+'SHA256不符：'+image.file);
    retainedImages.push(image);
  }
  input.images=retainedImages;
  signal?.throwIfAborted();await fs.mkdir(directory,{recursive:true});
  const run=structuredClone(original);Object.assign(run,{id:path.basename(directory),kind:'saved-image-visual-review',startedAt:new Date().toISOString(),status:'running',events:[],images:input.images,replayOf:{id:original.id,directory:source,startedAt:original.startedAt,finishedAt:original.finishedAt,elapsedSeconds:original.elapsedSeconds},manualWaitSeconds:0});
  run.pipeline={capture:{status:'disabled',detail:'仅复核原图，不重新采图'},review:{status:'running',detail:'准备原图审核',queued:input.codes.length,active:0}};
  run.visionBatches=[];run.reviewBatchSequence=0;run.reviewWorkers=reviewWorkers(cfg.reviewWorkers);run.screenBudgetSeconds=0;run.reviewBudgetSeconds=cfg.reviewSeconds;run.visionModel=cfg.model||'gpt-6.1-sol';run.visionProvider=cfg.visionProvider||'codex';
  Object.assign(run,reviewSettings(cfg));
  for(const key of ['error','errorCode','finishedAt','counts','diagnosticFiles','contextConfirmed','visualNotes'])delete run[key];
  run.supplementPlans=[];run.supplementAttempts=[];
  for(const item of run.items)if(prefilter(item)!=='淘汰'){for(const key of ['review','reviewImageSHA256','reviewEngine','chartVisualConfirmed','distanceToMA20Percent'])delete item[key];item.result={status:'待确认',reason:item.captureError||(item.chartFile?'原图等待本次视觉复核':!item.quoteSnapshot?'原批次未访问，未参与本次原图复核':'原批次缺少图证，未参与本次原图复核')};}
  await atomicJSON(path.join(directory,'原批次.json'),original);
  for(const image of input.images)await fs.copyFile(path.join(source,image.file),path.join(directory,image.file));
  for(const file of ['板块目录.json','板块排名.json','板块排名.csv','区间指数数据.json','板块成分目录.json']){
    try{await fs.copyFile(path.join(source,file),path.join(directory,file));}catch(e){if(e.code!=='ENOENT')throw e;}
  }
  const initialPauseMs=pause?.pausedMs||0;run.pauseSeconds=0;run.taskPause=pause?.state()||{requested:false,status:'running',active:0};
  let pauseSignature='';const unsubscribePause=pause?.subscribe(state=>{const key=state.requested+':'+state.status;if(key===pauseSignature)return;pauseSignature=key;run.taskPause=state;run.pauseSeconds=Math.max(0,pause.pausedMs-initialPauseMs)/1000;void saveRunProgress(run,directory).catch(e=>log('原图审核暂停状态未保存：'+e.message));});
  const queue=new ReviewQueue({workers:run.reviewWorkers,signal,pause,onState:state=>{Object.assign(run.pipeline.review,state);run.pipeline.review.detail=state.error?'审核暂停：'+state.error:state.status==='completed'?'审核队列已处理完':`原图审核 ${state.activeWorkers}/${state.workers}路，排队${state.queued}只`;void saveRunProgress(run,directory).catch(e=>log('原图审核进度未保存：'+e.message));},process:async codes=>{
    await reviewInBatches(run,directory,{pause,review:(...args)=>{if(queue.error)throw queue.error;return review(...args);},executable,model:cfg.model,provider:cfg.visionProvider,signal,codes,append:true,checkpoint:async(stage,task)=>{run.currentStage=stage;run.pipeline.review.detail=stage;await saveResults(run,directory);onProgress(run,directory);const start=Date.now();try{return await task();}finally{run.events.push({stage,startedAt:new Date(start).toISOString(),elapsedMs:Date.now()-start});}},onResults:async()=>{await saveResults(run,directory);onProgress(run,directory);}});
  }});
  try{
    await saveResults(run,directory);onProgress(run,directory);log(`仅重评原批次${original.id}：${input.codes.join('、')}，审核${run.reviewWorkers}路，不重采行情`);
    queue.add(input.codes);await queue.finish();
    run.status=run.items.some(i=>prefilter(i)==='待确认')?'completed_with_quote_gaps':run.items.some(i=>prefilter(i)==='通过初筛'&&!i.chartFile)?'completed_with_capture_gaps':'completed';
  }catch(e){const reason=abortCause(e,signal);run.status=signal?.aborted?'interrupted':'failed';run.error=reason.message;run.errorCode=reason.code||'';}
  finally{unsubscribePause?.();run.taskPause=pause?.state()||run.taskPause;run.pauseSeconds=Math.max(0,(pause?.pausedMs||0)-initialPauseMs)/1000;run.pipeline.review.active=0;run.pipeline.review.activeWorkers=0;run.pipeline.review.status=run.error?'failed':'completed';run.finishedAt=new Date().toISOString();await saveResults(run,directory);onProgress(run,directory);}
  return{run,directory};
}

export async function prepareResume(cfg){
  const source=path.resolve(cfg.resume),original=JSON.parse(await fs.readFile(path.join(source,'run.json'),'utf8'));
  if(original.kind!=='standalone-visual-script'&&!original.replayOf)throw Error('只支持本脚本已保存的选股批次');
  const originalSource=original.marketSource||'eastmoney',selectedSource=cfg.sourceExplicit?cfg.source:originalSource;sourceName(originalSource);sourceName(selectedSource);
  const sourceChanged=selectedSource!==originalSource;cfg={...cfg,source:selectedSource};
  const pending=original.items.filter(i=>!i.result||i.result.status==='待确认'),expectedDate=original.marketDate||original.quoteMarketDate||original.periodEvidence?.asOf||null;
  if(!pending.length)throw Error('原批次没有待确认股票，无需补采');
  if(original.selectionMode==='specified-sectors'&&!selectedMembershipConfirmed(original))throw Error('原批次指定板块或成分证据不完整，请按原指定名单重新启动');
  if(!validDay(expectedDate)&&!(original.selectionMode==='specified-sectors'&&original.selection?.date===new Date().toLocaleDateString('sv-SE',{timeZone:'Asia/Shanghai'})))throw Error('原批次没有明确行情日且不是当天名单，无法安全补采，请重新运行当天名单');
  if(pending.some(i=>!/^\d{6}$/.test(i.code))||new Set(pending.map(i=>i.code)).size!==pending.length)throw Error('补采股票代码无效或重复');
  const stamp=new Date().toISOString().replace(/[-:]/g,'').slice(0,15).replace('T','-'),directory=path.join(cfg.outputRoot,stamp+'-'+randomBytes(3).toString('hex')+'-补采');await fs.mkdir(path.join(directory,'恢复前现场'),{recursive:true});
  const seed=structuredClone(original),codes=pending.map(i=>i.code);
  const savedCodes=pending.filter(i=>!sourceChanged&&i.captureReady!==false&&i.chartFile&&i.chartInfo?.readiness?.ready===true&&!i.review&&prefilter(i)==='通过初筛'&&i.quoteSnapshot?.dateText?.includes(expectedDate)&&Number.isFinite(Date.parse(i.capturedAt))).map(i=>i.code),captureCodes=codes.filter(c=>!savedCodes.includes(c));
  Object.assign(seed,{marketSource:selectedSource,resumeOf:{id:original.id,directory:source,finishedAt:original.finishedAt,expectedMarketDate:expectedDate,marketSource:originalSource,sourceChanged},resumePendingCodes:codes,resumeCaptureCodes:captureCodes,resumeReviewFromSavedCodes:savedCodes,screenBudgetSeconds:cfg.seconds,historyBudgetSeconds:0});
  for(const item of seed.items)item.marketSource??=sourceFromURL(item.quoteSnapshot?.url)||originalSource;
  for(const key of ['error','errorCode','finishedAt','counts','diagnosticFiles','contextConfirmed','visualNotes','quoteConnection','chartConnection','replayOf'])delete seed[key];
  seed.images=[];
  for(const image of original.images||[]){
    if(path.basename(image.file)!==image.file||/[\\/]/.test(image.file))throw Error('原图清单路径异常');
    try{
      await fs.copyFile(path.join(source,image.file),path.join(directory,'恢复前现场',image.file));
      const code=image.file.match(/^(\d{6})-/)?.[1];
      if(!code||!captureCodes.includes(code)){await fs.copyFile(path.join(source,image.file),path.join(directory,image.file));seed.images.push(image);}
    }catch(e){if(e.code==='ENOENT')throw Error('原批次图证缺失，不能补采：'+image.file);throw e;}
  }
  for(const item of seed.items.filter(i=>i.chartFile&&!captureCodes.includes(i.code))){
    if(!seed.images.some(i=>i.file===item.chartFile))throw Error('已完成股票缺少原图清单：'+item.code);
    const bytes=await fs.readFile(path.join(directory,item.chartFile));
    if(!item.imageSHA256||createHash('sha256').update(bytes).digest('hex')!==item.imageSHA256)throw Error('已完成股票原图SHA256不符：'+item.code);
    for(const period of [...(item.periodFiles||[]),...(item.parameterFiles||[])]){
      if(!seed.images.some(i=>i.file===period.file)||path.basename(period.file)!==period.file)throw Error('周期图清单缺失或路径异常：'+item.code);
      const bytes=await fs.readFile(path.join(directory,period.file));if(!period.imageSHA256||createHash('sha256').update(bytes).digest('hex')!==period.imageSHA256)throw Error('周期图SHA256不符：'+item.code);
    }
  }
  for(const item of seed.items)if(captureCodes.includes(item.code)){
    for(const key of ['price','open','quoteSnapshot','quoteNetworkFailures','chartFile','chartInfo','chartFailureSnapshot','chartNetworkFailures','periodFiles','parameterFiles','capturedAt','imageSHA256','review','reviewImageSHA256','reviewEngine','chartVisualConfirmed','distanceToMA20Percent','captureError','captureErrorCode','attemptedAt'])delete item[key];
    assignSource(item,selectedSource);
    item.expectedMarketDate=expectedDate;item.result={status:'待确认',reason:'等待补采可见报价和15分钟图'};
  }
  await atomicJSON(path.join(directory,'原批次.json'),original);
  for(const file of ['指定板块.json','板块目录.json','板块排名.json','板块排名.csv','区间指数数据.json','板块成分目录.json'])try{await fs.copyFile(path.join(source,file),path.join(directory,file));}catch(e){if(e.code!=='ENOENT')throw e;}
  return{seed,directory,cfg:{...cfg,rank:original.rank,lookback:original.lookback||1,limit:original.limit,allMembers:!!original.allMembers,memberPercent:original.memberPercent}};
}

export async function main(argv=process.argv.slice(2),ui={}){
  ui.signal?.throwIfAborted();
  await ui.pause?.wait(ui.signal);
  let cfg=options(argv);if(cfg.help){console.log(HELP);return 0;}
  const needsVision=!cfg['capture-only']&&!cfg['members-only']&&!cfg.login&&!cfg['check-browser']&&!cfg['rankings-only'];
  const engine=needsVision?resolveVisionEngine(cfg.model,{apiKey:ui.deepseekApiKey||process.env.DEEPSEEK_API_KEY,qwenApiKey:ui.qwenApiKey||process.env.DASHSCOPE_API_KEY,qwenBaseUrl:cfg.qwenBaseUrl}):null;
  if(engine){cfg.model=engine.id;cfg.visionProvider=engine.provider;Object.assign(cfg,reviewSettings(cfg));console.log('视觉模型：'+engine.name+'（'+(engine.requiresCodex?'Codex额度；推理'+cfg.reasoningEffort:engine.provider==='qwen'?'千问API余额':'DeepSeek API余额')+'）；'+(evidenceLabel(cfg.evidenceMode)+'，完整原图保留')+'；原有四项策略不变');}
  const selectedReview=engine?.review||reviewWithCodex;
  let resumed;
  if(cfg.resume){resumed=await prepareResume(cfg);cfg=resumed.cfg;}
  if(resumed&&!resumed.seed.resumeCaptureCodes.length){
    const executable=engine?.requiresCodex?await findCodex():undefined;if(executable&&!await codexStatus(executable))throw Error('Codex CLI尚未登录，请先运行codex login');
    const controller=new AbortController(),budget=new ActiveBudget(cfg.reviewSeconds*1000,()=>controller.abort(budgetError(`原图断点复核达到${cfg.reviewSeconds}秒独立复核预算`,'REVIEW_TIMEOUT'))),releaseStop=bindTaskStop(controller,{signal:ui.signal,message:'用户停止断点复核'});
    const releasePause=ui.pause?.bindBudget(budget);
    try{const liveArchive=new LiveArchiveSession(resumed.directory,cfg),run=await runScreening(cfg,{seed:resumed.seed,browser:{},directory:resumed.directory,signal:controller.signal,pause:ui.pause,executable,review:selectedReview,onProgress:r=>liveArchive.schedule(r)});budget.dispose();await liveArchive.flush(run);console.log(outcomeMessage(run,resumed.directory));return ['completed','captured_only'].includes(run.status)?0:2;}finally{budget.dispose();releasePause?.();releaseStop();}
  }
  if(!cfg.login&&!cfg.check&&!cfg['check-browser']&&!cfg['review-only']&&!cfg.resume&&!cfg['rankings-only'])cfg.selection=await readSelection(cfg);
  if(cfg['members-only']){
    const stamp=new Date().toISOString().replace(/[-:]/g,'').slice(0,15).replace('T','-'),directory=path.join(cfg.outputRoot,stamp+'-'+randomBytes(3).toString('hex')+'-成分预览');await fs.mkdir(directory,{recursive:true});
    const controller=new AbortController(),budget=new ActiveBudget(cfg.seconds*1000,()=>controller.abort(budgetError('指定成分预览达到执行预算','MEMBERS_TIMEOUT'))),releaseStop=bindTaskStop(controller,{signal:ui.signal,message:'用户停止成分预览'});
    const releasePause=ui.pause?.bindBudget(budget);
    try{const run=await runScreening(cfg,{browser:{},directory,signal:controller.signal,pause:ui.pause});console.log(outcomeMessage(run,directory));return run.status==='members_only'?0:2;}finally{budget.dispose();releasePause?.();releaseStop();}
  }
  if(cfg['review-only']){
    const executable=engine?.requiresCodex?await findCodex():undefined;if(executable&&!await codexStatus(executable))throw Error('Codex CLI尚未登录，请先运行codex login');
    const controller=new AbortController(),budget=new ActiveBudget(cfg.reviewSeconds*1000,()=>controller.abort(budgetError(`保存原图复核达到${cfg.reviewSeconds}秒独立复核预算，已保存进度`,'REVIEW_TIMEOUT'))),releaseStop=bindTaskStop(controller,{signal:ui.signal,message:'用户已停止复核'});
    const releasePause=ui.pause?.bindBudget(budget);
    try{let liveArchive;const {run,directory}=await reviewSavedBatch(cfg,{executable,review:selectedReview,signal:controller.signal,pause:ui.pause,onProgress:(r,d)=>{if(!liveArchive&&d)liveArchive=new LiveArchiveSession(d,cfg);liveArchive?.schedule(r);}});budget.dispose();liveArchive??=new LiveArchiveSession(directory,cfg);await liveArchive.flush(run);console.log('\n'+outcomeMessage(run,directory));return run.status==='completed'?0:2;}
    finally{budget.dispose();releasePause?.();releaseStop();}
  }
  // 纯腾讯板块排名不需要行情浏览器、登录或视觉模型，可在个股窗口等待人工时独立运行。
  if(cfg['rankings-only']&&cfg.lookback>1&&cfg['sector-source']==='tencent'&&!cfg.login&&!cfg.check&&!cfg['check-browser']){
    const stamp=new Date().toISOString().replace(/[-:]/g,'').slice(0,15).replace('T','-'),directory=path.join(cfg.outputRoot,stamp+'-'+randomBytes(3).toString('hex'));
    await fs.mkdir(directory,{recursive:true});const controller=new AbortController(),releaseStop=bindTaskStop(controller,{signal:ui.signal});
    try{const run=await runScreening(cfg,{browser:{},directory,signal:controller.signal,pause:ui.pause,historyStage:task=>historyStageWithBudget(task,{milliseconds:cfg.historySeconds*1000,controller})});console.log('\n'+outcomeMessage(run,directory));return run.status==='rankings_only'?0:2;}
    finally{releaseStop();}
  }
  const {chromium}=await loadPlaywright(),browserExe=await findBrowser(chromium,cfg.browserExe);
  let executable;if(engine?.requiresCodex)executable=await findCodex();
  if(cfg.check){
    const visionRequired=!cfg['capture-only']&&!cfg['rankings-only'],loggedIn=executable?await codexStatus(executable):false,profileReady=cfg.source==='sina'||await fs.access(path.join(cfg.profileDir,'screening-profile.json')).then(()=>true,()=>false);
    console.log(JSON.stringify({browserExe,visionModel:engine?.id||null,visionProvider:engine?.provider||null,codexExecutable:executable||null,visionRequired,codexLoggedIn:engine?.requiresCodex?loggedIn:null,profileDir:cfg.profileDir,profileReady,marketSource:cfg.source,loginRequired:cfg.source==='eastmoney',lookback:cfg.lookback,workbenchRequired:false},null,2));
    return (!visionRequired||!engine?.requiresCodex||loggedIn)&&profileReady?0:2;
  }
  if(cfg.login){
    ui.signal?.throwIfAborted();
    await fs.mkdir(cfg.profileDir,{recursive:true});
    const controller=new AbortController(),releaseStop=bindTaskStop(controller,{signal:ui.signal,message:'用户停止登录验证'});let ctx;
    const cancelLogin=()=>void ctx?.close().catch(()=>{});controller.signal.addEventListener('abort',cancelLogin,{once:true});
    try{
      ctx=await chromium.launchPersistentContext(cfg.profileDir,{executablePath:browserExe,headless:false,handleSIGINT:false,viewport:{width:1480,height:1000},timeout:15000});controller.signal.throwIfAborted();
      const page=ctx.pages()[0]||await ctx.newPage();await page.goto(SOURCES[cfg.source].home,{waitUntil:'domcontentloaded',timeout:15000});
      if(ui.waitForUser)await ui.waitForUser({kind:'login',message:'请在专用浏览器完成登录或验证，再点“完成，继续”',signal:controller.signal});
      else{const input=createInterface({input:process.stdin,output:process.stdout});try{await input.question(`请在打开的专用浏览器中自行登录${sourceName(cfg.source)}或完成当前人工验证，完成后按回车保存会话（不在终端输入密码）：`);}finally{input.close();}}
      controller.signal.throwIfAborted();
      await atomicJSON(path.join(cfg.profileDir,cfg.source==='sina'?'screening-sina-profile.json':'screening-profile.json'),{purpose:'视觉选股脚本专用会话',source:cfg.source,userAcknowledgedLoginAt:new Date().toISOString(),note:'每次实际图证仍须重新核对；该标记不证明持续登录有效'});
    }finally{releaseStop();controller.signal.removeEventListener('abort',cancelLogin);await ctx?.close();}return 0;
  }
  if(!cfg['check-browser']){
    const ready=cfg.source==='sina'||await fs.access(path.join(cfg.profileDir,'screening-profile.json')).then(()=>true,()=>false);
    if(!ready){console.error('首次使用请先运行 .\\选股.cmd --login，在专用浏览器登录一次；不复制日常浏览器的cookie。');return 2;}
    if(executable&&!await codexStatus(executable)){console.error('Codex CLI尚未登录，请先运行codex login。');return 2;}
  }
  let directory,seed;
  ui.signal?.throwIfAborted();
  if(resumed){directory=resumed.directory;seed=resumed.seed;}
  else{const stamp=new Date().toISOString().replace(/[-:]/g,'').slice(0,15).replace('T','-');directory=path.join(cfg.outputRoot,stamp+'-'+randomBytes(3).toString('hex'));}
  await fs.mkdir(directory,{recursive:true});const started=Date.now();
  const liveArchive=new LiveArchiveSession(directory,cfg);
  let ctx;const controller=new AbortController(),reviewController=new AbortController(),reviewSignal=AbortSignal.any([controller.signal,reviewController.signal]),captureController=new AbortController(),captureSignal=AbortSignal.any([controller.signal,captureController.signal]);
  const budget=new ActiveBudget(cfg.seconds*1000,()=>captureController.abort(budgetError(`采集达到${cfg.seconds}秒预算（人工验证、历史取数暂停采图计时；审核并行另计），停止新增采集并保留部分进度`,'SCREENING_TIMEOUT')));
  const reviewBudget=new ActiveBudget(cfg.reviewSeconds*1000,()=>reviewController.abort(budgetError(`模型复核达到累计${cfg.reviewSeconds}秒独立预算，已保存完成判定`,'REVIEW_TIMEOUT')));reviewBudget.pause();
  const releaseCapturePause=ui.pause?.bindBudget(budget),releaseReviewPause=ui.pause?.bindBudget(reviewBudget);
  const releaseStop=bindTaskStop(controller,{signal:ui.signal});
  captureSignal.addEventListener('abort',()=>{budget.dispose();void ctx?.close().catch(()=>{});},{once:true});
  try{
    const profile=cfg['check-browser']?await fs.mkdtemp(path.join(os.tmpdir(),'stock-script-check-')):cfg.profileDir,launch=()=>chromium.launchPersistentContext(profile,{executablePath:browserExe,headless:cfg.headless??!!cfg['check-browser'],handleSIGINT:false,viewport:{width:1480,height:1000},timeout:15000});
    ctx=ui.pause?await ui.pause.run(launch,captureSignal):await launch();
    captureSignal.throwIfAborted();
    if(cfg['check-browser']){await atomicJSON(path.join(directory,'浏览器启动测试.json'),{status:'passed',elapsedSeconds:(Date.now()-started)/1000,scope:'只验启动，没有行情和模型调用'});console.log('浏览器启动成功；这不是股票速度。记录：'+directory);return 0;}
    const interactive=(process.stdin.isTTY||!!ui.waitForUser)&&!cfg.headless&&!cfg['no-pause'];
    const captureControl=new CaptureCoordinator({signal:captureSignal,pause:ui.pause,onBudgetState:paused=>{if(paused)budget.pause();else if(!captureSignal.aborted)budget.resume();}});
    let verificationSerial=0;
    const browsers=await createCaptureBrowsers(cfg['rankings-only']?'eastmoney':cfg.source,{context:ctx,count:cfg['rankings-only']?1:cfg.captureWorkers,optionsForPage:(page,n)=>{
      const laneId=n+1;
      const onVerification=interactive?gate=>captureControl.verification(async()=>{
        const current=await detectGate(page);if(!current)return;
        await page.bringToFront();await page.screenshot({path:path.join(directory,'验证现场-采图'+laneId+'-'+(++verificationSerial)+'.png'),timeout:3000}).catch(()=>{});
        const stock=captureControl.lanes[n]?.code||'';
        const message='采图'+laneId+' '+stock+'页面要求人工'+(current.kind==='login'?'登录':'验证')+'，请在当前浏览器页完成，再点“完成，继续”';
        console.log('\n暂停新增采图：'+message+'；已保存原图继续审核。');
        if(ui.waitForUser)await ui.waitForUser({kind:current.kind,message,signal:captureSignal});
        else await waitForEnter(message+'；完成后回本终端按回车，Ctrl+C停止：',captureSignal);
      },laneId):undefined;
      return{root:ROOT,signal:captureSignal,onVerification,step:message=>console.log(message+' [采图'+laneId+']'),evidenceDir:path.join(directory,'目录证据','采图'+laneId)};
    }});
    console.log('采图'+browsers.length+'路独立页面；审核'+cfg.reviewWorkers+'路，待审队列达到'+captureControl.backlogLimit+'只时暂停分配新股票');
    console.log(`计时预算：采集${cfg.seconds}秒；模型复核累计${cfg.reviewSeconds}秒；人工等待另计`);
    const run=await runScreening(cfg,{browser:browsers[0],browsers,captureControl,pause:ui.pause,review:selectedReview,reviewSignal,onProgress:r=>liveArchive.schedule(r),onCaptureDone:()=>budget.pause(),reviewStage:task=>reviewStageWithBudget(task,{screenBudget:budget,reviewBudget,signal:reviewSignal,captureSignal,concurrent:true}),seed,directory,signal:captureSignal,executable,historyStage:task=>historyStageWithBudget(task,{screenBudget:budget,milliseconds:cfg.historySeconds*1000,controller})});
    run.startedAt=new Date(started).toISOString();run.finishedAt=new Date().toISOString();await saveResults(run,directory);
    budget.dispose();reviewBudget.dispose();await liveArchive.flush(run);
    console.log('\n'+outcomeMessage(run,directory));
    if(run.error&&interactive&&!ui.waitForUser&&!captureSignal.aborted){budget.pause();await waitForEnter('已保存失败现场，浏览器保持打开。按回车关闭并退出（不会自动重试）：',controller.signal);}
    return ['completed','captured_only','rankings_only'].includes(run.status)?0:2;
  }catch(e){
    const reason=abortCause(e,captureSignal),report={status:'failed',startedAt:new Date(started).toISOString(),finishedAt:new Date().toISOString(),elapsedSeconds:(Date.now()-started)/1000,error:reason.message,errorCode:reason.code||'',ioCode:reason.ioCode||'',failedFile:reason.file||'',scope:cfg['check-browser']?'独立浏览器启动测试':'脚本未完成，不是选股成功'};
    ui.onFailure?.(report);
    try{await atomicJSON(path.join(directory,'启动失败.json'),report);}catch(saveError){console.error('失败原因记录未保存：'+saveError.message);}
    console.error('未完成：'+reason.message.slice(0,1000)+'\n记录：'+directory);return 2;
  }finally{budget.dispose();reviewBudget.dispose();releaseCapturePause?.();releaseReviewPause?.();releaseStop();await ctx?.close().catch(()=>{});}
}

if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href){main().then(code=>{process.exitCode=code;}).catch(e=>{console.error('未启动：'+e.message);process.exitCode=1;});}
