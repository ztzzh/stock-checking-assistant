import {sourceName,sourceFromURL} from './sources.mjs';
const csv=value=>{let s=String(value??'');if(/^[=+@\-\t\r]/.test(s))s="'"+s;return '"'+s.replaceAll('"','""')+'"';};
export function resultCSV(run){
 const rows=[['代码','名称','所属板块','行情图表来源','现价','今开','结果','原因','距MA20百分比','本次图证','复核模型'],...run.items.map(i=>[i.code,i.name,i.memberships?.map(m=>m.name).join('、')||run.sector?.name||'',sourceName(i.marketSource||i.quoteSnapshot?.source||sourceFromURL(i.quoteSnapshot?.url)||run.marketSource||'eastmoney'),i.price,i.open,i.result?.status||'待确认',i.result?.reason||i.captureError||'尚未完成',i.distanceToMA20Percent?.toFixed(3),i.chartFile,i.reviewEngine?.model||(i.review?'Codex（旧记录）':'未复核')])];
 return '\ufeff'+rows.map(r=>r.map(csv).join(',')).join('\r\n');
}
