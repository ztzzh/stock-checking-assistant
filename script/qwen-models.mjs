// 用户提供的三张控制台截图中的全部精确型号；用途与HTTP截图审核能力分开。
export const QWEN_BASE_URL='https://ws-t4vinurq7raqfatt.cn-beijing.maas.aliyuncs.com/compatible-mode/v1';
export function normalizeQwenBaseURL(value=QWEN_BASE_URL){
 const invalid=()=>Object.assign(Error('千问Base URL无效，请复制控制台中间的OpenAI兼容地址（https://…/compatible-mode/v1）'),{code:'QWEN_BASE_URL'});
 if(typeof value!=='string')throw invalid();
 const raw=value.trim()||QWEN_BASE_URL;let url;try{url=new URL(raw);}catch{throw invalid();}
 const shared=['dashscope.aliyuncs.com','dashscope-intl.aliyuncs.com','dashscope-us.aliyuncs.com','cn-hongkong.dashscope.aliyuncs.com'];
 const dedicated=/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.(?:cn-beijing|ap-southeast-1|ap-northeast-1|eu-central-1|us-east-1|cn-hongkong)\.maas\.aliyuncs\.com$/;
 if(url.protocol!=='https:'||url.username||url.password||url.port||url.search||url.hash||/[\s\\?#]/.test(raw)||!raw.toLowerCase().startsWith('https://')||!shared.includes(url.hostname)&&!dedicated.test(url.hostname)||!/^\/compatible-mode\/v1\/?$/.test(url.pathname))throw invalid();
 return url.origin+'/compatible-mode/v1';
}
export const QWEN_DEFAULT_MODEL='qwen3.5-omni-flash';
const ids=[
 'qwen3.5-omni-flash','qwen3.5-omni-plus',
 'qwen3.5-omni-flash-2026-03-15','qwen3.5-omni-plus-2026-03-15',
 'qwen3-omni-flash','qwen3.8-omni-flash',
 'qwen3.5-omni-flash-realtime','qwen3.5-omni-plus-realtime',
 'qwen3.5-omni-plus-realtime-2026-03-15','qwen3.5-omni-flash-realtime-2026-03-15',
 'qwen3-omni-flash-realtime-2025-09-15','qwen3.8-omni-flash-realtime','qwen-mt-uni'
];
export const QWEN_MODELS=Object.freeze(ids.map(id=>Object.freeze({id,name:'Qwen · '+id,provider:'qwen',purpose:id.includes('realtime')?'realtime':id==='qwen-mt-uni'?'translation':'image',supportsReview:!id.includes('realtime')&&id!=='qwen-mt-uni'})));
export function qwenModel(id=QWEN_DEFAULT_MODEL){const model=QWEN_MODELS.find(m=>m.id===id);if(!model)throw Error('不支持的千问型号，请从千问下拉列表选择');return model;}
export function assertQwenReviewModel(id){const model=qwenModel(id);if(!model.supportsReview)throw Object.assign(Error(model.purpose==='realtime'?'该千问型号使用实时音视频接口，当前HTTP截图审核未接入；请在下拉列表选择不带realtime的Omni型号。':'qwen-mt-uni是翻译专用型号，当前不用于股票图形审核；请在下拉列表选择Omni型号。'),{code:'QWEN_MODEL_PURPOSE'});return model;}
