param([Parameter(Mandatory = $true)][string]$ScriptPath)
$ErrorActionPreference = 'Stop'
$ScriptPath = (Resolve-Path $ScriptPath).Path

# No P/Invoke: the real dispatcher runs with synthetic windows, processes, certificates and pixels.
Write-Output 'Native desktop harness: compiling synthetic boundaries.'
Add-Type @'
using System;
using System.Collections.Generic;
public static class StagWindow {
    public static List<string> Events = new List<string>();
    public static bool BlockFocus, ChangeAfterMove, ChangeAfterCapture, MoveAfterCapture;
    public static bool LoseFocusAfterMove, ChangeProcessAfterFocus, ChangeAfterFirstClick;
    public static int LoseFocusAfterKeys;
    public static IntPtr HitWindow = new IntPtr(4242);
    public static IntPtr Foreground = new IntPtr(4242);
    public static bool SetProcessDPIAware() { return true; }
    public static bool IsWindowVisible(IntPtr window) { return window != IntPtr.Zero; }
    public static uint WindowProcessId(IntPtr window) { return (uint)window.ToInt64(); }
    public static IntPtr GetAncestor(IntPtr window, uint flags) { return window; }
    public static IntPtr WindowAt(int x, int y) { return HitWindow; }
    public static int[] Bounds(IntPtr window) {
        return new int[] { MoveAfterCapture && Events.Contains("capture:" + window) ? -190 : -200, 0, 800, 600 };
    }
    public static string Capture(IntPtr window) {
        Events.Add("capture:" + window);
        return "aW1hZ2VtLXNpbnRldGljYQ==";
    }
    public static bool ShowWindow(IntPtr window, int command) { return true; }
    public static bool SetForegroundWindow(IntPtr window) {
        Events.Add("focus:" + window);
        if (!BlockFocus) Foreground = window;
        return !BlockFocus;
    }
    public static IntPtr GetForegroundWindow() { return BlockFocus ? IntPtr.Zero : Foreground; }
    public static int GetSystemMetrics(int index) {
        switch (index) { case 76: return -1920; case 77: return 0; case 78: return 3840; case 79: return 1080; }
        throw new Exception("Unexpected metric");
    }
    public static bool SetCursorPos(int x, int y) {
        Events.Add("cursor:" + x + "," + y);
        if (ChangeAfterMove) HitWindow = new IntPtr(9001);
        if (LoseFocusAfterMove) Foreground = new IntPtr(9001);
        return true;
    }
    public static void mouse_event(uint flags, uint dx, uint dy, uint data, UIntPtr extra) {
        Events.Add("mouse:" + flags + ":" + data);
        if (ChangeAfterFirstClick && (flags == 4 || flags == 16 || flags == 64)) HitWindow = new IntPtr(9001);
    }
}
public class StagCertificate {
    private string name;
    public StagCertificate(string name) { this.name = name; }
    public string GetNameInfo(System.Security.Cryptography.X509Certificates.X509NameType type, bool issuer) { return name; }
}
namespace System.Windows.Forms {
    public static class SendKeys {
        public static void SendWait(string text) {
            StagWindow.Events.Add("keys:" + text);
            if (StagWindow.LoseFocusAfterKeys > 0 && --StagWindow.LoseFocusAfterKeys == 0)
                StagWindow.Foreground = new IntPtr(9001);
        }
    }
}
'@

# Shadow every desktop boundary: never enumerate real processes/certificates or load graphical APIs.
function Add-Type {
    param([string]$TypeDefinition, [string]$AssemblyName, [string[]]$ReferencedAssemblies)
    if ($AssemblyName -in @('System.Windows.Forms', 'System.Drawing')) { return }
    if ($TypeDefinition -and $TypeDefinition.Contains('public static class StagWindow')) { return }
    throw 'Unexpected native dependency in desktop test.'
}
$global:StagProcesses = @{}
$global:StagSignatures = @{}
function Add-SyntheticProcess([int]$processId, [string]$name, [string]$product, [string]$publisher) {
    $path = [IO.Path]::Combine([IO.Path]::GetTempPath(), 'stag-synthetic', ($name + '.exe'))
    $global:StagProcesses[$processId] = [pscustomobject]@{
        Id = $processId; MainWindowHandle = [IntPtr]$processId; MainWindowTitle = "Synthetic $product";
        ProcessName = $name; Path = $path; StartTime = [datetime]'2026-01-01';
        FileVersionInfo = [pscustomobject]@{ ProductName = $product }
    }
    $global:StagSignatures[$path] = [pscustomobject]@{ Status = 'Valid'; SignerCertificate = [StagCertificate]::new($publisher) }
}
Add-SyntheticProcess 4242 'Postman' 'Postman' 'Postman, Inc'
Add-SyntheticProcess 5252 'idea64' 'IntelliJ IDEA' 'JetBrains s.r.o.'
Add-SyntheticProcess 6262 'Code' 'Visual Studio Code' 'Microsoft Corporation'
Add-SyntheticProcess 9001 'chrome' 'Postman' 'Postman, Inc'
Add-SyntheticProcess 9002 'notepad' 'IntelliJ IDEA' 'Microsoft Corporation'
Add-SyntheticProcess 9003 'explorer' 'Visual Studio Code' 'Microsoft Corporation'
function Get-Process {
    param([int]$Id, [string]$ErrorAction)
    if (-not $Id) { return $global:StagProcesses.Values }
    if (-not $global:StagProcesses.ContainsKey($Id)) { throw 'Synthetic process not found.' }
    if ([StagWindow]::ChangeAfterCapture -and [StagWindow]::Events.Contains("capture:$Id")) { throw 'Synthetic process exited during capture.' }
    $copy = $global:StagProcesses[$Id].PSObject.Copy()
    if ([StagWindow]::ChangeProcessAfterFocus -and [StagWindow]::Events.Contains("focus:$Id")) {
        $copy.StartTime = [datetime]'2026-02-01'
    }
    return $copy
}
function Get-AuthenticodeSignature {
    param([string]$LiteralPath)
    if (-not $global:StagSignatures.ContainsKey($LiteralPath)) { throw 'Unexpected certificate access.' }
    return $global:StagSignatures[$LiteralPath]
}
function Start-Sleep { param([int]$Milliseconds) }

# Replace only stdin. Production functions, validation and dispatcher remain untouched.
$source = Get-Content -Raw $ScriptPath
$dispatcher = [scriptblock]::Create($source.Replace('[Console]::In.ReadToEnd()', '$global:StagSyntheticInput'))
$contracts = 0
function Invoke-DesktopContract($arguments) {
    [StagWindow]::Events.Clear()
    $global:StagSyntheticInput = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes(($arguments | ConvertTo-Json -Compress)))
    & $dispatcher
}
function Assert-Events([string[]]$expected) {
    if (([StagWindow]::Events -join '|') -cne ($expected -join '|')) {
        throw "Unexpected synthetic events: $([StagWindow]::Events -join '|')"
    }
    $script:contracts++
}
function Assert-Denied($arguments, [string[]]$events = @()) {
    $failed = $false
    try { $null = Invoke-DesktopContract $arguments } catch { $failed = $true }
    if (-not $failed) { throw 'Invalid desktop target or input accepted.' }
    Assert-Events $events
}

$windows = @(Invoke-DesktopContract @{ action = 'list_windows' } | ConvertFrom-Json)
if ((($windows.processId | Sort-Object) -join ',') -ne '4242,5252,6262') { throw 'Window allowlist failed.' }
Assert-Events @()
foreach ($processId in @(4242, 5252, 6262)) {
    [StagWindow]::HitWindow = [IntPtr]$processId
    $null = Invoke-DesktopContract @{ action = 'focus_window'; processId = $processId }
    Assert-Events @("focus:$processId")
    $image = Invoke-DesktopContract @{ action = 'screenshot'; processId = $processId } | ConvertFrom-Json
    if ($image.processId -ne $processId -or $image.bounds.x -ne -200 -or $image.bounds.width -ne 800 -or
        $image.imageBase64 -ne 'aW1hZ2VtLXNpbnRldGljYQ==') { throw 'Window-only capture contract failed.' }
    Assert-Events @("capture:$processId")
    $null = Invoke-DesktopContract @{ action = 'type_text'; processId = $processId; text = '+{x}' }
    Assert-Events @("focus:$processId", 'keys:{+}', 'keys:{{}', 'keys:x', 'keys:{}}')
    $null = Invoke-DesktopContract @{ action = 'send_keys'; processId = $processId; keys = '^s' }
    Assert-Events @("focus:$processId", 'keys:^s')
    $null = Invoke-DesktopContract @{ action = 'click'; processId = $processId; x = -100; y = 20; button = 'right'; clicks = 2 }
    Assert-Events @("focus:$processId", 'cursor:-100,20', 'mouse:8:0', 'mouse:16:0', 'cursor:-100,20', 'mouse:8:0', 'mouse:16:0')
    $null = Invoke-DesktopContract @{ action = 'scroll'; processId = $processId; x = 10; y = 20; delta = -240 }
    Assert-Events @("focus:$processId", 'cursor:10,20', 'mouse:2048:4294967056')
}
foreach ($processId in @(9001, 9002, 9003, 7777)) {
    foreach ($action in @('focus_window', 'screenshot', 'send_keys', 'type_text', 'click', 'scroll')) {
        Assert-Denied @{ action = $action; processId = $processId; keys = '^s'; text = 'blocked'; x = 10; y = 20; delta = 120 }
    }
}
# A matching title/name cannot authorize a different product or untrusted executable.
$originalProduct = $global:StagProcesses[6262].FileVersionInfo.ProductName
$global:StagProcesses[6262].FileVersionInfo.ProductName = 'Explorer'
Assert-Denied @{ action = 'focus_window'; processId = 6262 }
$global:StagProcesses[6262].FileVersionInfo.ProductName = $originalProduct
$signature = $global:StagSignatures[$global:StagProcesses[6262].Path]
$certificate = $signature.SignerCertificate
$signature.SignerCertificate = [StagCertificate]::new('Untrusted publisher')
Assert-Denied @{ action = 'type_text'; processId = 6262; text = 'blocked' }
$signature.SignerCertificate = $null
Assert-Denied @{ action = 'screenshot'; processId = 6262 }
$signature.SignerCertificate = $certificate
$signature.Status = 'NotSigned'
Assert-Denied @{ action = 'click'; processId = 6262; x = 10; y = 20 }
$signature.Status = 'Valid'

[StagWindow]::HitWindow = [IntPtr]4242
foreach ($invalid in @(
    @{ action = 'screenshot' },
    @{ action = 'click'; processId = 4242; x = -1921; y = 20 },
    @{ action = 'click'; processId = 4242; x = 10; y = 20; clicks = 3 },
    @{ action = 'scroll'; processId = 4242; x = 10; y = 20; delta = 0 },
    @{ action = 'scroll'; processId = 4242; x = 10; y = 20; delta = -1201 }
)) { Assert-Denied $invalid }
# Overlays, background/taskbar and another allowed application are outside the chosen target.
foreach ($otherWindow in @(0, 9001, 9003, 6262)) {
    [StagWindow]::HitWindow = [IntPtr]$otherWindow
    foreach ($action in @('click', 'scroll')) {
        Assert-Denied @{ action = $action; processId = 4242; x = 10; y = 20; delta = 120 }
    }
}
[StagWindow]::HitWindow = [IntPtr]4242
foreach ($keys in @('%{TAB}', '%{ESC}', '^{ESC}', '^+{ESC}', '^s{ENTER}', '%{F4}blocked', '^({ESC})', '~')) {
    Assert-Denied @{ action = 'send_keys'; processId = 4242; keys = $keys }
}
[StagWindow]::BlockFocus = $true
Assert-Denied @{ action = 'type_text'; processId = 4242; text = 'blocked' } @('focus:4242')
[StagWindow]::BlockFocus = $false
[StagWindow]::ChangeAfterMove = $true
Assert-Denied @{ action = 'click'; processId = 4242; x = 10; y = 20 } @('focus:4242', 'cursor:10,20')
[StagWindow]::HitWindow = [IntPtr]4242
Assert-Denied @{ action = 'scroll'; processId = 4242; x = 10; y = 20; delta = 120 } @('focus:4242', 'cursor:10,20')
[StagWindow]::ChangeAfterMove = $false
[StagWindow]::HitWindow = [IntPtr]4242
[StagWindow]::LoseFocusAfterMove = $true
foreach ($action in @('click', 'scroll')) {
    Assert-Denied @{ action = $action; processId = 4242; x = 10; y = 20; delta = 120 } @('focus:4242', 'cursor:10,20')
}
[StagWindow]::LoseFocusAfterMove = $false
[StagWindow]::ChangeProcessAfterFocus = $true
Assert-Denied @{ action = 'type_text'; processId = 4242; text = 'blocked' } @('focus:4242')
[StagWindow]::ChangeProcessAfterFocus = $false
[StagWindow]::ChangeAfterFirstClick = $true
Assert-Denied @{ action = 'click'; processId = 4242; x = 10; y = 20; clicks = 2 } @('focus:4242', 'cursor:10,20', 'mouse:2:0', 'mouse:4:0')
[StagWindow]::ChangeAfterFirstClick = $false
[StagWindow]::LoseFocusAfterKeys = 1
Assert-Denied @{ action = 'type_text'; processId = 4242; text = "`nblocked" } @('focus:4242', 'keys:{ENTER}')
[StagWindow]::MoveAfterCapture = $true
Assert-Denied @{ action = 'screenshot'; processId = 4242 } @('capture:4242')
[StagWindow]::MoveAfterCapture = $false
[StagWindow]::ChangeAfterCapture = $true
Assert-Denied @{ action = 'screenshot'; processId = 4242 } @('capture:4242')
[StagWindow]::ChangeAfterCapture = $false

# Rejection never expands the list; the next allowed operation still succeeds.
$null = Invoke-DesktopContract @{ action = 'send_keys'; processId = 4242; keys = '^s' }
Assert-Events @('focus:4242', 'keys:^s')
Write-Output "Native desktop dispatcher: $contracts synthetic contracts OK; no real desktop APIs executed."
