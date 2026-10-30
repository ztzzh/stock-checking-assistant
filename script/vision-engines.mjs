import {reviewWithCodex} from './vision.mjs';
import {reviewWithDeepSeek} from './deepseek-vision.mjs';
import {reviewWithQwen} from './qwen-vision.mjs';
import {QWEN_MODELS,assertQwenReviewModel,normalizeQwenBaseURL} from './qwen-models.mjs';
export const VISION_MODELS=Object.freeze([
 {id:'gpt-6.1-sol',name:'GPT-6.1 Sol',provider:'codex'},
 {id:'gpt-6.1-terra',name:'GPT-6.1 Terra',provider:'codex'},
 {id:'gpt-6-luna',name:'GPT-6 Luna',provider:'codex'},
 {id:'deepseek-flash',name:'DeepSeek Flash',provider:'deepseek'},
 ...QWEN_MODELS
]);
export function visionModel(id='gpt-6.1-sol'){
 const spec=VISION_MODELS.find(m=>m.id===id);if(!spec)throw Error('不支持的视觉模型，请选择Sol、Terra、Luna、DeepSeek或千问列表中的型号');return spec;
}
export function resolveVisionEngine(id,{apiKey=process.env.DEEPSEEK_API_KEY,qwenApiKey=process.env.DASHSCOPE_API_KEY,qwenBaseUrl=process.env.DASHSCOPE_BASE_URL}={}){
 const spec=visionModel(id);
 if(spec.provider==='deepseek'&&(!apiKey?.trim()||/[\r\n]/.test(apiKey)))throw Error('请选择DeepSeek后填写API密钥；密钥只在本次窗口使用，不保存');
 if(spec.provider==='qwen'){assertQwenReviewModel(id);qwenBaseUrl=normalizeQwenBaseURL(qwenBaseUrl);if(typeof qwenApiKey!=='string'||!qwenApiKey.trim()||/[\r\n\0]/.test(qwenApiKey))throw Error('请选择千问后填写独立API密钥；密钥只在本次窗口使用，不保存');}
 return{...spec,requiresCodex:spec.provider==='codex',review:spec.provider==='codex'?reviewWithCodex:spec.provider==='qwen'?(run,dir,options)=>reviewWithQwen(run,dir,{...options,model:id,apiKey:qwenApiKey,baseURL:qwenBaseUrl}):(run,dir,options)=>reviewWithDeepSeek(run,dir,{...options,apiKey})};
}
