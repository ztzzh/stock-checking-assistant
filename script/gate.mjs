// 只读取实际可见的页面/嵌入框；不点击、求解或绕过验证。
const verification=/拖动[\s\S]{0,30}滑块|滑块[\s\S]{0,30}(拼图|验证)|完成\s*拼图|安全验证|人机验证|验证码|Access Denied|Too Many Requests|访问过于频繁|访问频繁/i;
const login=/请输入手机号|输入短信验证码|一键登录[\s\S]{0,15}解锁/;
function classify(text){if(login.test(text))return'login';if(verification.test(text))return'verification';return'';}
export async function detectGate(page){
  for(const frame of page.frames()){
    if(frame!==page.mainFrame()){
      let element;try{element=await frame.frameElement();if(!await element.isVisible())continue;}catch{continue;}
      const attributes=await element.evaluate(e=>({title:e.title||'',label:e.getAttribute('aria-label')||'',src:e.getAttribute('src')||''}));
      if(classify(attributes.title+' '+attributes.label))return{kind:'verification',location:'visible-iframe'};
      if(/(?:captcha|geetest|yidun|turing|[/.]verify(?:[./?]))/i.test(attributes.src))return{kind:'verification',location:'visible-iframe'};
    }
    let text='';try{text=await frame.locator('body').innerText({timeout:1000});}catch{continue;}
    const kind=classify(text);if(kind)return{kind,location:frame===page.mainFrame()?'page':'visible-iframe'};
  }
  const markers=page.locator('.geetest_panel,.geetest_holder,.yidun_popup,[id*="captcha" i],[class*="captcha" i],iframe[title*="验证"]');
  for(let n=0;n<await markers.count();n++)if(await markers.nth(n).isVisible())return{kind:'verification',location:'visible-control'};
  return null;
}
export function manualGateError(gate){
  const error=Error(`行情页面要求人工${gate.kind==='login'?'登录':'验证'}（${gate.location}）。请在有窗口的终端运行脚本，并在当前浏览器手动完成；脚本不自动处理验证`);
  error.code='MANUAL_VERIFICATION_REQUIRED';return error;
}
