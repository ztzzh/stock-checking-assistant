import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {makePrompt,reviewInput,schemaForRun,reviewDirectory,PROMPT_VERSION} from './vision.mjs';
import {prepareReviewEvidence} from './review-evidence.mjs';
import {MAIN_EVIDENCE_VERSION} from './review-settings.mjs';
import {redactSecret,readDeepSeekStream} from './deepseek-vision.mjs';
import {parseQwenAnswer,qwenOutputSettings} from './qwen-response.mjs';
import {QWEN_BASE_URL,QWEN_DEFAULT_MODEL,assertQwenReviewModel,normalizeQwenBaseURL} from './qwen-models.mjs';

export async function reviewWithQwen(run,directory,{apiKey,baseURL=QWEN_BASE_URL,model=run.visionModel||QWEN_DEFAULT_MODEL,signal,batchIndex,reviewPhase,fetchImpl=fetch,timeoutMs=120000}={}){
 assertQwenReviewModel(model);
 baseURL=normalizeQwenBaseURL(baseURL);
 if(typeof apiKey!=='string'||!apiKey.trim()||/[\r\n\0]/.test(apiKey))throw Error('请填写千问API密钥，或配置DASHSCOPE_API_KEY；密钥仅本次窗口使用，不保存');
 apiKey=apiKey.trim();const combined=signal?AbortSignal.any([signal,AbortSignal.timeout(timeoutMs)]):AbortSignal.timeout(timeoutMs);combined.throwIfAborted();
 const input=reviewInput(run),schema=schemaForRun(run),phase=reviewPhase||(run.singleChartOnly?'主图初审':undefined);
 const reviewDir=reviewDirectory(directory,{batchIndex,reviewPhase:phase});await fs.mkdir(reviewDir,{recursive:true});
 let responseReceived=false;
 const safeWrite=(file,value)=>fs.writeFile(path.join(reviewDir,file),redactSecret(typeof value==='string'?value:JSON.stringify(value,null,2),apiKey));
 try{
  const submission=await prepareReviewEvidence(input,directory,reviewDir,{compact:run.compactEvidence!==false,cropMain:!!run.cropMain,signal:combined});
  const prompt=makePrompt(run,{images:submission.manifest.images})+'\n输出约定：整条回复只能有一个JSON对象，包含本批全部股票的stocks数组。不要按股票输出多个JSON对象；不要重复JSON、不要Markdown代码块、不要在JSON前后附说明。无法辨认时按schema填写unclear/null，不得省略字段。JSON Schema：\n'+JSON.stringify(schema);
  const content=[{type:'text',text:prompt}],files=[];let total=0;
  for(const image of submission.images){
   combined.throwIfAborted();const bytes=await fs.readFile(image.path);total+=bytes.length;
   if(bytes.subarray(0,8).toString('hex')!=='89504e470d0a1a0a'||bytes.length>20*1024*1024||total>64*1024*1024)throw Error('千问PNG图证无效或超过接口限制');
   const sha=createHash('sha256').update(bytes).digest('hex');if(sha!==image.sha256)throw Error('提交图证SHA256不符：'+image.file);
   const {path:localPath,...manifestImage}=image;files.push({...manifestImage,sha256:sha,bytes:bytes.length});content.push({type:'image_url',image_url:{url:'data:image/png;base64,'+bytes.toString('base64')}});
  }
  const outputSettings=qwenOutputSettings(model),highResolution=!model.startsWith('qwen3-omni-');
  const body={model,messages:[{role:'user',content}],modalities:['text'],max_tokens:16384,stream:true,stream_options:{include_usage:true},...(highResolution?{vl_high_resolution_images:true}:{enable_thinking:false}),...outputSettings};
  const encoded=JSON.stringify(body);if(Buffer.byteLength(encoded)>48*1024*1024||files.length>600)throw Error('千问本批图证超过接口限制，请减小复核批次');
  await safeWrite('schema.json',schema);await safeWrite('prompt.txt',prompt);await safeWrite('提交清单.json',{...submission.manifest,version:run.singleChartOnly?MAIN_EVIDENCE_VERSION:submission.manifest.version,evidenceMode:run.evidenceMode,reviewPhase:phase||'多图复核',provider:'qwen',model,baseURL,highResolutionRequested:highResolution,outputFormatRequested:outputSettings.response_format?.type||'prompt-json',images:files,promptVersion:PROMPT_VERSION,promptCharacters:prompt.length});
  const response=await fetchImpl(baseURL+'/chat/completions',{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer '+apiKey},body:encoded,signal:combined,redirect:'error'});
  if(!response.ok){const hints={400:'请求参数或型号能力不匹配',401:'密钥无效或已失效',402:'API余额不足',403:'地域、模型权限或账户余额受限',404:'型号不存在或未开通',429:'请求频率或额度受限'};throw Object.assign(Error('千问 HTTP '+response.status+'：'+(hints[response.status]||'服务请求失败')+'；本批保留待审核'),{code:'QWEN_HTTP_'+response.status});}
  let data;
  try{data=await readDeepSeekStream(response.body,combined,{providerName:'千问',onCapture:async({answer,...receipt})=>{
   await safeWrite('模型回复原文.txt',answer);responseReceived=true;
   await safeWrite('回复接收.json',{provider:'qwen',modelRequested:model,...receipt,answerCharacters:answer.length});
  }});}catch(error){combined.throwIfAborted();throw Object.assign(Error('千问流式回复未完整接收：'+error.message+'；本批保留待审核，请查看回复接收记录'),{code:'QWEN_RESPONSE_STREAM'});}
  await safeWrite('API用量.json',{provider:'qwen',modelRequested:model,modelReturned:data.model,id:data.id,usage:data.usage,finishReason:data.finishReason});
  const {payload,format}=parseQwenAnswer(redactSecret(data.answer,apiKey),schema);combined.throwIfAborted();
  if(new Set(payload.stocks.map(i=>i.code)).size!==input.codes.length)throw Error('千问返回股票代码重复，本批不采纳');
  await safeWrite('模型原始判定.json',payload);
  await safeWrite('回复解析.json',{status:'accepted',format,stockCount:payload.stocks.length,rawFile:'模型回复原文.txt'});return payload;
 }catch(error){
  const reason=combined.aborted?combined.reason:error,safe=Object.assign(Error(redactSecret(reason?.message||'千问连接失败',apiKey)),{code:reason?.code||'QWEN_REVIEW_FAILED'});
  if(responseReceived)await safeWrite('回复解析.json',{status:'rejected',error:safe.message,errorCode:safe.code,rawFile:'模型回复原文.txt'}).catch(()=>{});
  await safeWrite('失败原因.json',{error:safe.message,errorCode:safe.code,...(responseReceived?{rawFile:'模型回复原文.txt'}:{})}).catch(()=>{});throw safe;
 }
}
