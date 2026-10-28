# imagetool.ps1 — the image work Feeder does with `sips` on macOS, for Windows (System.Drawing).
#
#   imagetool.ps1 resize <src> <out.jpg> <maxSize> <quality>   shrink to fit maxSize × maxSize, save as JPEG
#   imagetool.ps1 rotate <degrees> <file>...                    rotate clockwise in place (90, -90, 180)
#   imagetool.ps1 size <file>                                   prints {"width":…,"height":…}
#   imagetool.ps1 crop <file>                                   trims the feeder background off a card scan in place,
#                                                               prints {"cropped":true|false,"width":…,"height":…}

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing

# A pixel loop is far too slow in PowerShell, so the card search is compiled.
Add-Type -ReferencedAssemblies System.Drawing -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Drawing;
using System.Drawing.Imaging;
using System.Runtime.InteropServices;

public static class CardFinder {
    // The card's bounding box as {x, y, width, height}, or null when there's no clear background around it.
    // Background is the feeder's gray (sampled from the outer columns) and the white the driver fills in after the card.
    public static int[] Find(Bitmap bitmap) {
        int w = bitmap.Width, h = bitmap.Height;
        BitmapData data = bitmap.LockBits(new Rectangle(0, 0, w, h), ImageLockMode.ReadOnly, PixelFormat.Format24bppRgb);
        int stride = data.Stride;
        byte[] px = new byte[stride * h];
        Marshal.Copy(data.Scan0, px, 0, px.Length);
        bitmap.UnlockBits(data);

        List<int> rs = new List<int>(), gs = new List<int>(), bs = new List<int>();
        int[] edges = { 0, 1, 2, w - 3, w - 2, w - 1 };
        for (int y = 0; y < h; y += 2) {
            foreach (int x in edges) {
                int i = y * stride + x * 3;
                if (IsWhite(px, i)) continue;
                bs.Add(px[i]); gs.Add(px[i + 1]); rs.Add(px[i + 2]);
            }
        }
        if (rs.Count < 20) return null;
        int br = Median(rs), bg = Median(gs), bb = Median(bs);

        int[] rowCount = new int[h], colCount = new int[w];
        for (int y = 0; y < h; y++) {
            for (int x = 0; x < w; x++) {
                int i = y * stride + x * 3;
                if (IsWhite(px, i)) continue;
                if (Math.Abs(px[i + 2] - br) + Math.Abs(px[i + 1] - bg) + Math.Abs(px[i] - bb) <= 60) continue;
                rowCount[y]++;
                colCount[x]++;
            }
        }
        // A row or column is card when a good part of it is; stray dust and gray art don't count.
        int top = First(rowCount, w / 4), bottom = Last(rowCount, w / 4);
        int left = First(colCount, h / 4), right = Last(colCount, h / 4);
        if (top < 0 || left < 0) return null;
        return new int[] { left, top, right - left + 1, bottom - top + 1 };
    }

    static bool IsWhite(byte[] px, int i) { return px[i] >= 250 && px[i + 1] >= 250 && px[i + 2] >= 250; }

    static int Median(List<int> values) { values.Sort(); return values[values.Count / 2]; }

    static int First(int[] counts, int min) {
        for (int i = 0; i < counts.Length; i++) if (counts[i] > min) return i;
        return -1;
    }

    static int Last(int[] counts, int min) {
        for (int i = counts.Length - 1; i >= 0; i--) if (counts[i] > min) return i;
        return -1;
    }
}
'@

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
    'crop' {
        $file = $args[1]
        $image = Open-Image $file
        $bitmap = New-Object System.Drawing.Bitmap $image
        $box = [CardFinder]::Find($bitmap)
        # Keep the scan as it is unless what's left is card-shaped (63 × 88 mm, a little wider when fed crooked).
        $ok = $false
        if ($box) {
            $short = [Math]::Min($box[2], $box[3]); $long = [Math]::Max($box[2], $box[3])
            $ok = $short / $long -gt 0.6 -and $short / $long -lt 0.85 -and $box[2] * $box[3] -gt 0.25 * $bitmap.Width * $bitmap.Height `
                -and ($box[2] -lt $bitmap.Width -or $box[3] -lt $bitmap.Height)
        }
        if ($ok) {
            $card = $bitmap.Clone((New-Object System.Drawing.Rectangle $box[0], $box[1], $box[2], $box[3]), $bitmap.PixelFormat)
            Save-Image $card $file 92
            '{{"cropped":true,"width":{0},"height":{1}}}' -f $card.Width, $card.Height
        } else {
            '{{"cropped":false,"width":{0},"height":{1}}}' -f $bitmap.Width, $bitmap.Height
        }
    }
    default {
        [Console]::Error.WriteLine('usage: imagetool.ps1 resize | rotate | size | crop')
        exit 2
    }
}
