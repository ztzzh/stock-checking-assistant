# 构建、测试与发布

## 本地源码

Windows 10/11 x64、.NET Framework 4.x及Node.js 24或更高版本。源代码依赖来自仓库固定的vendor包：

```powershell
npm ci --ignore-scripts --offline
npm test
npm run build:desktop
```

依赖和Node未随Git源仓库提交；Release完整包会包含它们。`gui/构建.ps1 -Desktop`创建快捷方式，不把独立EXE复制出配套目录。

## 完整分发包

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File tools/package-desktop.ps1 -NodeBinary "C:\Node\node.exe" -BrowserDirectory "C:\浏览器\chrome-win64"
npm run audit:release
```

浏览器参数指向包含chrome.exe的程序目录，不得指向个人浏览器配置目录。打包采用明确文件清单，不收集工作区、用户桌面、设置、API密钥、浏览器profile、历史筛选结果和日志。

在新的中文及空格目录中解压验证：EXE运行环境报告、原生界面自检、浏览器启动、暂停/继续及停止联通。测试仅使用合成图/审核结果，不能宣称实际网站或真实模型一定可用。行情和模型服务故障仍由相应诊断记录说明。

## GitHub发布

本仓库没有qtcloud-devops工作流。修改通过功能分支/PR，CI通过后合并main。首次空仓库需先建立main基线。发布前核对VERSION、package.json、CHANGELOG和包清单，通过`git diff --check`与发布审计，再从main创建不可变vX.Y.Z标签和GitHub Release，上传完整ZIP与SHA256文件。不得把失败的发布说成已经完成。

不上传本地密钥或登录状态；Codex模型使用安装机器自己的登录环境。第三方依赖保留原许可和NOTICE，见THIRD_PARTY_NOTICES.md。
