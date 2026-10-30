// 已解压分发包的哈希与隔离运行环境核验，不访问行情或付费模型。
import fs from 'node:fs/promises';import path from 'node:path';import {createHash} from 'node:crypto';import {execFile} from 'node:child_process';import {promisify} from 'node:util';
const root=path.resolve(process.argv[2]||'.'),manifest=JSON.parse(await fs.readFile(path.join(root,'release-manifest.json'),'utf8')),errors=[];
for(const row of manifest.files){const file=path.resolve(root,row.file);if(!file.startsWith(root+path.sep)){errors.push('包路径越界');continue;}const bytes=await fs.readFile(file);if(bytes.length!==row.size||createHash('sha256').update(bytes).digest('hex')!==row.sha256)errors.push(row.file);}
if(errors.length)throw Error('分发包文件校验失败：'+errors.join('、'));
const execute=promisify(execFile),node=path.join(root,'runtime','node.exe');
const env={...process.env,SCREENING_MODULE_ROOT:path.join(root,'missing-external-runtime.js')};delete env.SCREENING_BROWSER_EXE;
const result=await execute(node,[path.join(root,'tools','package-probe.mjs')],{cwd:root,env,windowsHide:true,timeout:30000});const evidence=JSON.parse(result.stdout.trim());
if(!evidence.nodeBundled||!evidence.browserBundled||evidence.title!=='desktop-package-probe')throw Error('运行环境没有使用分发包');
console.log(JSON.stringify({status:'passed',version:manifest.version,verifiedFiles:manifest.files.length,...evidence,scope:'解压包逐文件SHA256和隔离空白页面，无真实行情或模型调用'},null,2));
