// 离线契约测试。生成的彩色PNG是软件夹具，不是真实股票。
import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs/promises';import path from 'node:path';import os from 'node:os';import {createHash} from 'node:crypto';import {deflateSync} from 'node:zlib';
import {prepareReviewEvidence,evidenceRectangle,pngDimensions} from '../script/review-evidence.mjs';
import {reasoningEffort} from '../script/review-settings.mjs';
import {makePrompt,codexArgs,codexUsage,reviewInput} from '../script/vision.mjs';
import {requestArgs} from '../script/gui-protocol.mjs';import {options} from '../script/screen.mjs';
const hash=b=>createHash('sha256').update(b).digest('hex');
function crc(bytes){let n=0xffffffff;for(const b of bytes){n^=b;for(let j=0;j<8;j++)n=(n>>>1)^((n&1)?0xedb88320:0);}return(n^0xffffffff)>>>0;}
function png(w,h){const chunk=(type,data)=>{const t=Buffer.from(type),b=Buffer.alloc(data.length+12);b.writeUInt32BE(data.length);t.copy(b,4);data.copy(b,8);b.writeUInt32BE(crc(Buffer.concat([t,data])),data.length+8);return b;};const header=Buffer.alloc(13);header.writeUInt32BE(w);header.writeUInt32BE(h,4);header[8]=8;header[9]=2;const pixels=Buffer.alloc(h*(w*3+1));for(let y=0;y<h;y++)for(let x=0;x<w;x++){const p=y*(w*3+1)+1+x*3;pixels[p]=x%256;pixels[p+1]=y%256;pixels[p+2]=(x+y)%256;}return Buffer.concat([Buffer.from('89504e470d0a1a0a','hex'),chunk('IHDR',header),chunk('IDAT',deflateSync(pixels)),chunk('IEND',Buffer.alloc(0))]);}
async function fixture(t){const root=await fs.mkdtemp(path.join(os.tmpdir(),'stock-economy-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));const dir=path.join(root,'review');await fs.mkdir(dir);const bytes=png(800,600),sha=hash(bytes),code='300001';const item={code,name:'合成',price:'12',open:'11',chartFile:code+'-15分钟.png',imageSHA256:sha,quoteSnapshot:{source:'sina',evidenceRegion:{x:100,y:80,w:200,h:100}},chartInfo:{chartRegion:{x:150,y:200,w:400,h:300}},periodFiles:[{file:code+'-周期1.png',imageSHA256:sha}],parameterFiles:[{file:code+'-MA参数1.png',imageSHA256:sha,evidenceRegion:{x:300,y:220,w:100,h:140}}]};const images=[item.chartFile,code+'-报价.png',item.periodFiles[0].file,item.parameterFiles[0].file].map(file=>({file,label:'合成',sha256:sha}));for(const i of images)await fs.writeFile(path.join(root,i.file),bytes);const run={selectionMode:'specified-sectors',marketSource:'sina',limit:10,items:[item],images,sectors:[{code:'pt02test',name:'合成板块'}],membershipEvidence:{groups:[{sector:'pt02test',name:'合成板块',total:1,items:[{code,name:'合成'}]}]}};return{root,dir,bytes,run,input:reviewInput(run)};}
test('推理档位显式传入CLI；Sol轻度、Terra/Luna默认，DeepSeek不误用Codex配置',()=>{
 assert.equal(reasoningEffort(undefined),'low');assert.equal(reasoningEffort(undefined,'gpt-6.1-terra'),'default');assert.equal(reasoningEffort(undefined,'gpt-6-luna'),'default');assert.equal(reasoningEffort('high','deepseek-flash'),'default');assert.throws(()=>reasoningEffort('none'),/推理档位/);
 for(const e of ['low','medium','high']){const args=codexArgs({directory:'.',schemaFile:'s',outputFile:'o',images:[],model:'gpt-6.1-sol',reasoningEffort:e});assert.equal(args[args.indexOf('--config')+1],'model_reasoning_effort='+JSON.stringify(e));assert(args.includes('--json'));}
 assert(!codexArgs({images:[],model:'gpt-6-luna',reasoningEffort:'default'}).includes('--config'));assert.throws(()=>options(['--reasoning-effort','none']),/推理档位/);assert.equal(options(['--full-evidence']).compactEvidence,false);
});
test('窗口正常、补采、原图复核都传档位和图证开关，非法值被拒绝',async t=>{const {root}=await fixture(t);await fs.writeFile(path.join(root,'run.json'),'{}');const base={command:'start',mode:'normal',source:'sina',model:'gpt-6.1-sol',sectors:['合成'],limit:1,captureSeconds:300,reviewSeconds:180,batchDirectory:root,reasoningEffort:'medium',compactEvidence:false};for(const mode of ['normal','resume','review']){const args=await requestArgs({...base,mode},root);assert.equal(args[args.indexOf('--reasoning-effort')+1],'medium');assert(args.includes('--full-evidence'));}assert(!(await requestArgs({...base,model:'deepseek-flash'},root)).includes('--reasoning-effort'));await assert.rejects(requestArgs({...base,reasoningEffort:'none'},root),/推理档位/);await assert.rejects(requestArgs({...base,compactEvidence:'true'},root),/须为开关/);});
test('精简上下文不夹带无关DOM和成分，保留严格顺序、实际周期、量柱与边界规则',async t=>{const {run}=await fixture(t);run.items[0].chartInfo.unneededDOM='无关DOM'.repeat(10000);run.membershipEvidence.groups[0].items.push({code:'600999',name:'未送审'});const small=makePrompt(run),full=makePrompt({...run,compactEvidence:false});assert(small.length<full.length*.5);assert(!small.includes('无关DOM'));assert(!small.includes('600999'));for(const text of ['不发明固定百分比阈值','完整成交量','后续全部not_checked','边界unclear','15分按钮选中不足','数值不清填null','不对板块强弱做判断'])assert(small.includes(text),text);});
test('实际裁边保留完整主图、原始像素坐标与SHA，原始文件逐字节不变',async t=>{const {root,dir,bytes,input}=await fixture(t);const result=await prepareReviewEvidence(input,root,dir);assert.equal(result.manifest.croppedImages,3);assert(result.manifest.submittedPixels<result.manifest.originalPixels*.6);assert.equal(result.images[0].path,path.join(root,input.targets[0].chartFile));assert(!result.images[0].crop);for(const image of result.images){assert.equal(hash(await fs.readFile(path.join(root,image.originalFile))),hash(bytes));assert.equal(hash(await fs.readFile(image.path)),image.sha256);const size=pngDimensions(await fs.readFile(image.path));assert.equal(size.width,image.width);assert.equal(size.height,image.height);}assert.deepEqual(result.images[1].crop,{x:88,y:68,w:224,h:124});});
test('不猜测旧报价/参数位置；越界及缺失区域交原图，周期保留全图表与余量',async t=>{const {run}=await fixture(t),i=run.items[0],d={width:800,height:600};assert.equal(evidenceRectangle({file:i.chartFile},i,d),null);delete i.quoteSnapshot.evidenceRegion;delete i.parameterFiles[0].evidenceRegion;assert.equal(evidenceRectangle({file:i.code+'-报价.png'},i,d),null);assert.equal(evidenceRectangle({file:i.parameterFiles[0].file},i,d),null);i.quoteSnapshot.evidenceRegion={x:799,y:2,w:200,h:20};assert.equal(evidenceRectangle({file:i.code+'-报价.png'},i,d),null);const rect=evidenceRectangle({file:i.periodFiles[0].file},i,d);assert(rect.x<i.chartInfo.chartRegion.x&&rect.y+rect.h>=500);});
test('裁边失败整批回退原图，取消不回退；任何原图SHA不符都禁止送审',async t=>{const {root,dir,input}=await fixture(t);const result=await prepareReviewEvidence(input,root,dir,{crop:async()=>{throw Error('合成裁边失败');}});assert(result.manifest.fallback.includes('完整原图'));assert.equal(result.manifest.croppedImages,0);assert.equal(result.manifest.originalPixels,result.manifest.submittedPixels);for(const image of result.images)assert.equal(image.file,image.originalFile);const controller=new AbortController();await assert.rejects(prepareReviewEvidence(input,root,dir,{signal:controller.signal,crop:async()=>{controller.abort(Error('合成取消'));throw Error('合成');}}),/合成取消/);await fs.writeFile(path.join(root,input.images[1].file),png(20,20));await assert.rejects(prepareReviewEvidence(input,root,dir),/SHA256不符/);});
test('真实Codex用量只认完成事件，缺失时不伪造0消耗',()=>{assert.equal(codexUsage('not json\n{"type":"turn.started"}'),undefined);assert.deepEqual(codexUsage('{"type":"turn.completed","usage":{"input_tokens":123,"cached_input_tokens":12,"output_tokens":4}}'),{input_tokens:123,cached_input_tokens:12,output_tokens:4});assert.equal(codexUsage('{"type":"turn.completed","usage":{"input_tokens":-1,"output_tokens":4}}'),undefined);});
test('高DPI截图按实际视口等比换算；比例矛盾时保留原图',async t=>{const {run}=await fixture(t),i=run.items[0];i.quoteSnapshot.evidenceViewport={width:400,height:300};assert.deepEqual(evidenceRectangle({file:i.code+'-报价.png'},i,{width:800,height:600}),{x:176,y:136,w:448,h:248});i.quoteSnapshot.evidenceViewport.height=400;assert.equal(evidenceRectangle({file:i.code+'-报价.png'},i,{width:800,height:600}),null);});
test('裁边期间原文件改变即拒绝；完整图证模式不启动裁边',async t=>{const {root,dir,input}=await fixture(t);let called=false;const full=await prepareReviewEvidence(input,root,dir,{compact:false,crop:()=>{called=true;}});assert.equal(called,false);assert.equal(full.manifest.version,'full-v1');await assert.rejects(prepareReviewEvidence(input,root,dir,{crop:async()=>{await fs.writeFile(path.join(root,input.images[1].file),png(20,20));throw Error('合成源文件变动');}}),/准备期间原图SHA256/);});
test('图片清单和个股原图两处SHA必须同时一致，不能用其中一个掩盖另一个矛盾',async t=>{const {root,dir,input}=await fixture(t);input.targets[0].imageSHA256='0'.repeat(64);await assert.rejects(prepareReviewEvidence(input,root,dir),/SHA256不符/);});

function locatedMain(item,{current=false}={}){
 const viewport={width:800,height:600},url='https://finance.sina.com.cn/realstock/company/sz'+item.code+'/nc.shtml';
 Object.assign(item.quoteSnapshot,{code:item.code,name:item.name,source:'sina',url,evidenceViewport:viewport,evidenceRegion:{x:150,y:350,w:400,h:100}});
 Object.assign(item.chartInfo,{source:'sina',url,evidenceViewport:viewport,readiness:{ready:true,renderMode:'sina-canvas'},chartRegion:{x:150,y:200,w:400,h:300}});
 if(current)item.chartInfo.mainQuoteSnapshot={...item.quoteSnapshot,evidenceRegion:{x:140,y:50,w:420,h:100}};
 return item;
}
test('旧新浪主图只裁左右保留全高，不把旧报价滚动前的纵坐标当成主图位置',async t=>{
 const {run,root,dir,input,bytes}=await fixture(t),item=locatedMain(run.items[0]);
 const result=await prepareReviewEvidence(input,root,dir,{cropMain:true});const image=result.images[0];
 assert.deepEqual(image.crop,{x:134,y:0,w:432,h:600});assert.equal(image.height,600);assert.equal(image.width,432);assert.equal(hash(await fs.readFile(path.join(root,item.chartFile))),hash(bytes));
 assert.notEqual(image.path,path.join(root,item.chartFile));assert.equal(image.originalSHA256,item.imageSHA256);assert.equal(image.originalFile,item.chartFile);
});
test('同屏报价与完整图表联合裁边，身份报价区、周期轴和量柱都在保留矩形内',async t=>{
 const {run,root,dir,input}=await fixture(t),item=locatedMain(run.items[0],{current:true});
 const result=await prepareReviewEvidence(input,root,dir,{cropMain:true}),image=result.images[0];assert.deepEqual(image.crop,{x:124,y:34,w:452,h:482});
 for(const r of [item.chartInfo.mainQuoteSnapshot.evidenceRegion,item.chartInfo.chartRegion]){assert(image.crop.x<=r.x&&image.crop.y<=r.y);assert(image.crop.x+image.crop.w>=r.x+r.w&&image.crop.y+image.crop.h>=r.y+r.h);}
});
test('新主图的身份矛盾、旧记录定位不足及DPI比例异常都保留整图，不回退猜测',async t=>{
 const {run}=await fixture(t),item=locatedMain(run.items[0],{current:true}),img={file:item.chartFile},dims={width:800,height:600};
 item.chartInfo.mainQuoteSnapshot.code='999999';assert.equal(evidenceRectangle(img,item,dims),null);
 delete item.chartInfo.mainQuoteSnapshot;item.quoteSnapshot.evidenceRegion.x+=50;assert.equal(evidenceRectangle(img,item,dims),null);
 locatedMain(item);item.chartInfo.readiness.ready=false;assert.equal(evidenceRectangle(img,item,dims),null);
 locatedMain(item);assert.equal(evidenceRectangle(img,item,{width:1600,height:900}),null);
 locatedMain(item);delete item.chartInfo.evidenceViewport;assert.equal(evidenceRectangle(img,item,dims),null);
});
test('主图高DPI只等比换算裁切坐标，整图模式跳过主图裁边，失败还原原图',async t=>{
 const {run,root,dir,input}=await fixture(t),item=locatedMain(run.items[0]);assert.deepEqual(evidenceRectangle({file:item.chartFile},item,{width:1600,height:1200}),{x:268,y:0,w:864,h:1200});
 let called=false;const original=await prepareReviewEvidence(input,root,dir,{compact:false,crop:()=>{called=true;}});assert.equal(called,false);assert(original.images.every(i=>!i.crop));
 const fallback=await prepareReviewEvidence(input,root,dir,{crop:async()=>{throw Error('不能裁图');}});assert(fallback.images.every(i=>!i.crop&&i.file===i.originalFile));assert.equal(fallback.images[0].path,path.join(root,item.chartFile));
});
test('提示词去审计噪音但保留身份、报价、时点、归属和每张图对应代码，矛盾报价不被精简掩盖',async t=>{
 const {run}=await fixture(t),item=run.items[0];run.singleChartOnly=true;item.quoteSnapshot.dateText='2026-10-28 15:35';item.capturedAt='2026-10-28T08:35:00Z';item.memberships=[{code:'pt02test',name:'合成板块',source:'无关长来源'}];
 const prompt=makePrompt(run,{images:[{...run.images[0],originalFile:item.chartFile,file:'01-'+item.chartFile,sha256:'不需模型读取的SHA',originalSHA256:'原图SHA',width:800,height:600,crop:{x:1,y:0,w:700,h:600}}]});
 assert(!prompt.includes('不需模型读取的SHA')&&!prompt.includes('原图SHA')&&!prompt.includes('无关长来源'));
 for(const value of [item.code,item.name,'2026-10-28 15:35',item.capturedAt,'合成板块','15分钟主图','originalFile','cropped','stocks恰好返回','后续全部not_checked','只有四项明确pass才符合'])assert(prompt.includes(value),value);
 item.quoteSnapshot.price='9';assert(makePrompt(run).includes('quoteReadback'));assert(makePrompt(run).includes('"price":"9"'));
});
test('主图裁边必须显式选择试用，旧模式即便有完整定位仍保留整张主图',async t=>{
 const {run,root,dir,input}=await fixture(t);locatedMain(run.items[0],{current:true});
 const result=await prepareReviewEvidence(input,root,dir);assert.equal(result.manifest.mainCropRequested,false);assert(!result.images[0].crop);assert.equal(result.images[0].path,path.join(root,run.items[0].chartFile));
});