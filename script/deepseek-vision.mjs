import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {makePrompt,reviewInput,schemaForRun,reviewDirectory,PROMPT_VERSION} from './vision.mjs';
import {prepareReviewEvidence} from './review-evidence.mjs';
import {MAIN_EVIDENCE_VERSION} from './review-settings.mjs';

export const redactSecret=(value,key)=>key?String(value).replaceAll(key,'[已隐藏密钥]'):String(value);
export function validateReviewJSON(value,schema,where='视觉结果'){
 const type=value===null?'null':Array.isArray(value)?'array':typeof value;
 if(!(Array.isArray(schema.type)?schema.type:[schema.type]).includes(type))throw Error(where+'类型不符');
 if(schema.enum&&!schema.enum.includes(value))throw Error(where+'枚举不符');
 if(type==='object'){
  for(const key of schema.required||[])if(!Object.hasOwn(value,key))throw Error(where+'缺少'+key);
  for(const key of Object.keys(value)){if(!Object.hasOwn(schema.properties||{},key)){if(schema.additionalProperties===false)throw Error(where+'包含额外字段');}else validateReviewJSON(value[key],schema.properties[key],where+'.'+key);}
 }
 if(type==='array'){if(value.length<(schema.minItems||0)||value.length>(schema.maxItems??Infinity))throw Error(where+'数量不符');for(const item of value)validateReviewJSON(item,schema.items,where+'[]');}
 if(type==='number'&&!Number.isFinite(value))throw Error(where+'数值无效');
}

export async function readDeepSeekStream(body,signal,{providerName='DeepSeek',onCapture}={}){
 let pending='',answer='',finishReason=null,done=false,id,model,usage;const decoder=new TextDecoder();
 function event(block){
  const value=block.replaceAll('\r\n','\n').split('\n').filter(l=>l.startsWith('data:')).map(l=>l.slice(5).trim()).join('\n');
  if(!value)return;if(value==='[DONE]'){done=true;return;}if(done)throw Error('结束标记之后仍有模型内容');
  const part=JSON.parse(value);if(part.error)throw Error(providerName+'流式接口返回错误');id??=part.id;model??=part.model;if(part.usage)usage=part.usage;
  for(const c of part.choices||[]){if(c.index!==undefined&&c.index!==0)throw Error('模型返回多个候选');if(c.delta?.tool_calls?.length)throw Error('不接受模型工具调用');answer+=c.delta?.content||'';if(answer.length>1000000)throw Error('模型输出过长');if(c.finish_reason)finishReason=c.finish_reason;}
 }
 try{
 for await(const bytes of body){signal?.throwIfAborted();pending+=decoder.decode(bytes,{stream:true});let match;while((match=/\r?\n\r?\n/.exec(pending))){event(pending.slice(0,match.index));pending=pending.slice(match.index+match[0].length);}if(pending.length>1000000)throw Error('模型流式片段过长');}
 pending+=decoder.decode();if(pending.trim())event(pending);signal?.throwIfAborted();
 if(!done||finishReason!=='stop'||!usage)throw Error(providerName+'响应未完整结束，不采纳本批判定');
 return{id,model,usage,finishReason,answer};
 }finally{if(onCapture)await onCapture({id,model,usage,finishReason,answer,done,complete:done&&finishReason==='stop'&&!!usage});}
}

export async function reviewWithDeepSeek(run,directory,{apiKey,signal,batchIndex,reviewPhase,fetchImpl=fetch,timeoutMs=120000}={}){
 if(typeof apiKey!=='string'||!apiKey.trim()||/[\r\n]/.test(apiKey))throw Error('请在窗口填写DeepSeek密钥，或配置DEEPSEEK_API_KEY；密钥不会保存到任务记录');
 const combined=signal?AbortSignal.any([signal,AbortSignal.timeout(timeoutMs)]):AbortSignal.timeout(timeoutMs);combined.throwIfAborted();
 const input=reviewInput(run),schema=schemaForRun(run);
 const reviewDir=reviewDirectory(directory,{batchIndex,reviewPhase:reviewPhase||(run.singleChartOnly?'主图初审':undefined)});await fs.mkdir(reviewDir,{recursive:true});
 const submission=await prepareReviewEvidence(input,directory,reviewDir,{compact:run.compactEvidence!==false,cropMain:!!run.cropMain,signal:combined});
 const prompt=makePrompt(run,{images:submission.manifest.images})+'\n最终只输出逐字段符合以下JSON Schema的JSON对象：\n'+JSON.stringify(schema);
 const content=[{type:'text',text:prompt}],files=[];let total=0;
 for(const image of submission.images){
  combined.throwIfAborted();const bytes=await fs.readFile(image.path);total+=bytes.length;
  if(bytes.subarray(0,8).toString('hex')!=='89504e470d0a1a0a'||bytes.length>32*1024*1024||total>64*1024*1024)throw Error('DeepSeek原始PNG图证无效或超过接口限制');
  const sha=createHash('sha256').update(bytes).digest('hex'),item=input.targets.find(i=>i.chartFile===image.file),evidence=input.targets.flatMap(i=>[...(i.periodFiles||[]),...(i.parameterFiles||[])]).find(i=>i.file===image.file);
  if((item?.imageSHA256&&item.imageSHA256!==sha)||(evidence?.imageSHA256&&evidence.imageSHA256!==sha))throw Error('提交原图SHA256不符：'+image.file);
  const {path:localPath,...manifestImage}=image;files.push({...manifestImage,sha256:sha,bytes:bytes.length});content.push({type:'image_url',image_url:{url:'data:image/png;base64,'+bytes.toString('base64'),detail:'original'}});
 }
 const body=JSON.stringify({model:'deepseek-flash',messages:[{role:'user',content}],response_format:{type:'json_object'},max_tokens:16384,stream:true,stream_options:{include_usage:true}});
 if(Buffer.byteLength(body)>48*1024*1024||files.length>600)throw Error('DeepSeek本批原图超过接口限制，请减小复核批次');
 const safeWrite=(name,value)=>fs.writeFile(path.join(reviewDir,name),redactSecret(typeof value==='string'?value:JSON.stringify(value,null,2),apiKey));
 await safeWrite('schema.json',schema);await safeWrite('prompt.txt',prompt);await safeWrite('提交清单.json',{...submission.manifest,version:run.singleChartOnly?MAIN_EVIDENCE_VERSION:submission.manifest.version,evidenceMode:run.evidenceMode,reviewPhase:reviewPhase||(run.singleChartOnly?'主图初审':'多图复核'),provider:'deepseek',model:'deepseek-flash',images:files,promptVersion:PROMPT_VERSION,promptCharacters:prompt.length});
 try{
  const response=await fetchImpl('https://api.deepseek.com/chat/completions',{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer '+apiKey},body,signal:combined,redirect:'error'});
  if(!response.ok){const hints={401:'密钥无效或已失效',402:'API余额不足',429:'请求频率或额度受限'};throw Object.assign(Error('DeepSeek HTTP '+response.status+'：'+(hints[response.status]||'服务请求失败')+'，本批保留待审核'),{code:'DEEPSEEK_HTTP_'+response.status});}
  const data=await readDeepSeekStream(response.body,combined);await safeWrite('API用量.json',{provider:'deepseek',modelRequested:'deepseek-flash',modelReturned:data.model,id:data.id,usage:data.usage,finishReason:data.finishReason});
  const payload=JSON.parse(redactSecret(data.answer,apiKey));validateReviewJSON(payload,schema);combined.throwIfAborted();
  // 校验完整股票集合后才落盘最终判定；重复代码不能冒充完整结果。
  if(new Set(payload.stocks.map(i=>i.code)).size!==input.codes.length)throw Error('视觉结果股票代码重复，本批不采纳');
  await safeWrite('模型原始判定.json',payload);return payload;
 }catch(error){
  const reason=combined.aborted?combined.reason:error,safe=Object.assign(Error(redactSecret(reason?.message||'DeepSeek连接失败',apiKey)),{code:reason?.code||'DEEPSEEK_REVIEW_FAILED'});
  await safeWrite('失败原因.json',{error:safe.message,errorCode:safe.code}).catch(()=>{});throw safe;
 }
}
