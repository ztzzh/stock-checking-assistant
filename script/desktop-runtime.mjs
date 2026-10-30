// 桌面分发包优先使用随包运行环境；不读取或复制其他程序的登录资料。
import fs from 'node:fs';import path from 'node:path';import {fileURLToPath} from 'node:url';
export const desktopRoot=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const browser=path.join(desktopRoot,'runtime','browser','chrome-win64','chrome.exe');
if(!process.env.SCREENING_BROWSER_EXE&&fs.existsSync(browser))process.env.SCREENING_BROWSER_EXE=browser;
