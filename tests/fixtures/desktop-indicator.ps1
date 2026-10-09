param([Parameter(Mandatory = $true)][string]$ScriptPath,
      [Parameter(Mandatory = $true)][long]$TargetHandle,
      [int]$TargetProcessId = 0,
      [ValidateSet('inspect', 'preparePulse', 'verifyPulse')][string]$Mode = 'inspect')
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing
# Only this known synthetic Electron window is inspected/captured or prepared for the production gesture.
Add-Type @'
using System;
using System.Text;
using System.Runtime.InteropServices;
public static class StagIndicatorFixture {
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] private static extern int GetWindowText(IntPtr window, StringBuilder text, int count);
    public static string Title(IntPtr window) { var text = new StringBuilder(256); GetWindowText(window, text, text.Capacity); return text.ToString(); }
}
'@
$target = [IntPtr]$TargetHandle
if ([StagIndicatorFixture]::Title($target) -cne 'STAG Plus synthetic indicator target') {
    throw 'Synthetic target unavailable; no capture performed.'
}
$tokens = $null
$parseErrors = $null
$ast = [System.Management.Automation.Language.Parser]::ParseFile($ScriptPath, [ref]$tokens, [ref]$parseErrors)
if ($parseErrors.Count -gt 0) { throw 'Production driver parse failed.' }
$definition = $ast.Find({ param($node)
    $node -is [System.Management.Automation.Language.StringConstantExpressionAst] -and
    $node.Value.Contains('public static class StagWindow')
}, $true)
Add-Type -TypeDefinition $definition.Value -ReferencedAssemblies System,System.Drawing
[void][StagWindow]::SetProcessDPIAware()
if ([StagWindow]::GetForegroundWindow() -ne $target) { throw 'Indicator took foreground away from fixture.' }
$bounds = [StagWindow]::Bounds($target)
if ($Mode -ne 'inspect') {
    if ($TargetProcessId -le 0 -or [StagWindow]::WindowProcessId($target) -ne $TargetProcessId -or
        [StagWindow]::ButtonsPressed()) { throw 'Synthetic pulse target unavailable.' }
    $x = $bounds[0] + [int]($bounds[2] * 0.75)
    $y = $bounds[1] + [int]($bounds[3] / 2)
    if ([StagWindow]::GetAncestor([StagWindow]::WindowAt($x, $y), 2) -ne $target) {
        throw 'Synthetic pulse target overlapped; no input.'
    }
    if ($Mode -eq 'preparePulse') {
        if (-not [StagWindow]::SetCursorPos($x, $y)) { throw 'Synthetic cursor preparation failed.' }
        '{"ready":true}'
    } else {
        $cursor = [StagWindow]::Cursor()
        if ($cursor[0] -ne $x -or $cursor[1] -ne $y) { throw 'Production gesture did not restore cursor.' }
        '{"restored":true}'
    }
    return
}
$points = @(@(2, [int]($bounds[3] / 2)), @(($bounds[2] - 3), [int]($bounds[3] / 2)),
            @([int]($bounds[2] / 2), 2), @([int]($bounds[2] / 2), ($bounds[3] - 3)),
            @([int]($bounds[2] / 2), [int]($bounds[3] / 2)))
foreach ($point in $points) {
    $at = [StagWindow]::WindowAt(($bounds[0] + $point[0]), ($bounds[1] + $point[1]))
    if ([StagWindow]::GetAncestor($at, 2) -ne $target) { throw 'Indicator blocks coordinate targeting.' }
}
if ([StagIndicatorFixture]::Title($target) -cne 'STAG Plus synthetic indicator target') { throw 'Synthetic target changed.' }
$bytes = [Convert]::FromBase64String([StagWindow]::Capture($target))
$stream = [IO.MemoryStream]::new($bytes)
$image = $null
try {
    $image = [Drawing.Bitmap]::FromStream($stream)
    foreach ($point in $points) {
        $pixel = $image.GetPixel($point[0], $point[1])
        if ($pixel.B -gt $pixel.R + 50) { throw 'Indicator leaked into target capture.' }
    }
} finally {
    if ($image) { $image.Dispose() }
    $stream.Dispose()
}
'{"hitTarget":true,"foreground":true,"captureIsolated":true}'
