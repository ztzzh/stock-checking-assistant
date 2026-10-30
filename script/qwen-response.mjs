import {validateReviewJSON} from './deepseek-vision.mjs';

// 按官方结构化输出能力单独配置，不能用是否支持高清图像推断JSON模式。
// 依据：https://help.aliyun.com/zh/model-studio/qwen-structured-output（2026-10-28）
export function qwenOutputSettings(model){
 const jsonObject=model==='qwen3.8-omni-flash'||/^qwen3\.5-omni-plus(?:-2026-03-15)?$/.test(model);
 return {...(jsonObject?{response_format:{type:'json_object'}}:{}),...(model==='qwen3.8-omni-flash'?{reasoning_effort:'none'}:{})};
}

// 仅兼容包住整段JSON的代码围栏；不截取首个大括号、不忽略说明或第二段JSON。
// 字段、股票数量/代码、枚举与类型仍须通过原有严格schema。
export function parseQwenAnswer(answer,schema){
 let text=typeof answer==='string'?answer.trim():'',format='json-object';
 const invalid=detail=>Object.assign(Error('千问回复不是单个完整JSON对象：'+detail+'；本批保留待审核，请查看模型回复原文.txt'),{code:'QWEN_RESPONSE_JSON'});
 if(!text)throw invalid('回复为空');
 if(text.length>1000000)throw invalid('回复超过长度上限');
 if(text.startsWith('```')){
  const fence=/^```(?:json)?[ \t]*\r?\n([\s\S]*)\r?\n```[ \t]*$/i.exec(text);
  if(!fence)throw invalid('JSON代码围栏不完整或前后还有其他内容');
  text=fence[1].trim();format='markdown-json-object';
 }
 let payload;try{payload=JSON.parse(text);}catch{throw invalid('含额外文字、多段JSON或JSON语法不完整');}
 if(!payload||typeof payload!=='object'||Array.isArray(payload))throw invalid('顶层必须为对象');
 try{validateReviewJSON(payload,schema);}catch(error){throw Object.assign(Error('千问回复字段不符合审核约定：'+error.message+'；本批保留待审核，请查看模型回复原文.txt'),{code:'QWEN_RESPONSE_SCHEMA'});}
 return {payload,format};
}
