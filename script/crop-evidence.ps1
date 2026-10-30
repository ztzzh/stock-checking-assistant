param([Parameter(Mandatory=$true)][string]$PlanFile)
$ErrorActionPreference='Stop'
Add-Type -AssemblyName System.Drawing
$plan = [IO.File]::ReadAllText($PlanFile,[Text.Encoding]::UTF8) | ConvertFrom-Json
$sourceRoot = [IO.Path]::GetFullPath($plan.sourceRoot).TrimEnd('\')+'\'
$targetRoot = [IO.Path]::GetFullPath($plan.targetRoot).TrimEnd('\')+'\'
foreach ($job in $plan.jobs) {
  $sourcePath = [IO.Path]::GetFullPath($job.source)
  $targetPath = [IO.Path]::GetFullPath($job.target)
  if (-not $sourcePath.StartsWith($sourceRoot,[StringComparison]::OrdinalIgnoreCase) -or -not $targetPath.StartsWith($targetRoot,[StringComparison]::OrdinalIgnoreCase)) { throw 'Evidence path outside batch' }
  $original = $null; $cropped = $null
  try {
    $original = [Drawing.Bitmap]::FromFile($sourcePath)
    $rect = [Drawing.Rectangle]::new([int]$job.rect.x,[int]$job.rect.y,[int]$job.rect.w,[int]$job.rect.h)
    if ($rect.X -lt 0 -or $rect.Y -lt 0 -or $rect.Width -lt 1 -or $rect.Height -lt 1 -or $rect.Right -gt $original.Width -or $rect.Bottom -gt $original.Height) { throw 'Invalid evidence rectangle' }
    $cropped = $original.Clone($rect,[Drawing.Imaging.PixelFormat]::Format32bppArgb)
    foreach ($point in @(@(0,0),@(($rect.Width-1),0),@(0,($rect.Height-1)),@(($rect.Width-1),($rect.Height-1)),@([int]($rect.Width/2),[int]($rect.Height/2)))) {
      if ($cropped.GetPixel($point[0],$point[1]).ToArgb() -ne $original.GetPixel(($rect.X+$point[0]),($rect.Y+$point[1])).ToArgb()) { throw 'Crop pixels changed' }
    }
    $cropped.Save($targetPath,[Drawing.Imaging.ImageFormat]::Png)
  } finally { if ($cropped) {$cropped.Dispose()}; if ($original) {$original.Dispose()} }
}
