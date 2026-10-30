export const EVIDENCE_VERSION='compact-v1';
export const MAIN_EVIDENCE_VERSION='main-v1';
export const EVIDENCE_MODES=['main-auto','main-only','compact','full','main-auto-crop','main-only-crop'];
export function evidenceLabel(mode){return {'main-auto':'主图优先（缺证补一次）','main-only':'仅主图（不补图）',compact:'精简多图',full:'完整多图','main-auto-crop':'试用裁边主图（缺证补一次）','main-only-crop':'试用裁边主图（不补图）'}[mode]||'精简多图';}
export function evidenceMode(value,{compactEvidence}={}){
  const mode=value??(compactEvidence===false?'full':'main-auto');
  if(!EVIDENCE_MODES.includes(mode))throw Error('图证模式仅支持main-auto、main-only、compact、full、main-auto-crop、main-only-crop');return mode;
}
export function reasoningEffort(value,model='gpt-6.1-sol'){
  const effort=value??(model==='gpt-6.1-sol'?'low':'default');
  if(!['default','low','medium','high'].includes(effort))throw Error('推理档位仅支持default、low、medium、high');
  return model==='deepseek-flash'||model.startsWith('qwen')?'default':effort;
}
export function reviewSettings(cfg={}){
  const mode=evidenceMode(cfg.evidenceMode,cfg);
  return {reasoningEffort:reasoningEffort(cfg.reasoningEffort,cfg.model||'gpt-6.1-sol'),compactEvidence:mode!=='full',singleChartOnly:mode.startsWith('main-'),autoSupplement:['main-auto','main-auto-crop'].includes(mode),cropMain:mode.endsWith('-crop'),evidenceMode:mode};
}
