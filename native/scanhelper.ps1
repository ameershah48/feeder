# scanhelper.ps1 — bridges the Feeder web server to Windows Image Acquisition (WIA).
# The Windows counterpart of scanhelper.swift: same commands, same JSON events.
#
#   scanhelper.ps1 list
#   scanhelper.ps1 info [--device <id|name>]
#   scanhelper.ps1 scan --out <dir> [--device <id|name>] [--resolution 300]
#                       [--mode color|gray|bw] [--paper a4|letter|legal|tcg]
#                       [--source feeder|flatbed] [--duplex]
#
# Every command writes newline-delimited JSON events to stdout.
# Run it with: powershell -NoProfile -ExecutionPolicy Bypass -STA -File scanhelper.ps1 <command> ...

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding $false

# ---------------------------------------------------------------------------
# Output

function Emit($event) {
    [Console]::Out.WriteLine(($event | ConvertTo-Json -Compress -Depth 5))
    [Console]::Out.Flush()
}

function Fail([string]$message) {
    Emit @{ type = 'error'; message = $message }
    exit 1
}

# ---------------------------------------------------------------------------
# Arguments

$command = if ($args.Count) { [string]$args[0] } else { '' }
$opts = @{}
$duplexFlag = $false
for ($i = 1; $i -lt $args.Count; $i++) {
    $arg = [string]$args[$i]
    if ($arg -eq '--duplex') { $duplexFlag = $true }
    elseif ($arg.StartsWith('--') -and $i + 1 -lt $args.Count) { $opts[$arg.Substring(2)] = [string]$args[++$i] }
}

# ---------------------------------------------------------------------------
# WIA constants (wiadef.h)

$WIA_DPS_DOCUMENT_HANDLING_CAPABILITIES = 3086
$WIA_DPS_DOCUMENT_HANDLING_STATUS = 3087
$WIA_DPS_DOCUMENT_HANDLING_SELECT = 3088
$WIA_DPS_SHEET_FEEDER_REGISTRATION = 3078
$WIA_DPS_HORIZONTAL_SHEET_FEED_SIZE = 3076
$WIA_DPS_VERTICAL_SHEET_FEED_SIZE = 3077
$WIA_IPA_DATATYPE = 4103
$WIA_IPA_DEPTH = 4104
$WIA_IPA_FORMAT = 4106
$WIA_IPS_XRES = 6147
$WIA_IPS_YRES = 6148
$WIA_IPS_XPOS = 6149
$WIA_IPS_YPOS = 6150
$WIA_IPS_XEXTENT = 6151
$WIA_IPS_YEXTENT = 6152

$FEEDER = 1; $FLATBED = 2; $DUPLEX = 4; $FEED_READY = 1

$FORMAT_JPEG = '{B96B3CAE-0728-11D3-9D7B-0000F81EF32E}'
$FORMAT_PNG = '{B96B3CAF-0728-11D3-9D7B-0000F81EF32E}'

# ---------------------------------------------------------------------------
# Property helpers

function Get-Prop($props, [int]$id) {
    foreach ($p in $props) { if ($p.PropertyID -eq $id) { return $p } }
    $null
}

function Get-Value($props, [int]$id) {
    $p = Get-Prop $props $id
    if ($p) { $p.Value } else { $null }
}

function Get-Choices($p) {
    switch ($p.SubType) {
        1 { @($p.SubTypeMin, $p.SubTypeMax) }
        2 { @($p.SubTypeValues) }
        default { @() }
    }
}

# The allowed value closest to $value: clamped to a range, or the nearest entry of a list.
function Get-Allowed($p, $value) {
    switch ($p.SubType) {
        1 { [Math]::Min([Math]::Max($value, $p.SubTypeMin), $p.SubTypeMax) }
        2 { @($p.SubTypeValues) | Sort-Object { [Math]::Abs($_ - $value) } | Select-Object -First 1 }
        default { $value }
    }
}

# Sets a property if the driver has it and accepts the value. Returns whether it worked.
function Set-Prop($props, [int]$id, $value, [switch]$Nearest) {
    $p = Get-Prop $props $id
    if (-not $p) { return $false }
    if ($Nearest) { $value = Get-Allowed $p $value }
    try { $p.Value = $value; $true } catch { $false }
}

# ---------------------------------------------------------------------------
# Device discovery

function Get-Scanners {
    $manager = New-Object -ComObject WIA.DeviceManager
    foreach ($info in $manager.DeviceInfos) { if ($info.Type -eq 1) { $info } } # 1 = ScannerDeviceType
}

function Describe($info) {
    $port = [string](Get-Value $info.Properties 6)
    $name = [string](Get-Value $info.Properties 7)
    $transport = if ($port -match 'usbscan' -or $name -match '\(USB\)') { 'USB' } elseif ($port) { 'Network' } else { '' }
    @{ id = $info.DeviceID; name = $(if ($name) { $name } else { 'Scanner' }); transport = $transport }
}

function Find-Scanner([string]$query) {
    $all = @(Get-Scanners)
    if (-not $query) { if ($all.Count) { return $all[0] } }
    else {
        foreach ($info in $all) {
            if ($info.DeviceID -eq $query -or (Describe $info).name -eq $query) { return $info }
        }
        Fail "Scanner `"$query`" was not found. Check that it is plugged in and switched on."
    }
    Fail 'No scanner found. Check that it is plugged in and switched on.'
}

# WIA 2.0 drivers can expose separate Feeder and Flatbed items; older ones a single scan item.
function Select-Item($device, [string]$source) {
    $items = @($device.Items)
    if (-not $items.Count) { Fail 'The scanner driver did not offer anything to scan from.' }
    $wanted = if ($source -eq 'flatbed') { 'flatbed' } else { 'feeder' }
    foreach ($item in $items) {
        if ([string](Get-Value $item.Properties 4098) -match $wanted) { return $item }
    }
    $items[0]
}

# ---------------------------------------------------------------------------
# Errors

function Get-HResult($errorRecord) {
    $e = $errorRecord.Exception
    while ($e.InnerException) { $e = $e.InnerException }
    '{0:X8}' -f $e.HResult
}

function Explain($errorRecord, [string]$fallback) {
    $code = Get-HResult $errorRecord
    switch ($code) {
        '80210002' { return 'The paper jammed. Clear the feeder and try again.' }
        '80210004' { return 'There is a problem with the paper in the feeder. Reload it and try again.' }
        '80210005' { return 'The scanner is offline. Check that it is plugged in and switched on.' }
        '80210006' { return 'The scanner is in use by another app. Close HP Scan or Windows Scan and try again.' }
        '80210007' { return 'The scanner is warming up. Try again in a moment.' }
        '80210008' { return 'The scanner needs attention. Check its display, cover and feeder.' }
        '80210009' { return 'The scanner was disconnected.' }
        '8021000A' { return 'The scanner did not respond. Try switching it off and on again.' }
        '8021000D' { return 'The scanner is locked. Unlock it and try again.' }
        '80210015' { return 'No scanner found. Check that it is plugged in and switched on.' }
        '80210016' { return 'The scanner cover is open. Close it and try again.' }
    }
    $message = $errorRecord.Exception.Message
    if ($message) { "${fallback}: $message (error 0x$code)" } else { "$fallback (error 0x$code)." }
}

# ---------------------------------------------------------------------------
# Scanning

# Page sizes in inches. A trading card is 63 × 88 mm; 5 mm on every side keeps a skewed card from being clipped.
$PAPER = @{
    a4     = @(8.27, 11.69)
    letter = @(8.5, 11)
    legal  = @(8.5, 14)
    tcg    = @((73 / 25.4), (98 / 25.4))
}

function Configure($device, $item, $settings) {
    $props = $item.Properties

    switch ($settings.mode) {
        'bw'    { $type = 0; $depth = 1 }
        'gray'  { $type = 2; $depth = 8 }
        default { $type = 3; $depth = 24 }
    }
    [void](Set-Prop $props $WIA_IPA_DATATYPE $type)
    [void](Set-Prop $props $WIA_IPA_DEPTH $depth)

    # Extents are in pixels, so the resolution has to be set first.
    [void](Set-Prop $props $WIA_IPS_XRES $settings.resolution -Nearest)
    [void](Set-Prop $props $WIA_IPS_YRES $settings.resolution -Nearest)
    $resolution = [int](Get-Value $props $WIA_IPS_XRES)

    $inches = $PAPER[$settings.paper]
    if (-not $inches) { $inches = $PAPER.a4 }
    $xExtent = Get-Prop $props $WIA_IPS_XEXTENT
    $fullWidth = if ($xExtent -and $xExtent.SubType -eq 1) { [int]$xExtent.SubTypeMax } else { [int]($inches[0] * $resolution) }
    $width = [Math]::Min([int]($inches[0] * $resolution), $fullWidth)
    $height = [int]($inches[1] * $resolution)

    # Narrow pages sit in the middle (or on one side) of the feeder; the driver says which.
    $x = 0
    if ($settings.feeder) {
        switch (Get-Value $device.Properties $WIA_DPS_SHEET_FEEDER_REGISTRATION) {
            1 { $x = [int](($fullWidth - $width) / 2) }
            2 { $x = $fullWidth - $width }
        }
    }
    [void](Set-Prop $props $WIA_IPS_XPOS $x -Nearest)
    [void](Set-Prop $props $WIA_IPS_YPOS 0 -Nearest)
    [void](Set-Prop $props $WIA_IPS_XEXTENT $width -Nearest)
    [void](Set-Prop $props $WIA_IPS_YEXTENT $height -Nearest)

    if ($settings.paper -eq 'tcg' -and $width -lt [int]($inches[0] * $resolution)) {
        Emit @{ type = 'warning'; message = 'This scanner could not narrow its scan area to a card, so its full width is used.' }
    }
    $resolution
}

# WIA drivers often only deliver BMP; convert to what the server expects.
function Convert-Image($image, [string]$formatId) {
    if ($image.FormatID -eq $formatId) { return $image }
    $process = New-Object -ComObject WIA.ImageProcess
    $process.Filters.Add($process.FilterInfos.Item('Convert').FilterID)
    $process.Filters.Item(1).Properties.Item('FormatID').Value = $formatId
    if ($formatId -eq $FORMAT_JPEG) { $process.Filters.Item(1).Properties.Item('Quality').Value = 92 }
    $process.Apply($image)
}

function Open-Device($info) {
    $name = (Describe $info).name
    Emit @{ type = 'status'; message = "Connecting to $name…"; device = (Describe $info) }
    try { $info.Connect() } catch { Fail (Explain $_ 'Could not connect to the scanner') }
}

function Invoke-Scan($settings) {
    $info = Find-Scanner $settings.device
    $device = Open-Device $info

    $caps = [int](Get-Value $device.Properties $WIA_DPS_DOCUMENT_HANDLING_CAPABILITIES)
    $settings.feeder = ($caps -band $FEEDER) -and -not ($settings.source -eq 'flatbed' -and ($caps -band $FLATBED))
    # Not $duplex: PowerShell names ignore case, so that would overwrite the $DUPLEX flag below with $true.
    $twoSided = $settings.feeder -and $settings.duplex -and ($caps -band $DUPLEX)
    $item = Select-Item $device $(if ($settings.feeder) { 'feeder' } else { 'flatbed' })

    $select = if ($settings.feeder) { $FEEDER } else { $FLATBED }
    if ($twoSided) { $select = $select -bor $DUPLEX }
    if (-not (Set-Prop $device.Properties $WIA_DPS_DOCUMENT_HANDLING_SELECT $select)) {
        [void](Set-Prop $item.Properties $WIA_DPS_DOCUMENT_HANDLING_SELECT $select) # WIA 2.0 keeps it on the item
    }
    if ($settings.duplex -and -not $twoSided) {
        Emit @{ type = 'warning'; message = 'This scanner can only scan one side here, so only the fronts are scanned.' }
    }
    # Leave WIA_DPS_PAGES alone: each Transfer() returns one side (front, then back when two-sided),
    # and the ScanJet Pro 2000 rejects any other value with 0x80070057 at the first Transfer().

    $resolution = Configure $device $item $settings
    $formatId = if ($settings.mode -eq 'bw') { $FORMAT_PNG } else { $FORMAT_JPEG }
    $extension = if ($settings.mode -eq 'bw') { 'png' } else { 'jpg' }
    $transferFormat = [string](Get-Value $item.Properties $WIA_IPA_FORMAT)

    Emit @{ type = 'status'; message = 'Scanning…'; resolution = $resolution; duplex = [bool]$twoSided }

    $pages = 0
    while ($true) {
        try {
            $image = if ($transferFormat) { $item.Transfer($transferFormat) } else { $item.Transfer() }
        } catch {
            if ((Get-HResult $_) -eq '80210003') { break } # feeder is empty
            $message = Explain $_ 'The scan did not complete'
            if ($pages -eq 0) { Fail $message }
            Emit @{ type = 'warning'; message = $message }
            break
        }
        $pages++
        $file = Join-Path $settings.outDir ('page-{0:D4}.{1}' -f $pages, $extension)
        (Convert-Image $image $formatId).SaveFile($file)
        Emit @{ type = 'page'; path = $file; index = $pages; resolution = $resolution }
        if (-not $settings.feeder) { break }
        Emit @{ type = 'status'; message = "Scanning page $($pages + 1)…" }
    }

    if ($pages -eq 0) { Fail 'No pages were scanned. Check that paper is loaded in the feeder.' }
    Emit @{ type = 'done'; pages = $pages; cancelled = $false }
}

function Invoke-Info($settings) {
    $info = Find-Scanner $settings.device
    $device = Open-Device $info
    $caps = [int](Get-Value $device.Properties $WIA_DPS_DOCUMENT_HANDLING_CAPABILITIES)
    $status = [int](Get-Value $device.Properties $WIA_DPS_DOCUMENT_HANDLING_STATUS)
    $item = Select-Item $device 'feeder'

    $units = @()
    if ($caps -band $FEEDER) { $units += 'feeder' }
    if ($caps -band $FLATBED) { $units += 'flatbed' }

    $xres = Get-Prop $item.Properties $WIA_IPS_XRES
    $depth = Get-Prop $item.Properties $WIA_IPA_DEPTH
    $properties = [ordered]@{}
    foreach ($p in $item.Properties) { $properties["$($p.PropertyID) $($p.Name)"] = [string]$p.Value }

    Emit ([ordered]@{
        type               = 'info'
        device             = (Describe $info)
        units              = $units
        resolutions        = $(if ($xres) { Get-Choices $xres } else { @() })
        bitDepths          = $(if ($depth) { Get-Choices $depth } else { @() })
        physicalSizeInches = @(
            ([double](Get-Value $device.Properties $WIA_DPS_HORIZONTAL_SHEET_FEED_SIZE) / 1000),
            ([double](Get-Value $device.Properties $WIA_DPS_VERTICAL_SHEET_FEED_SIZE) / 1000))
        supportsDuplex     = [bool]($caps -band $DUPLEX)
        documentLoaded     = [bool]($status -band $FEED_READY)
        itemProperties     = $properties
    })
}

# ---------------------------------------------------------------------------
# Main

switch ($command) {
    'list' {
        $devices = @(Get-Scanners | ForEach-Object { Describe $_ })
        Emit @{ type = 'devices'; devices = $devices }
    }
    { $_ -in 'scan', 'info' } {
        $settings = @{
            device     = $opts.device
            resolution = $(if ($opts.resolution) { [int]$opts.resolution } else { 300 })
            mode       = $(if ($opts.mode) { $opts.mode } else { 'color' })
            paper      = $(if ($opts.paper) { $opts.paper } else { 'a4' })
            source     = $(if ($opts.source) { $opts.source } else { 'feeder' })
            duplex     = $duplexFlag
            outDir     = $opts.out
            feeder     = $true
        }
        Emit @{ type = 'status'; message = 'Looking for scanner…' }
        if ($command -eq 'info') { Invoke-Info $settings; break }
        if (-not $settings.outDir) { Fail 'Missing --out <dir>' }
        [void](New-Item -ItemType Directory -Force -Path $settings.outDir)
        Invoke-Scan $settings
    }
    default {
        [Console]::Error.WriteLine('usage: scanhelper.ps1 list | info | scan --out <dir>')
        exit 2
    }
}
exit 0
