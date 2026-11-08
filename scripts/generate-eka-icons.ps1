# Generates the EKA launcher artwork for every Android density.
# Run from the repository root: powershell -NoProfile -File scripts/generate-eka-icons.ps1
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing

$root = Split-Path -Parent $PSScriptRoot
$res = Join-Path $root 'android\app\src\main\res'

function New-RoundedPath([float]$x, [float]$y, [float]$w, [float]$h, [float]$r) {
    $path = New-Object System.Drawing.Drawing2D.GraphicsPath
    $d = [Math]::Min($r * 2, [Math]::Min($w, $h))
    $path.AddArc($x, $y, $d, $d, 180, 90)
    $path.AddArc($x + $w - $d, $y, $d, $d, 270, 90)
    $path.AddArc($x + $w - $d, $y + $h - $d, $d, $d, 0, 90)
    $path.AddArc($x, $y + $h - $d, $d, $d, 90, 90)
    $path.CloseFigure()
    return $path
}

function Add-EkaMark($graphics, [float]$size, [float]$scale, [bool]$withBackground, [bool]$round) {
    $graphics.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
    $graphics.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality

    if ($withBackground) {
        $rect = New-Object System.Drawing.RectangleF 0, 0, $size, $size
        $brush = New-Object System.Drawing.Drawing2D.LinearGradientBrush $rect, ([System.Drawing.Color]::FromArgb(255, 255, 95, 162)), ([System.Drawing.Color]::FromArgb(255, 109, 77, 240)), 45
        if ($round) {
            $graphics.FillEllipse($brush, 0, 0, $size, $size)
        } else {
            $path = New-RoundedPath 0 0 $size $size ($size * 0.22)
            $graphics.FillPath($brush, $path)
            $path.Dispose()
        }
        # Soft top-left light bloom.
        $bloom = New-Object System.Drawing.Drawing2D.GraphicsPath
        $bloom.AddEllipse(-$size * 0.12, -$size * 0.2, $size * 0.82, $size * 0.72)
        $bloomBrush = New-Object System.Drawing.Drawing2D.PathGradientBrush $bloom
        $bloomBrush.CenterColor = [System.Drawing.Color]::FromArgb(150, 255, 255, 255)
        $bloomBrush.SurroundColors = @([System.Drawing.Color]::FromArgb(0, 255, 255, 255))
        $graphics.FillPath($bloomBrush, $bloom)
        $bloomBrush.Dispose()
        $bloom.Dispose()
        $brush.Dispose()
    }

    $content = $size * $scale
    $offset = ($size - $content) / 2
    $s = $content
    $white = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(250, 255, 255, 255))
    $glass = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(235, 255, 247, 252))

    # Letter E: one spine and three rounded arms.
    $left = $offset + ($s * 0.25)
    $top = $offset + ($s * 0.24)
    $spineW = $s * 0.13
    $armW = $s * 0.48
    $barH = $s * 0.13
    $bars = @(
        @($left, $top, $spineW, ($s * 0.52)),
        @($left, $top, $armW, $barH),
        @($left, ($offset + $s * 0.435), ($s * 0.35), ($s * 0.12)),
        @($left, ($offset + $s * 0.63), $armW, $barH)
    )
    foreach ($bar in $bars) {
        $path = New-RoundedPath $bar[0] $bar[1] $bar[2] $bar[3] ($s * 0.065)
        $graphics.FillPath($white, $path)
        $path.Dispose()
    }

    # Glass highlight across the top arm.
    $highlight = New-RoundedPath ($offset + $s * 0.29) ($offset + $s * 0.275) ($s * 0.38) ($s * 0.032) ($s * 0.016)
    $graphics.FillPath($glass, $highlight)
    $highlight.Dispose()

    # Coral signature dot.
    $dot = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(255, 255, 138, 107))
    $graphics.FillEllipse($dot, $offset + $s * 0.68, $offset + $s * 0.20, $s * 0.12, $s * 0.12)
    $dotGlow = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(150, 255, 255, 255))
    $graphics.FillEllipse($dotGlow, $offset + $s * 0.705, $offset + $s * 0.225, $s * 0.04, $s * 0.04)

    $dot.Dispose()
    $dotGlow.Dispose()
    $white.Dispose()
    $glass.Dispose()
}

$legacy = @{ 'mdpi' = 48; 'hdpi' = 72; 'xhdpi' = 96; 'xxhdpi' = 144; 'xxxhdpi' = 192 }
$foreground = @{ 'mdpi' = 108; 'hdpi' = 162; 'xhdpi' = 216; 'xxhdpi' = 324; 'xxxhdpi' = 432 }

foreach ($density in $legacy.Keys) {
    $size = $legacy[$density]
    $dir = Join-Path $res ("mipmap-" + $density)
    New-Item -ItemType Directory -Force -Path $dir | Out-Null

    $square = New-Object System.Drawing.Bitmap $size, $size
    $g = [System.Drawing.Graphics]::FromImage($square)
    $g.Clear([System.Drawing.Color]::Transparent)
    Add-EkaMark $g $size 0.62 $true $false
    $square.Save((Join-Path $dir 'ic_launcher.png'), [System.Drawing.Imaging.ImageFormat]::Png)
    $g.Dispose(); $square.Dispose()

    $round = New-Object System.Drawing.Bitmap $size, $size
    $g = [System.Drawing.Graphics]::FromImage($round)
    $g.Clear([System.Drawing.Color]::Transparent)
    Add-EkaMark $g $size 0.62 $true $true
    $round.Save((Join-Path $dir 'ic_launcher_round.png'), [System.Drawing.Imaging.ImageFormat]::Png)
    $g.Dispose(); $round.Dispose()

    $fgSize = $foreground[$density]
    $fg = New-Object System.Drawing.Bitmap $fgSize, $fgSize
    $g = [System.Drawing.Graphics]::FromImage($fg)
    $g.Clear([System.Drawing.Color]::Transparent)
    Add-EkaMark $g $fgSize 0.60 $false $false
    $fg.Save((Join-Path $dir 'ic_launcher_foreground.png'), [System.Drawing.Imaging.ImageFormat]::Png)
    $g.Dispose(); $fg.Dispose()
}

Write-Host 'EKA launcher icons generated.'
