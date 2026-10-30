// 只能访问渲染后的DOM。禁止访问页面JS变量、行情响应、canvas数据或隐藏行。
globalThis.ScreenVision = (() => {
  const rect = el => { const r=el.getBoundingClientRect(); return {x:r.x,y:r.y,width:r.width,height:r.height}; };
  function visible(el, full=false) {
    if (!el || !el.isConnected) return false;
    const r=el.getBoundingClientRect(), s=getComputedStyle(el);
    if (s.display==='none' || s.visibility!=='visible' || Number(s.opacity)===0 || r.width<1 || r.height<1) return false;
    if (full ? r.top<0||r.left<0||r.bottom>innerHeight||r.right>innerWidth : r.bottom<=0||r.right<=0||r.top>=innerHeight||r.left>=innerWidth) return false;
    for (let p=el.parentElement;p;p=p.parentElement) {
      const ps=getComputedStyle(p), pr=p.getBoundingClientRect();
      if (ps.display==='none'||ps.visibility!=='visible'||Number(ps.opacity)===0) return false;
      if (/(hidden|clip|scroll|auto)/.test(ps.overflowX) && (full?(r.left<pr.left||r.right>pr.right):(r.right<=pr.left||r.left>=pr.right))) return false;
      if (/(hidden|clip|scroll|auto)/.test(ps.overflowY) && (full?(r.top<pr.top||r.bottom>pr.bottom):(r.bottom<=pr.top||r.top>=pr.bottom))) return false;
    }
    if(!full)return true;
    const cx=Math.max(0,Math.min(innerWidth-1,r.x+r.width/2)), cy=Math.max(0,Math.min(innerHeight-1,r.y+r.height/2));
    const top=document.elementFromPoint(cx,cy);
    return !!top && (el.contains(top)||top.contains(el));
  }
  function text(el) {
    if (!visible(el,true)) return '';
    // innerText排除display:none；同时逐个可见文本节点，避免折叠/遮挡内容混入。
    const walk=document.createTreeWalker(el,NodeFilter.SHOW_TEXT), out=[];
    while (walk.nextNode()) {
      const n=walk.currentNode;
      if (n.textContent.trim() && visible(n.parentElement,true)) out.push(n.textContent.trim());
    }
    return out.join(' ').replace(/\s+/g,' ').trim();
  }
  function tables() {
    return [...document.querySelectorAll('table')].filter(t=>visible(t)).map((table,index)=>{
      const hs=[...table.querySelectorAll('thead tr:last-child th,thead tr:last-child td')];
      const header=hs.length?hs:[...(table.rows[0]?.cells||[])];
      const columns=header.map(h=>text(h));
      const rows=[...table.rows].filter(r=>r!==header[0]?.parentElement).map(r=>{
        const cells=[...r.cells];
        return {cells:cells.map(c=>text(c)), links:cells.map(c=>[...c.querySelectorAll('a[href]')].filter(a=>visible(a,true)).map(a=>({text:text(a),url:a.href}))),rect:rect(r)};
      }).filter(r=>r.cells.some(Boolean));
      return {index,columns,rows,header:header.map(h=>({text:text(h),sort:h.getAttribute('aria-sort')||'',rect:rect(h)}))};
    });
  }
  function snapshot() {
    const body=[...document.querySelectorAll('h1,h2,h3,time,[role="alert"]')].map(text).filter(Boolean);
    // 错误检测只用实际可见文字，读取范围受限，绝不输出整页源代码。
    const visibleText=(document.body?.innerText||'').slice(0,80000);
    const blocked=/(访问过于频繁|访问频繁|安全验证|验证码|访问被拒绝|Access Denied|Too Many Requests|服务器错误|502 Bad Gateway|503 Service)/i.test(visibleText);
    return {url:location.href,title:document.title,at:new Date().toISOString(),viewport:{width:innerWidth,height:innerHeight,dpr:devicePixelRatio},headings:body,tables:tables(),blocked};
  }
  function scrollTable() {
    const candidates=[...document.querySelectorAll('table')].filter(t=>/涨跌幅/.test(t.innerText)&&/(名称|代码)/.test(t.innerText));
    if (!candidates.length) return {ok:false,reason:'未找到呈现的报价表'};
    candidates[0].scrollIntoView({block:'start'});
    window.scrollBy(0,-50);
    return {ok:true};
  }
  function clickText(label) {
    const nodes=[...document.querySelectorAll('a,button,li,span,[role="tab"],[role="button"]')].filter(e=>visible(e,true)&&text(e)===label);
    const leaf=nodes.filter(e=>!nodes.some(n=>e!==n&&e.contains(n)));
    if (leaf.length!==1) return {ok:false,reason:`控件“${label}”可见匹配${leaf.length}个`};
    leaf[0].click(); return {ok:true};
  }
  function periodNode() {
    return [...document.querySelectorAll('a,button,li,span,[role="tab"]')].find(e=>{
      const r=e.getBoundingClientRect(),s=getComputedStyle(e);
      return r.width>0&&r.height>0&&s.display!=='none'&&s.visibility==='visible'&&/^(15分钟|15分)$/.test((e.innerText||'').trim());
    });
  }
  function prepareChart() {
    const period=periodNode();if(!period)return {ok:false,reason:'没有呈现的15分钟控件；请人工展开分钟菜单'};
    period.scrollIntoView({block:'center'});return {ok:true};
  }
  function chartContainer() {
    const period=periodNode();if(!period)return null;
    for(let p=period.parentElement;p&&p!==document.body;p=p.parentElement){const r=p.getBoundingClientRect();if(r.width>=450&&r.width<=1100&&r.height>=280&&r.height<=800)return p;}
    return null;
  }
  function scrollChart() {
    const chart=chartContainer();if(!chart)return {ok:false,reason:'无法从15分钟控件定位完整图表；请人工调整后补采'};
    chart.scrollIntoView({block:'center',inline:'nearest'});
    if(!visible(chart,true))return {ok:false,reason:'图表无法完整同屏或受到遮挡；请放大浏览器窗口并确认量柱后补采'};
    return {ok:true};
  }
  function chartInfo() {
    const canvases=[...document.querySelectorAll('canvas,svg,img')].filter(e=>visible(e,true)&&e.getBoundingClientRect().width>=500&&e.getBoundingClientRect().height>=100).map(rect);
    const controls=[...document.querySelectorAll('a,button,li,span,[role="tab"]')].filter(e=>visible(e,true)&&/^(15分钟|15分|MA|均线|成交量|VOL)$/.test(text(e))).map(e=>({text:text(e),rect:rect(e),selected:e.getAttribute('aria-selected')==='true'}));
    const chart=chartContainer(),r=chart&&rect(chart);
    return {url:location.href,at:new Date().toISOString(),viewport:{width:innerWidth,height:innerHeight,documentWidth:innerWidth,dpr:devicePixelRatio},chartRegion:r&&visible(chart,true)?{x:r.x,y:r.y,w:r.width,h:r.height}:null,canvases,controls,...periodState()};
  }
  function periodState() {
    const labels=/^(分时|日K|周K|月K|季K|年K|日线|周线|月线|[0-9]+分钟|[0-9]+分)$/;
    const nodes=[...document.querySelectorAll('a,button,li,span,[role="tab"]')].filter(e=>visible(e,true)&&labels.test(text(e)));
    const allLeaves=nodes.filter(e=>!nodes.some(n=>n!==e&&e.contains(n)));
    const target=allLeaves.filter(e=>/^(15分钟|15分)$/.test(text(e)));
    const bar=target.length===1?(target[0].closest('ul,[role="tablist"]')||target[0].parentElement):null;
    const leaves=bar?allLeaves.filter(e=>bar.contains(e)):[];
    const selected=leaves.filter(e=>[e,e.closest('a,button,[role="tab"]'),e.closest('li')].filter(Boolean).some(n=>n.getAttribute('aria-selected')==='true'||n.getAttribute('aria-current')==='page'||/(^|\s)(at|on|active|selected|cur)(\s|$)/i.test(n.className||'')));
    return {selectedPeriod:selected.length===1?text(selected[0]):null,selectedPeriodCount:selected.length,periodSelectionBasis:'仅同屏控件明确aria/选中类；图表日期、均线和量柱仍待目视'};
  }
  // 只查当前页面身份时不遍历全部报价表；图表内容依旧由新截图复核。
  const identity=()=>({url:location.href,title:document.title});
  return {snapshot,identity,scrollTable,prepareChart,clickText,scrollChart,chartInfo,periodState};
})();
