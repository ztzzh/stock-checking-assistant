import fs from 'node:fs/promises';import path from 'node:path';import {createHash} from 'node:crypto';import {fileURLToPath} from 'node:url';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..'),errors=[];
const read=relative=>fs.readFile(path.join(root,relative),'utf8');
const version=(await read('VERSION')).trim(),pkg=JSON.parse(await read('package.json'));
if(pkg.version!==version)errors.push('VERSION/package.json版本不一致');
if(!(await read('CHANGELOG.md')).includes('## ['+version+']'))errors.push('缺少本版本更新记录');
for(const file of ['README.md','CONTRIBUTING.md','ROADMAP.md','TODO.md','THIRD_PARTY_NOTICES.md','股票筛选.exe','script/gui-bridge.mjs','script/desktop-runtime.mjs','extension/core.js','extension/visible.js','rendered-full-page.mjs'])try{await fs.access(path.join(root,file));}catch{errors.push('缺文件：'+file);}
for(const file of ['选股.cmd','选股.ps1','启动工作台.ps1','server.py','web','extension/manifest.json','.env'])try{await fs.access(path.join(root,file));errors.push('桌面源仓库混入非发布入口或私有环境：'+file);}catch{}
const files=[];
async function walk(dir){for(const entry of await fs.readdir(dir,{withFileTypes:true})){if(['.git','node_modules','runtime','dist','.audit','build'].includes(entry.name))continue;const file=path.join(dir,entry.name);if(entry.isDirectory())await walk(file);else files.push(file);}}
await walk(root);
for(const file of files.filter(f=>/\.(m?js|cs|ps1|md|json|yml)$/.test(f))){
 const text=await fs.readFile(file,'utf8'),relative=path.relative(root,file);
 if(/\b(?:sk-[A-Za-z0-9]{24,}|gh[pousr]_[A-Za-z0-9]{24,}|github_pat_[A-Za-z0-9_]{24,})\b/.test(text))errors.push('疑似密钥：'+relative);
 if(/(?:C:[\\/]+Users[\\/]+Hzt10|D:[\\/]+1ws)/i.test(text))errors.push('包含原机器绝对路径：'+relative);
 if(/\.(?:mjs|js)$/.test(file))for(const match of text.matchAll(/(?:from\s*|import\s*\()\s*['"](\.[^'"]+)['"]/g))try{await fs.access(path.resolve(path.dirname(file),match[1]));}catch{errors.push('相对依赖缺失：'+relative+' → '+match[1]);}
}
const vendor=JSON.parse(await read('vendor/checksums.json'));
for(const item of vendor){const actual=createHash('sha256').update(await fs.readFile(path.join(root,item.file))).digest('hex');if(actual!==item.sha256)errors.push('依赖包校验失败：'+item.file);}
const strategy=JSON.parse(await read('docs/strategy-fingerprints.json'));
for(const item of strategy){const actual=createHash('sha256').update(await fs.readFile(path.join(root,item.file))).digest('hex');if(actual!==item.sha256)errors.push('共享策略文件与发布基线不一致：'+item.file);}
console.log(JSON.stringify({status:errors.length?'failed':'passed',version,files:files.length,scope:'桌面源依赖/版本/入口边界/密钥与本机路径/策略基线',errors},null,2));if(errors.length)process.exitCode=1;
