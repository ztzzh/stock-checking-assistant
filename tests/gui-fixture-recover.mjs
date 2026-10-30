// 仅EXE意外退出恢复夹具；调用真实恢复实现，桌面严格使用本次测试目录。
import path from 'node:path';import {recoverSavedBatch} from '../script/recover-batch.mjs';
const root=process.env.SCREENING_GUI_TEST_ROOT;if(!root||!path.isAbsolute(root))throw Error('仅允许软件验收调用');
try{console.log(JSON.stringify(await recoverSavedBatch(process.argv[2],{exitCode:Number(process.argv[3]),desktopDir:path.join(root,'fake-desktop')})));}catch(e){console.log(JSON.stringify({status:'failed',message:e.message}));process.exitCode=2;}
