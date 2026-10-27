# imagetool.ps1 — the image work Feeder does with `sips` on macOS, for Windows (System.Drawing).
#
#   imagetool.ps1 resize <src> <out.jpg> <maxSize> <quality>   shrink to fit maxSize × maxSize, save as JPEG
#   imagetool.ps1 rotate <degrees> <file>...                    rotate clockwise in place (90, -90, 180)
#   imagetool.ps1 size <file>                                   prints {"width":…,"height":…}

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing

# Loads through memory so the file isn't locked and can be overwritten.
function Open-Image([string]$path) {
    $stream = New-Object System.IO.MemoryStream (, [System.IO.File]::ReadAllBytes($path))
    [System.Drawing.Image]::FromStream($stream)
}

function Save-Image($image, [string]$path, [int]$quality) {
    if ([System.IO.Path]::GetExtension($path) -eq '.png') {
        $image.Save($path, [System.Drawing.Imaging.ImageFormat]::Png)
        return
    }
    $codec = [System.Drawing.Imaging.ImageCodecInfo]::GetImageEncoders() | Where-Object { $_.MimeType -eq 'image/jpeg' }
    $params = New-Object System.Drawing.Imaging.EncoderParameters 1
    $params.Param[0] = New-Object System.Drawing.Imaging.EncoderParameter ([System.Drawing.Imaging.Encoder]::Quality, [long]$quality)
    $image.Save($path, $codec, $params)
}

$command = [string]$args[0]
switch ($command) {
    'resize' {
        $src, $out, $max, $quality = $args[1], $args[2], [int]$args[3], [int]$args[4]
        $image = Open-Image $src
        $scale = [Math]::Min(1.0, $max /[Math]::Max($image.Width, $image.Height))
        $width = [Math]::Max(1, [int]($image.Width * $scale))
        $height = [Math]::Max(1, [int]($image.Height * $scale))
        $small = New-Object System.Drawing.Bitmap $width, $height
        $graphics = [System.Drawing.Graphics]::FromImage($small)
        $graphics.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
        $graphics.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
        $graphics.Clear([System.Drawing.Color]::White)
        $graphics.DrawImage($image, 0, 0, $width, $height)
        $graphics.Dispose()
        Save-Image $small $out $quality
    }
    'rotate' {
        $flip = switch ([int]$args[1]) {
            90 { [System.Drawing.RotateFlipType]::Rotate90FlipNone }
            -90 { [System.Drawing.RotateFlipType]::Rotate270FlipNone }
            180 { [System.Drawing.RotateFlipType]::Rotate180FlipNone }
            default { throw "Unsupported rotation: $($args[1])" }
        }
        foreach ($file in $args[2..($args.Count - 1)]) {
            $image = Open-Image $file
            $image.RotateFlip($flip)
            Save-Image $image $file 92
            $image.Dispose()
        }
    }
    'size' {
        $image = Open-Image $args[1]
        '{{"width":{0},"height":{1}}}' -f $image.Width, $image.Height
    }
    default {
        [Console]::Error.WriteLine('usage: imagetool.ps1 resize | rotate | size')
        exit 2
    }
}
