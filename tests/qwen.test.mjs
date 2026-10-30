// 软件合成接口，不使用真实密钥、不调用模型、不查询行情。
import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs/promises';import path from 'node:path';import os from 'node:os';import {createHash} from 'node:crypto';import {PassThrough} from 'node:stream';
import {QWEN_MODELS,QWEN_BASE_URL,QWEN_DEFAULT_MODEL,assertQwenReviewModel,normalizeQwenBaseURL} from '../script/qwen-models.mjs';
import {parseQwenAnswer,qwenOutputSettings} from '../script/qwen-response.mjs';import {schemaForRun} from '../script/vision.mjs';
import {reviewWithQwen} from '../script/qwen-vision.mjs';import {resolveVisionEngine} from '../script/vision-engines.mjs';import {requestArgs,serveGUI} from '../script/gui-protocol.mjs';import {options} from '../script/screen.mjs';import {makePrompt,reviewInBatches} from '../script/vision.mjs';
const key='synthetic-qwen-only-secret',png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/lX8AAAAASUVORK5CYII=','base64'),sha=createHash('sha256').update(png).digest('hex'),date='2026-10-23';
const row=code=>({code,identityConfirmed:true,period15mConfirmed:true,latestBarDate:date,allMALabelsVisible:true,volumeComplete:true,chartPrice:12,ma5:12,ma10:11.9,ma20:11.8,ma60:11,shape:'pass',nearMA20:'pass',ma20Above60:'pass',redVolume:'pass',reason:'千问合成判定'});
const payload=codes=>({marketDate:date,marketPhase:'合成收盘',rankingEvidenceConfirmed:true,quoteEvidenceConfirmed:true,notes:'软件合成',stocks:codes.map(row)});
async function fixture(t,count=2){const dir=await fs.mkdtemp(path.join(os.tmpdir(),'stock-qwen-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));const codes=Array.from({length:count},(_,n)=>String(300001+n)),run={id:'qwen-fixture',marketSource:'eastmoney',lookback:1,rank:1,limit:10,singleChartOnly:true,compactEvidence:true,evidenceMode:'main-only',visionModel:QWEN_DEFAULT_MODEL,visionProvider:'qwen',items:codes.map(code=>({code,name:'合成'+code,price:'12',open:'11',chartFile:code+'-15分钟.png',imageSHA256:sha,result:{status:'待确认'}})),images:codes.map(code=>({file:code+'-15分钟.png',label:'合成主图'})),events:[]};for(const i of run.images)await fs.writeFile(path.join(dir,i.file),png);return{dir,run,codes};}
function stream(value,{model=QWEN_DEFAULT_MODEL,done=true,finish='stop',usage=true,tool=false}={}){const answer=typeof value==='string'?value:JSON.stringify(value),split=Math.floor(answer.length/2),events=[{id:'qwen-synthetic',model,choices:[{index:0,delta:{content:answer.slice(0,split),reasoning_content:'不落盘的千问推理'}}]},{choices:[{index:0,delta:{content:answer.slice(split),...(tool?{tool_calls:[{}]}:{})},finish_reason:finish}]},...(usage?[{choices:[],usage:{prompt_tokens:200,completion_tokens:50,total_tokens:250}}]:[])];const bytes=Buffer.from(events.map(e=>'data: '+JSON.stringify(e)+'\r\n\r\n').join('')+(done?'data: [DONE]\r\n\r\n':''));return new Response(new ReadableStream({start(c){for(let i=0;i<bytes.length;i+=7)c.enqueue(bytes.subarray(i,i+7));c.close();}}));}
async function allFiles(dir){const files=[];for(const e of await fs.readdir(dir,{withFileTypes:true})){const file=path.join(dir,e.name);files.push(...(e.isDirectory()?await allFiles(file):[file]));}return files;}

test('截图13个精确型号全部可选，用途分开，实时与翻译型号不误发HTTP审核',async t=>{
 const {dir,run}=await fixture(t);await fs.writeFile(path.join(dir,'run.json'),JSON.stringify(run));assert.equal(QWEN_MODELS.length,13);assert.equal(new Set(QWEN_MODELS.map(m=>m.id)).size,13);
 const expected=['qwen3.5-omni-flash-realtime','qwen3.5-omni-plus-realtime-2026-03-15','qwen3.5-omni-flash-2026-03-15','qwen-mt-uni','qwen3.5-omni-plus-2026-03-15','qwen3-omni-flash-realtime-2025-09-15','qwen3.8-omni-flash','qwen3.5-omni-flash-realtime-2026-03-15','qwen3-omni-flash','qwen3.8-omni-flash-realtime','qwen3.5-omni-plus','qwen3.5-omni-plus-realtime','qwen3.5-omni-flash'];assert.deepEqual([...QWEN_MODELS.map(m=>m.id)].sort(),expected.sort());
 const base={command:'start',source:'sina',sectors:['合成行业'],limit:1,captureSeconds:300,reviewSeconds:180,batchDirectory:dir};
 for(const m of QWEN_MODELS){for(const mode of ['normal','resume','review','capture']){const args=await requestArgs({...base,mode,model:m.id,qwenApiKey:key},dir);assert.equal(options(args).model,m.id);assert(!args.join(' ').includes(key));}
  if(m.supportsReview){assert.equal(assertQwenReviewModel(m.id).id,m.id);assert.equal(resolveVisionEngine(m.id,{apiKey:'deepseek-other',qwenApiKey:key}).requiresCodex,false);}else{assert.throws(()=>resolveVisionEngine(m.id,{qwenApiKey:key}),e=>e.code==='QWEN_MODEL_PURPOSE');await assert.rejects(reviewWithQwen(run,dir,{model:m.id,apiKey:key,fetchImpl:()=>{throw Error('不能发起请求');}}),e=>e.code==='QWEN_MODEL_PURPOSE');}
 }
 assert.throws(()=>resolveVisionEngine(QWEN_DEFAULT_MODEL,{apiKey:key,qwenApiKey:''}),/独立API密钥/);
});

test('六个HTTP视觉型号发送精确名称、原图和原策略；文本流式响应与用量完整处理',async t=>{
 const {dir,run,codes}=await fixture(t);let calls=0;
 for(const m of QWEN_MODELS.filter(m=>m.supportsReview)){
  const result=await reviewWithQwen(run,dir,{model:m.id,apiKey:key,fetchImpl:async(url,init)=>{calls++;assert.equal(url,QWEN_BASE_URL+'/chat/completions');assert.equal(init.redirect,'error');assert.equal(init.headers.Authorization,'Bearer '+key);const body=JSON.parse(init.body);assert.equal(body.model,m.id);assert.equal(body.stream,true);assert.deepEqual(body.modalities,['text']);assert.equal(body.stream_options.include_usage,true);assert.equal(body.messages[0].content.length,3);const submitted=JSON.parse(await fs.readFile(path.join(dir,'视觉复核/主图初审/提交清单.json'),'utf8'));assert(body.messages[0].content[0].text.startsWith(makePrompt(run,{images:submitted.images.map(({bytes,...i})=>i)})));assert(body.messages[0].content.slice(1).every(c=>c.image_url.url==='data:image/png;base64,'+png.toString('base64')));assert(!('tools'in body)&&!('enable_search'in body));if(m.id==='qwen3-omni-flash'){assert.equal(body.enable_thinking,false);assert.equal(body.vl_high_resolution_images,undefined);}else{assert.equal(body.vl_high_resolution_images,true);}if(m.id.includes('omni-plus')||m.id==='qwen3.8-omni-flash')assert.equal(body.response_format.type,'json_object');else assert.equal(body.response_format,undefined);if(m.id==='qwen3.8-omni-flash')assert.equal(body.reasoning_effort,'none');return stream(payload(codes),{model:m.id});}});
  assert.equal(result.stocks[0].reason,'千问合成判定');const manifest=JSON.parse(await fs.readFile(path.join(dir,'视觉复核/主图初审/提交清单.json'),'utf8'));assert.equal(manifest.model,m.id);assert.equal(manifest.images.length,2);assert(manifest.images.every(i=>i.sha256===sha));
 }
 assert.equal(calls,6);for(const file of await allFiles(dir)){const text=await fs.readFile(file);assert(!text.includes(Buffer.from(key)));assert(!text.includes(Buffer.from('不落盘的千问推理')));}assert.equal(JSON.parse(await fs.readFile(path.join(dir,'视觉复核/主图初审/API用量.json'))).usage.total_tokens,250);
});

test('认证/权限/余额/限频错误保留待审，不重试、不读取响应密钥、不自动换型号',async t=>{
 const {dir,run}=await fixture(t);for(const status of [400,401,402,403,404,429,500]){let calls=0;await assert.rejects(reviewWithQwen(run,dir,{apiKey:key,fetchImpl:async()=>{calls++;return new Response(key,{status});}}),e=>e.code==='QWEN_HTTP_'+status&&!e.message.includes(key));assert.equal(calls,1);}assert(run.items.every(i=>i.result.status==='待确认'));for(const file of await allFiles(dir))assert(!(await fs.readFile(file)).includes(Buffer.from(key)));
});

test('拒绝截断、缺用量、工具调用、非JSON、重复/新增代码和不完整schema',async t=>{
 const {dir,run,codes}=await fixture(t);for(const variant of [{done:false},{usage:false},{finish:'length'},{tool:true}])await assert.rejects(reviewWithQwen(run,dir,{apiKey:key,fetchImpl:async()=>stream(payload(codes),variant)}));
 const duplicate=payload(codes);duplicate.stocks=[row(codes[0]),row(codes[0])];const extra=payload(codes);extra.stocks[1].code='999999';const missing=payload(codes);delete missing.stocks[0].ma20;
 for(const value of [duplicate,extra,missing,'```json\n{}\n```'])await assert.rejects(reviewWithQwen(run,dir,{apiKey:key,fetchImpl:async()=>stream(value)}));
});

test('取消/超时中止千问请求，网络错误及模型回复中的密钥不落盘',async t=>{
 const {dir,run,codes}=await fixture(t),controller=new AbortController();controller.abort(Error('合成千问取消'));let calls=0;await assert.rejects(reviewWithQwen(run,dir,{apiKey:key,signal:controller.signal,fetchImpl:()=>calls++}),/合成千问取消/);assert.equal(calls,0);
 const hold=setTimeout(()=>{},300);try{await assert.rejects(reviewWithQwen(run,dir,{apiKey:key,timeoutMs:10,fetchImpl:async(_url,{signal})=>new Promise((resolve,reject)=>{signal.addEventListener('abort',()=>reject(signal.reason),{once:true});if(signal.aborted)reject(signal.reason);})}),/timeout|timed out/i);}finally{clearTimeout(hold);}
 await assert.rejects(reviewWithQwen(run,dir,{apiKey:key,fetchImpl:async()=>{throw Error('bad '+key);}}),e=>!e.message.includes(key));const p=payload(codes);p.notes=key;p.stocks[0].reason=key;const safe=await reviewWithQwen(run,dir,{apiKey:key,fetchImpl:async()=>stream(p)});assert(!JSON.stringify(safe).includes(key));for(const file of await allFiles(dir))assert(!(await fs.readFile(file)).includes(Buffer.from(key)));
});

test('千问沿用顺序淘汰、SHA和逐股模型来源，继续缺项不覆盖完成项',async t=>{
 const {dir,run,codes}=await fixture(t);run.resumeOf={expectedMarketDate:date};run.resumePendingCodes=[codes[1]];Object.assign(run.items[0],{result:{status:'淘汰',reason:'原完成'},reviewEngine:{model:'gpt-6.1-sol',provider:'codex'}});const before=structuredClone(run.items[0]);
 const answer=payload([codes[1]]);answer.stocks[0].shape='fail';await reviewInBatches(run,dir,{model:QWEN_DEFAULT_MODEL,provider:'qwen',review:async()=>answer});assert.deepEqual(run.items[0],before);assert.equal(run.items[1].result.status,'淘汰');assert.equal(run.items[1].review.nearMA20,'not_checked');assert.equal(run.items[1].reviewImageSHA256,sha);assert.equal(run.items[1].reviewEngine.model,QWEN_DEFAULT_MODEL);assert.equal(run.items[1].reviewEngine.provider,'qwen');
});

test('窗口进程只转发所选服务的密钥，千问密钥不进入argv和事件',async t=>{
 const {dir}=await fixture(t),base={command:'start',mode:'normal',source:'sina',sectors:['合成行业'],limit:1,captureSeconds:300,reviewSeconds:180};
 for(const model of [QWEN_DEFAULT_MODEL,'gpt-6.1-sol','deepseek-flash']){const events=[],input=new PassThrough(),p=serveGUI({root:dir,input,emit:e=>events.push(e),interrupt:()=>{},run:async(args,ui)=>{assert.equal(ui.qwenApiKey,model===QWEN_DEFAULT_MODEL?key:undefined);assert.equal(ui.deepseekApiKey,model==='deepseek-flash'?'other-synthetic-secret':undefined);assert(!args.join(' ').includes(key));throw Error('synthetic '+(model===QWEN_DEFAULT_MODEL?key:model==='deepseek-flash'?'other-synthetic-secret':''));}});input.write(JSON.stringify({...base,model,qwenApiKey:key,deepseekApiKey:'other-synthetic-secret'})+'\n');await p;input.destroy();assert(!JSON.stringify(events).includes(key));assert(!JSON.stringify(events).includes('other-synthetic-secret'));}
});

test('专属地址默认值及GUI/CLI选择传到实际HTTP请求，补审不能覆盖所选地址',async t=>{
 const {dir,run,codes}=await fixture(t),alternate='https://ws-synthetic.cn-beijing.maas.aliyuncs.com/compatible-mode/v1';
 assert.equal(QWEN_BASE_URL,'https://ws-t4vinurq7raqfatt.cn-beijing.maas.aliyuncs.com/compatible-mode/v1');
 assert.equal(normalizeQwenBaseURL(),QWEN_BASE_URL);assert.equal(normalizeQwenBaseURL('  '),QWEN_BASE_URL);
 assert.equal(normalizeQwenBaseURL(' '+alternate+'/ '),alternate);
 const base={command:'start',mode:'normal',source:'sina',sectors:['合成行业'],limit:1,captureSeconds:300,reviewSeconds:180,model:QWEN_DEFAULT_MODEL,qwenApiKey:key,batchDirectory:dir};
 await fs.writeFile(path.join(dir,'run.json'),JSON.stringify(run));
 for(const mode of ['normal','resume','review','check']){
  const args=await requestArgs({...base,mode,qwenBaseUrl:alternate+'/'},dir),cfg=options(args);assert.equal(cfg.qwenBaseUrl,alternate);
  const engine=resolveVisionEngine(cfg.model,{qwenApiKey:key,qwenBaseUrl:cfg.qwenBaseUrl});
  await engine.review(run,dir,{baseURL:'https://dashscope.aliyuncs.com/compatible-mode/v1',fetchImpl:async(url)=>{assert.equal(url,alternate+'/chat/completions');return stream(payload(codes));}});
  assert.equal(JSON.parse(await fs.readFile(path.join(dir,'视觉复核/主图初审/提交清单.json'))).baseURL,alternate);
 }
 for(const model of ['gpt-6.1-sol','deepseek-flash'])assert(!(await requestArgs({...base,model,qwenBaseUrl:alternate},dir)).includes('--qwen-base-url'));
 for(const mode of ['members','capture','login','browser'])assert(!(await requestArgs({...base,mode,qwenBaseUrl:'not-an-address'},dir)).includes('--qwen-base-url'));
 const saved=process.env.DASHSCOPE_BASE_URL;try{process.env.DASHSCOPE_BASE_URL=alternate;
  await resolveVisionEngine(QWEN_DEFAULT_MODEL,{qwenApiKey:key}).review(run,dir,{fetchImpl:async url=>{assert.equal(url,alternate+'/chat/completions');return stream(payload(codes));}});
 }finally{if(saved===undefined)delete process.env.DASHSCOPE_BASE_URL;else process.env.DASHSCOPE_BASE_URL=saved;}
});

test('错误地址在采集和HTTP请求前被拒绝，不把千问密钥发往其他主机或原生API',async t=>{
 const {dir,run}=await fixture(t),invalid=[null,123,'http://dashscope.aliyuncs.com/compatible-mode/v1','https://evil.example/compatible-mode/v1','https://ws-test.cn-beijing.maas.aliyuncs.com.evil.example/compatible-mode/v1','https://dashscope.aliyuncs.com/api/v1','https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions','https://dashscope.aliyuncs.com:8443/compatible-mode/v1','https://u:p@dashscope.aliyuncs.com/compatible-mode/v1','https://dashscope.aliyuncs.com/compatible-mode/v1?key=x','https://dashscope.aliyuncs.com/compatible-mode/v1#x','https://dashscope.aliyuncs.com/compatible-mode/ v1'];
 for(const url of invalid){assert.throws(()=>normalizeQwenBaseURL(url),e=>e.code==='QWEN_BASE_URL');assert.throws(()=>resolveVisionEngine(QWEN_DEFAULT_MODEL,{qwenApiKey:key,qwenBaseUrl:url}),e=>e.code==='QWEN_BASE_URL');
  await assert.rejects(reviewWithQwen(run,dir,{apiKey:key,baseURL:url,fetchImpl:()=>{throw Error('错误地址不应请求');}}),e=>e.code==='QWEN_BASE_URL');
  await assert.rejects(requestArgs({command:'start',mode:'normal',source:'sina',model:QWEN_DEFAULT_MODEL,qwenBaseUrl:url},dir),e=>e.code==='QWEN_BASE_URL');
 }
 for(const url of ['https://dashscope.aliyuncs.com/compatible-mode/v1','https://ws-test.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1/'])assert.equal(normalizeQwenBaseURL(url).endsWith('/compatible-mode/v1'),true);
});

test('仅按已确认型号能力启用JSON模式，高清、思考和结构化输出独立配置',()=>{
 for(const id of ['qwen3.5-omni-plus','qwen3.5-omni-plus-2026-03-15','qwen3.8-omni-flash'])assert.equal(qwenOutputSettings(id).response_format.type,'json_object');
 for(const id of ['qwen3.5-omni-flash','qwen3.5-omni-flash-2026-03-15','qwen3-omni-flash'])assert.equal(qwenOutputSettings(id).response_format,undefined);
 assert.equal(qwenOutputSettings('qwen3.8-omni-flash').reasoning_effort,'none');
});

test('兼容整段JSON围栏和外围空白，判定内容不改写，成功原文同样可追溯',async t=>{
 const {dir,run,codes}=await fixture(t),value=payload(codes),schema=schemaForRun(run);
 value.stocks[0].reason='字符串里的 } {、代码标记和转义引号不影响完整JSON解析';
 for(const wrap of [s=>'\ufeff \n'+s+' \n',s=>'```json\n'+s+'\n```',s=>'```JSON\r\n'+s+'\r\n```',s=>'```\n'+s+'\n```']){
  const raw=wrap(JSON.stringify(value));
  const result=await reviewWithQwen(run,dir,{apiKey:key,fetchImpl:async()=>stream(raw)});
  assert.deepEqual(result,value);assert.deepEqual(parseQwenAnswer(raw,schema).payload,value);
  assert.equal(await fs.readFile(path.join(dir,'视觉复核/主图初审/模型回复原文.txt'),'utf8'),raw);
  const receipt=JSON.parse(await fs.readFile(path.join(dir,'视觉复核/主图初审/回复接收.json')));assert.equal(receipt.complete,true);
  const parsed=JSON.parse(await fs.readFile(path.join(dir,'视觉复核/主图初审/回复解析.json')));assert.equal(parsed.status,'accepted');
  assert.equal(parsed.format,raw.trim().startsWith('```')?'markdown-json-object':'json-object');
 }
});

test('JSON后有文字/第二份对象/矛盾判定/截断时明确拒绝并保留脱敏原文和用量，绝不自动重试',async t=>{
 const {dir,run,codes}=await fixture(t),json=JSON.stringify(payload(codes)),bad=payload(codes);bad.stocks[0].shape='fail';
 for(const answer of [json+'\n说明：全部符合',json+'\n'+json,json+'\n'+JSON.stringify(bad),'说明：'+json,json.slice(0,-2),'```json\n'+json+'\n```\n尾部内容','```json\n'+json+'\n```\n```json\n'+json+'\n```',json+key]){
  let calls=0;await assert.rejects(reviewWithQwen(run,dir,{apiKey:key,fetchImpl:async()=>{calls++;return stream(answer);}}),e=>e.code==='QWEN_RESPONSE_JSON'&&e.message.includes('保留待审核')&&!e.message.includes(key));assert.equal(calls,1);
  assert.equal(await fs.readFile(path.join(dir,'视觉复核/主图初审/模型回复原文.txt'),'utf8'),answer.replaceAll(key,'[已隐藏密钥]'));
  assert.equal(JSON.parse(await fs.readFile(path.join(dir,'视觉复核/主图初审/回复解析.json'))).status,'rejected');
  assert.equal(JSON.parse(await fs.readFile(path.join(dir,'视觉复核/主图初审/API用量.json'))).usage.total_tokens,250);
 }
 assert(run.items.every(i=>i.result.status==='待确认'));for(const file of await allFiles(dir))assert(!(await fs.readFile(file)).includes(Buffer.from(key)));
});

test('JSON能解析但审核字段缺失/新增/数量错误仍拒绝，不补字段或改成符合',async t=>{
 const {dir,run,codes}=await fixture(t);
 for(const bad of [()=>{const p=payload(codes);delete p.stocks[0].ma20;return p;},()=>({...payload(codes),extra:'不能采纳'}),()=>payload([codes[0]]),()=>[payload(codes)],()=>null]){
  await assert.rejects(reviewWithQwen(run,dir,{apiKey:key,fetchImpl:async()=>stream(JSON.stringify(bad()))}),e=>['QWEN_RESPONSE_JSON','QWEN_RESPONSE_SCHEMA'].includes(e.code));
  const failure=JSON.parse(await fs.readFile(path.join(dir,'视觉复核/主图初审/失败原因.json')));assert.equal(failure.rawFile,'模型回复原文.txt');
 }
});

test('SSE截断或非stop结束时保留已收到的答案，接收记录不冒充完整结果，推理不保存',async t=>{
 const {dir,run,codes}=await fixture(t),p=payload(codes);p.notes=key;
 for(const options of [{done:false},{finish:'length'},{usage:false}]){
  await assert.rejects(reviewWithQwen(run,dir,{apiKey:key,fetchImpl:async()=>stream(p,options)}),e=>e.code==='QWEN_RESPONSE_STREAM');
  const record=JSON.parse(await fs.readFile(path.join(dir,'视觉复核/主图初审/回复接收.json')));assert.equal(record.complete,false);
  const raw=await fs.readFile(path.join(dir,'视觉复核/主图初审/模型回复原文.txt'),'utf8');assert.equal(raw,JSON.stringify(p).replaceAll(key,'[已隐藏密钥]'));
 }
 for(const file of await allFiles(dir)){const value=await fs.readFile(file);assert(!value.includes(Buffer.from(key)));assert(!value.includes(Buffer.from('不落盘的千问推理')));}
});