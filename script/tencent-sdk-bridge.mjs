// 固定版本 SDK 的只读适配：仅允许板块 ClosePrice，不向父进程输出鉴权参数或原始日志。
const allowed=new Set(JSON.parse(process.env.SCREENING_BOARD_CODES||'[]'));
const originalFetch=globalThis.fetch,write=process.stdout.write.bind(process.stdout);
console.log=()=>{};console.error=()=>{};console.warn=()=>{};
globalThis.fetch=async(input,init)=>{
 const u=new URL(typeof input==='string'?input:input.url);
 if(u.origin!=='https://proxy.finance.qq.com'||u.pathname!=='/cgi/cgi-bin/openai/openclaw/proxy')throw Error('SDK请求超出板块历史范围');
 const body=JSON.parse(init?.body||'{}');
 if(body.route!=='stock_quote_history'||!allowed.has(body.params?.code)||!/^pt(?:01\d{6}|02[A-Z0-9]{6})$/.test(body.params.code))throw Error('SDK仅允许本批板块日线');
 body.params.fields='ClosePrice';
 const response=await originalFetch(input,{...init,body:JSON.stringify(body),signal:AbortSignal.timeout(10000)});
 if(!response.ok)throw Error('SDK历史HTTP失败');
 const payload=await response.clone().json();
 if(payload.code!==0||!allowed.has(payload.data?.code)||!Array.isArray(payload.data?.series))throw Error('SDK历史响应结构错误');
 write('BOARD_DAILY '+JSON.stringify({code:payload.data.code,name:payload.data.name,bars:payload.data.series.map(r=>({date:r.date,close:r.data?.ClosePrice}))})+'\n');
 return response;
};
