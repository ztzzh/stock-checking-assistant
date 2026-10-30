param([string]$NodeBinary,[Parameter(Mandatory=$true)][string]$BrowserDirectory,[string]$OutputDirectory,[switch]$SkipBuild)
$ErrorActionPreference='Stop'
$root=[IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
if(-not $NodeBinary){$NodeBinary=(Get-Command node.exe -ErrorAction Stop).Source}
$NodeBinary=[IO.Path]::GetFullPath($NodeBinary);$BrowserDirectory=[IO.Path]::GetFullPath($BrowserDirectory)
if(-not (Test-Path -LiteralPath $NodeBinary -PathType Leaf)){throw '缺少Node程序'}
if(-not (Test-Path -LiteralPath (Join-Path $BrowserDirectory 'chrome.exe') -PathType Leaf)){throw '浏览器目录须包含chrome.exe'}
if((Test-Path -LiteralPath (Join-Path $BrowserDirectory 'Default')) -or (Test-Path -LiteralPath (Join-Path $BrowserDirectory 'Local State'))){throw '不得打包个人浏览器配置目录'}
if(-not $OutputDirectory){$OutputDirectory=Join-Path $root 'dist'}
$OutputDirectory=[IO.Path]::GetFullPath($OutputDirectory);New-Item -ItemType Directory -Path $OutputDirectory -Force | Out-Null
if(-not $SkipBuild){& (Join-Path $root 'gui\构建.ps1');if($LASTEXITCODE -ne 0){throw '桌面构建失败'}}
& $NodeBinary (Join-Path $root 'tools\release-audit.mjs');if($LASTEXITCODE -ne 0){throw '发布审计失败'}
$version=[IO.File]::ReadAllText((Join-Path $root 'VERSION')).Trim();$name='StockCheckingAssistant-v'+$version+'-win-x64'
$zip=Join-Path $OutputDirectory ($name+'.zip');if(Test-Path -LiteralPath $zip){throw '版本包已存在；请使用新的输出目录或版本号，避免覆盖已发布内容'}
$stageRoot=Join-Path $OutputDirectory ('stage-'+[guid]::NewGuid().ToString('N'));$stage=Join-Path $stageRoot $name;New-Item -ItemType Directory -Path $stage -Force | Out-Null
foreach($file in @('股票筛选.exe','README.md','VERSION','CHANGELOG.md','CONTRIBUTING.md','ROADMAP.md','TODO.md','THIRD_PARTY_NOTICES.md','package.json','package-lock.json','板块名单.json','rendered-full-page.mjs')){Copy-Item -LiteralPath (Join-Path $root $file) -Destination (Join-Path $stage $file)}
foreach($folder in @('script','extension','gui','tests','tools','docs','vendor')){
 foreach($file in Get-ChildItem -LiteralPath (Join-Path $root $folder) -Recurse -File){$relative=$file.FullName.Substring($root.Length+1);if($relative -match '^gui[\\/]build[\\/]'){continue};$target=Join-Path $stage $relative;New-Item -ItemType Directory -Path (Split-Path $target -Parent) -Force | Out-Null;Copy-Item -LiteralPath $file.FullName -Destination $target}
}
$runtime=Join-Path $stage 'runtime';New-Item -ItemType Directory -Path $runtime -Force | Out-Null;Copy-Item -LiteralPath $NodeBinary -Destination (Join-Path $runtime 'node.exe')
$browserTarget=Join-Path $runtime 'browser\chrome-win64';New-Item -ItemType Directory -Path (Split-Path $browserTarget -Parent) -Force | Out-Null;Copy-Item -LiteralPath $BrowserDirectory -Destination $browserTarget -Recurse
$modules=Join-Path $stage 'node_modules';New-Item -ItemType Directory -Path $modules -Force | Out-Null
foreach($dependency in @('playwright-core','westock-data-clawhub')){Copy-Item -LiteralPath (Join-Path $root ('node_modules\'+$dependency)) -Destination (Join-Path $modules $dependency) -Recurse}
$licenses=Join-Path $stage 'licenses';New-Item -ItemType Directory -Path $licenses -Force | Out-Null
$nodeLicense=Join-Path (Split-Path $NodeBinary -Parent) 'LICENSE';if(-not (Test-Path -LiteralPath $nodeLicense)){throw 'Node分发目录缺少LICENSE，不能打包'};Copy-Item -LiteralPath $nodeLicense -Destination (Join-Path $licenses 'node-LICENSE.txt')
$rows=@();foreach($file in Get-ChildItem -LiteralPath $stage -Recurse -File){$rows+=@{file=$file.FullName.Substring($stage.Length+1).Replace('\','/');size=$file.Length;sha256=(Get-FileHash -LiteralPath $file.FullName -Algorithm SHA256).Hash.ToLowerInvariant()}}
$nodeVersion=(& $NodeBinary --version);$browserVersion=(Get-ChildItem -LiteralPath $browserTarget -Filter '*.manifest' -File | Select-Object -First 1).BaseName
$manifest=@{version=$version;platform='win-x64';entry='股票筛选.exe';node=$nodeVersion;playwright=(Get-Content -LiteralPath (Join-Path $modules 'playwright-core\package.json') -Raw | ConvertFrom-Json).version;browser=$browserVersion;containsPersonalProfile=$false;files=$rows}
[IO.File]::WriteAllText((Join-Path $stage 'release-manifest.json'),($manifest | ConvertTo-Json -Depth 5),[Text.UTF8Encoding]::new($false))
Add-Type -AssemblyName System.IO.Compression.FileSystem
[IO.Compression.ZipFile]::CreateFromDirectory($stageRoot,$zip,[IO.Compression.CompressionLevel]::Optimal,$false)
$hash=(Get-FileHash -LiteralPath $zip -Algorithm SHA256).Hash.ToLowerInvariant();[IO.File]::WriteAllText(($zip+'.sha256'),($hash+'  '+[IO.Path]::GetFileName($zip)+[Environment]::NewLine),[Text.UTF8Encoding]::new($false))
Write-Output ('完整桌面包：'+$zip);Write-Output ('SHA256：'+$hash)
