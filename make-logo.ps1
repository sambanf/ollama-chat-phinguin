<#
.SYNOPSIS
  Builds Phi-nguin's icons from a logo image. Finds the artwork on its plain background,
  crops a square around all of it (badge, speech bubble and name), and writes rounded-square
  PNG icons into public\.

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File make-logo.ps1
  powershell -ExecutionPolicy Bypass -File make-logo.ps1 -Source "C:\path\to\logo.png"
#>
param(
  [string]$Source,          # default: the first logo-source.* image in this folder (.png/.jpg/.jpeg/.bmp/.gif)
  [string]$OutDir = (Join-Path $PSScriptRoot 'public'),
  [double]$Padding = 0.05,  # space around the artwork, as a fraction of its size
  [double]$Corner = 0.22    # corner radius of the rounded icons, as a fraction of the icon size
)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing
if (-not $Source) {
  $Source = Get-ChildItem $PSScriptRoot -File -Filter 'logo-source*' |
    Where-Object { $_.Extension -match '^\.(png|jpe?g|bmp|gif)$' } |
    Select-Object -First 1 -ExpandProperty FullName
}
if (-not $Source -or -not (Test-Path $Source)) { throw "No logo found. Save it as logo-source.png (or .jpg) in $PSScriptRoot" }
if (-not (Test-Path $OutDir)) { New-Item -ItemType Directory -Path $OutDir | Out-Null }

$src = [System.Drawing.Bitmap]::FromFile((Resolve-Path $Source).Path)
# Mirror edge pixels when resampling, so scaled images don't get semi-transparent borders.
$attrs = New-Object System.Drawing.Imaging.ImageAttributes
$attrs.SetWrapMode([System.Drawing.Drawing2D.WrapMode]::TileFlipXY)

function New-RoundedRect([single]$x, [single]$y, [single]$w, [single]$h, [single]$r) {
  $p = New-Object System.Drawing.Drawing2D.GraphicsPath
  $d = 2 * $r
  $p.AddArc($x, $y, $d, $d, 180, 90)
  $p.AddArc($x + $w - $d, $y, $d, $d, 270, 90)
  $p.AddArc($x + $w - $d, $y + $h - $d, $d, $d, 0, 90)
  $p.AddArc($x, $y + $h - $d, $d, $d, 90, 90)
  $p.CloseFigure()
  return $p
}

function Save-Icon([int]$size, [string]$name, [bool]$rounded) {
  # Square crop around the artwork, scaled to $size...
  $sq = New-Object System.Drawing.Bitmap $size, $size
  $g = [System.Drawing.Graphics]::FromImage($sq)
  $g.InterpolationMode = 'HighQualityBicubic'
  $g.PixelOffsetMode = 'HighQuality'
  $dst = New-Object System.Drawing.Rectangle 0, 0, $size, $size
  $g.DrawImage($src, $dst, [single]($cx - $side / 2), [single]($cy - $side / 2), [single]$side, [single]$side, [System.Drawing.GraphicsUnit]::Pixel, $attrs)
  $g.Dispose()

  $out = $sq
  if ($rounded) {
    # ...then painted through an anti-aliased rounded square onto a transparent canvas.
    $out = New-Object System.Drawing.Bitmap $size, $size
    $g = [System.Drawing.Graphics]::FromImage($out)
    $g.SmoothingMode = 'AntiAlias'
    $g.PixelOffsetMode = 'HighQuality'
    $g.Clear([System.Drawing.Color]::Transparent)
    $brush = New-Object System.Drawing.TextureBrush $sq
    $path = New-RoundedRect 0 0 $size $size ([single]($size * $Corner))
    $g.FillPath($brush, $path)
    $path.Dispose(); $brush.Dispose(); $g.Dispose(); $sq.Dispose()
  }
  $out.Save((Join-Path $OutDir $name), [System.Drawing.Imaging.ImageFormat]::Png)
  $out.Dispose()
  "  wrote $name ($size x $size)"
}

try {
  # 1) Find the artwork on a downscaled copy: the bounding box of pixels that clearly
  #    differ from the background color (sampled near the top-left corner).
  $sw = 256
  $scale = $src.Width / $sw
  $sh = [int][Math]::Round($src.Height / $scale)
  $small = New-Object System.Drawing.Bitmap $sw, $sh
  $g = [System.Drawing.Graphics]::FromImage($small)
  $g.InterpolationMode = 'HighQualityBilinear'
  $g.DrawImage($src, (New-Object System.Drawing.Rectangle 0, 0, $sw, $sh), 0, 0, $src.Width, $src.Height, [System.Drawing.GraphicsUnit]::Pixel, $attrs)
  $g.Dispose()

  $bg = $small.GetPixel(3, 3)
  $minX = $sw; $maxX = -1; $minY = $sh; $maxY = -1
  for ($y = 2; $y -lt $sh - 2; $y++) {
    for ($x = 2; $x -lt $sw - 2; $x++) {
      $p = $small.GetPixel($x, $y)
      $d = [Math]::Abs($p.R - $bg.R) + [Math]::Abs($p.G - $bg.G) + [Math]::Abs($p.B - $bg.B) + [Math]::Abs($p.A - $bg.A)
      if ($d -gt 90) {
        if ($x -lt $minX) { $minX = $x }
        if ($x -gt $maxX) { $maxX = $x }
        if ($y -lt $minY) { $minY = $y }
        if ($y -gt $maxY) { $maxY = $y }
      }
    }
  }
  $small.Dispose()

  if ($maxX -lt 0) {
    # Nothing stood out: use the largest centered square.
    $cx = $src.Width / 2; $cy = $src.Height / 2
    $side = [Math]::Min($src.Width, $src.Height)
  } else {
    $cx = ($minX + $maxX + 1) / 2 * $scale
    $cy = ($minY + $maxY + 1) / 2 * $scale
    $side = [Math]::Max($maxX - $minX + 1, $maxY - $minY + 1) * $scale * (1 + 2 * $Padding)
  }

  "Source:     $($src.Width) x $($src.Height)"
  "Artwork:    centered at ($([int]$cx), $([int]$cy)), cropping a $([int]$side) px square"
  "Background: #{0:x2}{1:x2}{2:x2}" -f $bg.R, $bg.G, $bg.B
  Save-Icon 32  'icon-32.png'          $true
  Save-Icon 192 'icon-192.png'         $true    # sidebar, chat avatar
  Save-Icon 320 'icon-320.png'         $true    # welcome screen
  Save-Icon 512 'icon-512.png'         $true
  Save-Icon 180 'apple-touch-icon.png' $false   # iOS rounds the corners itself
}
finally {
  $attrs.Dispose()
  $src.Dispose()
}
