// 合成接口/图片，只验软件契约，不是真实行情或模型质量成绩。
import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs/promises';import os from 'node:os';import path from 'node:path';import {createHash} from 'node:crypto';import {PassThrough} from 'node:stream';
import {reviewWithDeepSeek,readDeepSeekStream} from '../script/deepseek-vision.mjs';
import {VISION_MODELS,resolveVisionEngine} from '../script/vision-engines.mjs';
import {makePrompt,reviewInBatches,codexArgs} from '../script/vision.mjs';
import {requestArgs,serveGUI} from '../script/gui-protocol.mjs';
import {options,reviewSavedBatch,prepareResume,runScreening} from '../script/screen.mjs';
const key='synthetic-not-a-real-secret',png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/lX8AAAAASUVORK5CYII=','base64'),sha=createHash('sha256').update(png).digest('hex'),date='2026-10-23';
const row=code=>({code,identityConfirmed:true,period15mConfirmed:true,latestBarDate:date,allMALabelsVisible:true,volumeComplete:true,chartPrice:12,ma5:12,ma10:11.9,ma20:11.8,ma60:11,shape:'pass',nearMA20:'pass',ma20Above60:'pass',redVolume:'pass',reason:'合成应答'});
const result=codes=>({marketDate:date,marketPhase:'合成收盘',rankingEvidenceConfirmed:true,quoteEvidenceConfirmed:true,notes:'软件测试',stocks:codes.map(row)});
async function fixture(t,count=1){
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'stock-models-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));
 const codes=Array.from({length:count},(_,n)=>String(300001+n));const run={id:'synthetic-models',kind:'standalone-visual-script',startedAt:new Date().toISOString(),status:'running',lookback:1,rank:1,limit:10,marketDate:date,marketSource:'eastmoney',items:codes.map(code=>({code,name:'合成'+code,url:'https://quote.eastmoney.com/sz'+code+'.html',price:'12',open:'11',chartFile:code+'-15分钟.png',imageSHA256:sha,result:{status:'待确认',reason:'合成未复核'}})),images:codes.map(code=>({file:code+'-15分钟.png',label:'合成PNG'})),events:[]};
 for(const image of run.images)await fs.writeFile(path.join(root,image.file),png);return{root,run,codes};
}
function response(payload,{done=true,finish='stop',tool=false}={}){
 const answer=typeof payload==='string'?payload:JSON.stringify(payload),parts=[{id:'synthetic',model:'deepseek-flash',choices:[{index:0,delta:{content:answer.slice(0,Math.floor(answer.length/2)),reasoning_content:'不落盘的推理内容'}}]},{choices:[{index:0,delta:{content:answer.slice(Math.floor(answer.length/2)),...(tool?{tool_calls:[{}]}:{})},finish_reason:finish}],usage:{prompt_tokens:10,completion_tokens:20,total_tokens:30}}];
 const text=parts.map(p=>'data: '+JSON.stringify(p)+'\r\n\r\n').join('')+(done?'data: [DONE]\r\n\r\n':''),bytes=Buffer.from(text);
 return new Response(new ReadableStream({start(controller){for(let i=0;i<bytes.length;i+=7)controller.enqueue(bytes.subarray(i,i+7));controller.close();}}),{status:200});
}
async function tree(dir){const files=[];for(const item of await fs.readdir(dir,{withFileTypes:true})){const file=path.join(dir,item.name);files.push(...(item.isDirectory()?await tree(file):[file]));}return files;}
test('四个精确模型ID路由正确；Codex参数传模型，DeepSeek不依赖Codex登录',()=>{
 assert.deepEqual(VISION_MODELS.filter(m=>m.provider!=='qwen').map(m=>m.id),['gpt-6.1-sol','gpt-6.1-terra','gpt-6-luna','deepseek-flash']);assert.equal(VISION_MODELS.filter(m=>m.provider==='qwen').length,13);
 for(const id of ['gpt-6.1-sol','gpt-6.1-terra','gpt-6-luna']){const engine=resolveVisionEngine(id,{apiKey:''});assert.equal(engine.requiresCodex,true);const args=codexArgs({directory:'.',schemaFile:'s',outputFile:'o',images:[],model:id});assert.equal(args[args.indexOf('--model')+1],id);assert(!args.includes('none'));}
 assert.equal(resolveVisionEngine('deepseek-flash',{apiKey:key}).requiresCodex,false);assert.throws(()=>resolveVisionEngine('deepseek-v4-pro',{apiKey:key}),/不支持/);assert.throws(()=>resolveVisionEngine('deepseek-flash',{apiKey:''}),/密钥/);
});

test('Terra在正常、继续和原图复核中保持精确模型及图证档位，不要求API密钥',async t=>{
 const {root,run,codes}=await fixture(t);await fs.writeFile(path.join(root,'run.json'),JSON.stringify(run));
 const base={command:'start',source:'sina',sectors:['合成行业'],limit:1,captureSeconds:300,reviewSeconds:180,model:'gpt-6.1-terra',batchDirectory:root};
 for(const mode of ['normal','resume','review'])for(const effort of ['default','low','medium','high'])for(const evidenceMode of ['main-auto','main-only','compact','full']){
  const args=await requestArgs({...base,mode,reasoningEffort:effort,evidenceMode},root),cfg=options(args);assert.equal(cfg.model,base.model);assert.equal(cfg.reasoningEffort,effort);assert.equal(cfg.evidenceMode,evidenceMode);
  const cli=codexArgs({images:[],model:cfg.model,reasoningEffort:cfg.reasoningEffort});assert.equal(cli[cli.indexOf('--model')+1],base.model);assert.equal(cli.includes('--config'),effort!=='default');
 }
 await reviewInBatches(run,root,{model:base.model,reasoningEffort:'low',review:async(_run,_dir,opts)=>{assert.equal(opts.model,base.model);assert.equal(opts.reasoningEffort,'low');return result(codes);}});
 assert.equal(run.items[0].result.status,'符合');assert.equal(run.items[0].reviewEngine.model,base.model);assert.equal(run.items[0].reviewEngine.provider,'codex');
});
test('DeepSeek提交相同原图与策略、严格JSON、固定官方端点且不重试；流式碎片中文完整',async t=>{
 const {root,run,codes}=await fixture(t);let calls=0;
 const payload=await reviewWithDeepSeek(run,root,{apiKey:key,fetchImpl:async(url,init)=>{calls++;assert.equal(url,'https://api.deepseek.com/chat/completions');assert.equal(init.redirect,'error');assert.equal(init.headers.Authorization,'Bearer '+key);const body=JSON.parse(init.body);assert.equal(body.model,'deepseek-flash');assert.equal(body.stream,true);assert.equal(body.response_format.type,'json_object');assert(body.messages[0].content[0].text.startsWith(makePrompt(run)));assert.equal(body.messages[0].content[1].image_url.url,'data:image/png;base64,'+png.toString('base64'));assert(!('tools'in body));return response(result(codes));}});
 assert.equal(calls,1);assert.equal(payload.stocks[0].reason,'合成应答');assert.equal(payload.stocks[0].code,codes[0]);
 for(const file of await tree(root)){const text=await fs.readFile(file);assert(!text.includes(Buffer.from(key)),file);assert(!text.includes(Buffer.from('不落盘的推理内容')),file);}
 assert.equal(JSON.parse(await fs.readFile(path.join(root,'视觉复核','API用量.json'))).usage.total_tokens,30);
});
test('HTTP认证/余额/限流失败不重试、不落密钥或原始错误内容，保留待审核',async t=>{
 for(const status of [401,402,429]){const {root,run}=await fixture(t);let calls=0;await assert.rejects(reviewWithDeepSeek(run,root,{apiKey:key,fetchImpl:async()=>{calls++;return new Response(JSON.stringify({error:{message:key}}),{status});}}),e=>e.code==='DEEPSEEK_HTTP_'+status&&!e.message.includes(key));assert.equal(calls,1);assert.equal(run.items[0].result.status,'待确认');assert(!(await fs.readFile(path.join(root,'视觉复核','失败原因.json'),'utf8')).includes(key));}
});
test('流式中断、JSON缺项、额外字段、重复/新增代码与工具调用一律拒绝',async t=>{
 for(const mutate of [p=>({...p,stocks:[{...p.stocks[0],code:'300999'}]}),p=>({...p,stocks:[]}),p=>({...p,extra:'不允许'}),p=>({...p,stocks:p.stocks.map(i=>({...i,shape:'unknown'}))})]){const {root,run,codes}=await fixture(t);await assert.rejects(reviewWithDeepSeek(run,root,{apiKey:key,fetchImpl:async()=>response(mutate(result(codes)))}));assert.equal(run.items[0].result.status,'待确认');}
 const {root,run,codes}=await fixture(t,2);await assert.rejects(reviewWithDeepSeek(run,root,{apiKey:key,fetchImpl:async()=>response({...result(codes),stocks:[row(codes[0]),row(codes[0])]})}),/重复/);
 for(const bad of [{done:false},{finish:'length'},{tool:true}])await assert.rejects(readDeepSeekStream(response(result(codes),bad).body));
});
test('用户取消和接口超时都中止请求；错误及模型文本中的密钥不会落入业务记录',async t=>{
 const {root,run,codes}=await fixture(t),controller=new AbortController();controller.abort(Object.assign(Error('合成取消'),{code:'USER_CANCELLED'}));let calls=0;
 await assert.rejects(reviewWithDeepSeek(run,root,{apiKey:key,signal:controller.signal,fetchImpl:()=>{calls++;}}),/合成取消/);assert.equal(calls,0);
 const slow=async(_url,{signal})=>new Promise((resolve,reject)=>{signal.addEventListener('abort',()=>reject(signal.reason),{once:true});if(signal.aborted)reject(signal.reason);});const hold=setTimeout(()=>{},300);
 await assert.rejects(reviewWithDeepSeek(run,root,{apiKey:key,timeoutMs:10,fetchImpl:slow}),/timeout|timed out/i);clearTimeout(hold);
 await assert.rejects(reviewWithDeepSeek(run,root,{apiKey:key,fetchImpl:async()=>{throw Error('failed '+key);}}),e=>!e.message.includes(key));
 const p=result(codes);p.notes=key;p.stocks[0].reason=key;const safe=await reviewWithDeepSeek(run,root,{apiKey:key,fetchImpl:async()=>response(p)});assert(!JSON.stringify(safe).includes(key));
});
test('新模型使用同一四项判定并记录实际模型；断点完成项的模型和判定保持原样',async t=>{
 const {root,run,codes}=await fixture(t,2);run.resumeOf={expectedMarketDate:date};run.resumePendingCodes=[codes[1]];run.items[0].result={status:'淘汰',reason:'原已完成项'};run.items[0].reviewEngine={provider:'codex',model:'gpt-6.1-sol'};const kept=structuredClone(run.items[0]);
 await reviewInBatches(run,root,{model:'deepseek-flash',provider:'deepseek',review:async()=>result([codes[1]])});assert.deepEqual(run.items[0],kept);assert.equal(run.items[1].result.status,'符合');assert.equal(run.items[1].reviewEngine.model,'deepseek-flash');assert.equal(run.visionBatches[0].provider,'deepseek');
 const failed=result([codes[1]]);failed.stocks[0].shape='fail';await reviewInBatches(run,root,{model:'gpt-6-luna',review:async()=>failed});assert.equal(run.items[1].result.status,'淘汰');assert.equal(run.items[1].review.nearMA20,'not_checked');
});
test('原图重评失败清除本次旧复核标记，原批次不变；成功结果概要和CSV包含实际模型',async t=>{
 const {root,run,codes}=await fixture(t),source=path.join(root,'source'),out=path.join(root,'out');await fs.mkdir(source);await fs.mkdir(out);run.items[0].review=row(codes[0]);run.items[0].reviewImageSHA256=sha;run.items[0].reviewEngine={model:'gpt-6.1-sol',provider:'codex'};await fs.copyFile(path.join(root,run.images[0].file),path.join(source,run.images[0].file));const original=JSON.stringify(run);await fs.writeFile(path.join(source,'run.json'),original);
 const cfg=options(['--review-only',source,'--output-dir',out,'--model','deepseek-flash']);cfg.visionProvider='deepseek';
 const failed=await reviewSavedBatch(cfg,{log:()=>{},review:async()=>{throw Error('合成网络失败');}});assert.equal(failed.run.status,'failed');assert.equal(failed.run.counts.visualReviewed,0);assert.equal(failed.run.items[0].reviewEngine,undefined);
 const good=await reviewSavedBatch(cfg,{log:()=>{},review:async()=>result(codes)});assert.equal(good.run.counts.passed,1);assert.equal(JSON.parse(await fs.readFile(path.join(good.directory,'任务概要.json'))).visionModel,'deepseek-flash');assert((await fs.readFile(path.join(good.directory,'结果.csv'),'utf8')).includes('deepseek-flash'));assert.equal(await fs.readFile(path.join(source,'run.json'),'utf8'),original);
});
test('窗口所有复核路径传真实模型；密钥不进入argv、快照或错误事件',async t=>{
 const {root,run}=await fixture(t);await fs.writeFile(path.join(root,'run.json'),JSON.stringify(run));
 const base={command:'start',mode:'normal',source:'sina',sectors:['合成行业'],limit:1,captureSeconds:300,reviewSeconds:180,model:'deepseek-flash',deepseekApiKey:key};
 for(const mode of ['normal','resume','review','check']){const args=await requestArgs({...base,mode,batchDirectory:root},root);assert.equal(args[args.indexOf('--model')+1],'deepseek-flash');assert(!args.join(' ').includes(key));}
 await assert.rejects(requestArgs({...base,model:'fake'},root),/不支持/);
 const events=[],input=new PassThrough();const p=serveGUI({root,input,emit:e=>events.push(e),interrupt:()=>{},run:async(args,ui)=>{assert.equal(ui.deepseekApiKey,key);assert(!args.join(' ').includes(key));throw Error('合成错误 '+key);}});input.write(JSON.stringify(base)+'\n');await p;input.destroy();assert(!JSON.stringify(events).includes(key));assert.match(events.at(-1).error,/已隐藏密钥/);
});
