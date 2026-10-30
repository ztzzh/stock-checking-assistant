// 与 fullPage 截图成对使用：读取整页实际渲染文字，排除隐藏和容器裁切内容。
// 不读取页面变量、网络响应、canvas像素或未渲染的表格数据。
export function readFullPage(){
  const box=e=>{const r=e.getBoundingClientRect();return{x:r.x,y:r.y,width:r.width,height:r.height};};
  function visible(e){
    if(!e?.isConnected)return false;const r=e.getBoundingClientRect();
    if(r.width<1||r.height<1)return false;
    for(let p=e;p;p=p.parentElement){
      const s=getComputedStyle(p),q=p.getBoundingClientRect();
      if(s.display==='none'||s.visibility!=='visible'||+s.opacity===0)return false;
      if(p!==e&&p!==document.body&&p!==document.documentElement){
        if(/hidden|clip|auto|scroll/.test(s.overflowX)&&(r.left<q.left||r.right>q.right))return false;
        if(/hidden|clip|auto|scroll/.test(s.overflowY)&&(r.top<q.top||r.bottom>q.bottom))return false;
      }
    }
    if(r.left>=0&&r.top>=0&&r.right<=innerWidth&&r.bottom<=innerHeight){
      const top=document.elementFromPoint(r.x+r.width/2,r.y+r.height/2);
      if(!top||(!e.contains(top)&&!top.contains(e)))return false;
    }
    return true;
  }
  function text(e){
    if(!visible(e))return '';
    for(const child of e.querySelectorAll('*')){
      let hidden=false;for(let p=child;p&&p!==e;p=p.parentElement){const s=getComputedStyle(p);if(s.display==='none'||s.visibility!=='visible'){hidden=true;break;}}
      if(!hidden&&!visible(child)&&child.innerText?.trim())return '';
    }
    return(e.innerText||'').replace(/\s+/g,' ').trim();
  }
  const tables=[...document.querySelectorAll('table')].filter(visible).map(t=>{
    const hs=[...t.querySelectorAll('thead tr:last-child th,thead tr:last-child td')],h=hs.length?hs:[...(t.rows[0]?.cells||[])];
    return{columns:h.map(text),rows:[...t.rows].filter(r=>r!==h[0]?.parentElement).map(r=>({cells:[...r.cells].map(text),links:[...r.cells].map(c=>[...c.querySelectorAll('a[href]')].filter(visible).map(a=>({text:text(a),url:a.href}))),rect:box(r)})).filter(r=>r.cells.some(Boolean))};
  }).filter(t=>t.rows.length);
  const headings=[...document.querySelectorAll('h1,h2,h3,[role="alert"]')].map(text).filter(Boolean);
  return{url:location.href,title:document.title,at:new Date().toISOString(),observationScope:'fullPageScreenshot',viewport:{width:innerWidth,height:innerHeight,documentWidth:document.documentElement.scrollWidth,documentHeight:document.documentElement.scrollHeight,scrollX,scrollY},tables,controls:[],headings,blocked:headings.some(t=>/访问频繁|验证码|安全验证|Access Denied|Too Many Requests|服务器错误/.test(t))};
}
