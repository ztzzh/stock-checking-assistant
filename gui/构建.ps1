param([switch]$Desktop)
$ErrorActionPreference='Stop'
$projectPath=[IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$compilerPath=Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'
if(-not (Test-Path -LiteralPath $compilerPath)){$compilerPath=Join-Path $env:WINDIR 'Microsoft.NET\Framework\v4.0.30319\csc.exe'}
if(-not (Test-Path -LiteralPath $compilerPath)){throw '缺少.NET Framework C#编译器'}
$nodePath=(Get-Command node.exe -ErrorAction Stop).Source
$buildDir=Join-Path $PSScriptRoot 'build';New-Item -ItemType Directory -Path $buildDir -Force | Out-Null

$metadata='namespace StockWindow { static class BuildInfo { public const string ProjectRoot=""; public const string NodePath=""; } }'
$metadataFile=Join-Path $buildDir 'BuildInfo.cs';[IO.File]::WriteAllText($metadataFile,$metadata,[Text.UTF8Encoding]::new($true))
$exePath=Join-Path $projectPath '股票筛选.exe'
$compilerArgs=@('/nologo','/target:winexe','/platform:anycpu','/optimize+','/codepage:65001',('/out:'+$exePath),'/reference:System.Windows.Forms.dll','/reference:System.Drawing.dll','/reference:System.Web.Extensions.dll',(Join-Path $PSScriptRoot 'StockWindow.cs'),(Join-Path $PSScriptRoot 'BoardLibrary.cs'),$metadataFile)
& $compilerPath @compilerArgs
if($LASTEXITCODE -ne 0){throw 'EXE编译失败'}
Get-Item -LiteralPath $exePath | Select-Object FullName,Length
if($Desktop){$desktopPath=[Environment]::GetFolderPath('Desktop');$linkPath=Join-Path $desktopPath '股票筛选-桌面版.lnk';$shell=New-Object -ComObject WScript.Shell;$link=$shell.CreateShortcut($linkPath);$link.TargetPath=$exePath;$link.WorkingDirectory=$projectPath;$link.Save();Write-Output "桌面快捷方式：$linkPath"}
