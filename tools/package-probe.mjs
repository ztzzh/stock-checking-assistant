// 仅打开合成空白页面，不访问个股或模型。
import '../script/desktop-runtime.mjs';import {loadPlaywright,findBrowser} from '../script/browser.mjs';
const {chromium}=await loadPlaywright(),file=await findBrowser(chromium,process.env.SCREENING_BROWSER_EXE);
const browser=await chromium.launch({executablePath:file,headless:true,handleSIGINT:false});
try{const page=await browser.newPage();await page.setContent('<title>desktop-package-probe</title><p>isolated</p>');console.log(JSON.stringify({title:await page.title(),browserBundled:file.startsWith(process.cwd()),nodeBundled:process.execPath.startsWith(process.cwd())}));}finally{await browser.close();}
