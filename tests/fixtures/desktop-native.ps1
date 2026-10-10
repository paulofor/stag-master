param([Parameter(Mandatory = $true)][string]$ScriptPath)
$ErrorActionPreference = 'Stop'
$ScriptPath = (Resolve-Path $ScriptPath).Path

# Inspect only this test process's object shape, never client processes or windows.
# A permissive double must not invent members missing from System.Diagnostics.Process.
$self = Microsoft.PowerShell.Management\Get-Process -Id $PID
try {
    $processShape = @($self.PSObject.Properties.Name)
    $moduleShape = @($self.MainModule.PSObject.Properties.Name)
    $versionShape = @($self.MainModule.FileVersionInfo.PSObject.Properties.Name)
} finally { $self.Dispose() }

# No P/Invoke: the real dispatcher runs with synthetic windows, processes, certificates and pixels.
Write-Output 'Native desktop harness: compiling synthetic boundaries.'
Add-Type @'
using System;
using System.Collections.Generic;
public static class StagWindow {
    public static List<string> Events = new List<string>();
    public static string InstallationRoot, InstallationRootX86, ExpectedExecutable;
    public static bool FailLaunch, InvalidateAfterLock;
    public static string[] ProgramDirectories() { return new string[] { InstallationRoot, InstallationRootX86 }; }
    private sealed class Lease : IDisposable { public void Dispose() { Events.Add("unlock"); } }
    public static IDisposable LockExecutable(string path) {
        if (path != ExpectedExecutable) throw new Exception("Unexpected executable lock.");
        Events.Add("lock");
        return new Lease();
    }
    public static void OpenFortiClient(string path) {
        if (path != ExpectedExecutable) throw new Exception("Unexpected executable launch.");
        if (FailLaunch) throw new Exception("Synthetic launch failure: private installation path.");
        Events.Add("open:FortiClient");
    }
    public static bool BlockFocus, ChangeAfterMove, ChangeAfterCapture, MoveAfterCapture;
    public static bool LoseFocusAfterMove, ChangeProcessAfterFocus, ChangeAfterFirstClick;
    public static int LoseFocusAfterKeys;
    public static Dictionary<long, uint> WindowOwners = new Dictionary<long, uint>();
    public static Dictionary<long, long> WindowParents = new Dictionary<long, long>();
    public static IntPtr HiddenWindow;
    public static IntPtr HitWindow = new IntPtr(4242);
    public static IntPtr Foreground = new IntPtr(4242);
    public static bool SetProcessDPIAware() { return true; }
    public static bool IsWindowVisible(IntPtr window) { return window != IntPtr.Zero && window != HiddenWindow; }
    public static uint WindowProcessId(IntPtr window) {
        uint owner;
        return WindowOwners.TryGetValue(window.ToInt64(), out owner) ? owner : (uint)window.ToInt64();
    }
    public static IntPtr GetAncestor(IntPtr window, uint flags) {
        long parent;
        return WindowParents.TryGetValue(window.ToInt64(), out parent) ? new IntPtr(parent) : window;
    }
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
$global:StagInstallation = @{}
[StagWindow]::InstallationRoot = [IO.Path]::Combine([IO.Path]::GetTempPath(), 'stag-synthetic', 'Program Files')
[StagWindow]::InstallationRootX86 = [IO.Path]::Combine([IO.Path]::GetTempPath(), 'stag-synthetic', 'Program Files x86')
function Add-SyntheticInstallation([string]$root) {
    $path = $root
    foreach ($segment in @('', 'Fortinet', 'FortiClient', 'FortiClient.exe')) {
        if ($segment) { $path = [IO.Path]::Combine($path, $segment) }
        $directory = $segment -ne 'FortiClient.exe'
        $global:StagInstallation[$path] = [pscustomobject]@{
            FullName = $path; Name = [IO.Path]::GetFileName($path); PSIsContainer = $directory;
            Attributes = if ($directory) { [IO.FileAttributes]::Directory } else { [IO.FileAttributes]::Normal };
            VersionInfo = [pscustomobject]@{ ProductName = 'FortiClient VPN' }
        }
    }
    $global:StagSignatures[$path] = [pscustomobject]@{ Status = 'Valid'; SignerCertificate = [StagCertificate]::new('Fortinet, Inc.') }
    return $path
}
function Test-Path { param([string]$LiteralPath); return $global:StagInstallation.ContainsKey($LiteralPath) }
function Get-Item {
    param([string]$LiteralPath, [switch]$Force, [string]$ErrorAction)
    if (-not $global:StagInstallation.ContainsKey($LiteralPath)) { throw 'Unexpected installation access.' }
    return $global:StagInstallation[$LiteralPath]
}
function Add-SyntheticProcess([int]$processId, [string]$name, [string]$product, [string]$publisher) {
    $path = [IO.Path]::Combine([IO.Path]::GetTempPath(), 'stag-synthetic', ($name + '.exe'))
    $global:StagProcesses[$processId] = [pscustomobject]@{
        Id = $processId; MainWindowHandle = [IntPtr]$processId; MainWindowTitle = "Synthetic $product";
        ProcessName = $name; Path = $path; StartTime = [datetime]'2026-01-01';
        MainModule = [pscustomobject]@{ FileVersionInfo = [pscustomobject]@{ ProductName = $product } }
    }
    $synthetic = $global:StagProcesses[$processId]
    foreach ($node in @(
        @{ Value = $synthetic; Shape = $processShape },
        @{ Value = $synthetic.MainModule; Shape = $moduleShape },
        @{ Value = $synthetic.MainModule.FileVersionInfo; Shape = $versionShape }
    )) {
        foreach ($member in $node.Value.PSObject.Properties.Name) {
            if ($member -notin $node.Shape) { throw "Synthetic process member does not exist in PowerShell: $member" }
        }
    }
    $global:StagSignatures[$path] = [pscustomobject]@{ Status = 'Valid'; SignerCertificate = [StagCertificate]::new($publisher) }
}
Add-SyntheticProcess 4242 'Postman' 'Postman' 'Postman, Inc'
Add-SyntheticProcess 5252 'idea64' 'IntelliJ IDEA' 'JetBrains s.r.o.'
Add-SyntheticProcess 6262 'Code' 'Visual Studio Code' 'Microsoft Corporation'
Add-SyntheticProcess 7272 'dbeaver' 'DBeaver Community' 'DBeaver Corp'
Add-SyntheticProcess 8282 'DBeaver' 'DBeaver' 'DBeaver Corp'
Add-SyntheticProcess 8383 'FortiClient' 'FortiClient' 'Fortinet, Inc.'
Add-SyntheticProcess 8484 'forticlient' 'FortiClient VPN' 'Fortinet Inc.'
Add-SyntheticProcess 8585 'FORTICLIENT' 'FortiClient Standalone' 'Fortinet, Inc.'
Add-SyntheticProcess 9001 'chrome' 'Postman' 'Postman, Inc'
Add-SyntheticProcess 9002 'notepad' 'IntelliJ IDEA' 'Microsoft Corporation'
Add-SyntheticProcess 9003 'explorer' 'Visual Studio Code' 'Microsoft Corporation'
Add-SyntheticProcess 9004 'dbeaver-fake' 'DBeaver Community' 'DBeaver Corp'
Add-SyntheticProcess 9005 'FortiTray' 'FortiClient' 'Fortinet, Inc.'
Add-SyntheticProcess 9006 'FortiVPN' 'FortiClient VPN' 'Fortinet, Inc.'
Add-SyntheticProcess 9007 'FortiClient-fake' 'FortiClient' 'Fortinet, Inc.'
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
    if ([StagWindow]::InvalidateAfterLock -and [StagWindow]::Events.Contains('lock')) {
        return [pscustomobject]@{ Status = 'HashMismatch'; SignerCertificate = [StagCertificate]::new('Fortinet, Inc.') }
    }
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
function Assert-Denied($arguments, [string[]]$events = @(), [string]$reason = '') {
    $failed = $false
    try { $null = Invoke-DesktopContract $arguments } catch {
        if ($reason -and $_.Exception.Message -notmatch $reason) { throw }
        $failed = $true
    }
    if (-not $failed) { throw 'Invalid desktop target or input accepted.' }
    Assert-Events $events
}

# An absent console can be opened only by this separately approved, fixed operation.
$open = @{ action = 'open_forticlient'; risk = 'critical'; intent = 'Abrir console para conferir VPN sintetica' }
$approvedOpen = $open + @{ stagCriticalApproved = $true }
Assert-Denied $open
Assert-Denied ($open + @{ stagCriticalApproved = $false })
Assert-Denied ($open + @{ stagCriticalApproved = 'true' })
Assert-Denied ($open + @{ stagCheckOnly = $true })
Assert-Denied $approvedOpen
$installed = Add-SyntheticInstallation ([StagWindow]::InstallationRoot)
[StagWindow]::ExpectedExecutable = $installed
$inspection = Invoke-DesktopContract ($open + @{ stagCheckOnly = $true }) | ConvertFrom-Json
if (-not $inspection.requiresConfirmation -or $inspection.PSObject.Properties.Name -contains 'path') { throw 'Console inspection leaked an installation or missed confirmation.' }
Assert-Events @()
$opened = Invoke-DesktopContract $approvedOpen | ConvertFrom-Json
if (-not $opened.opened -or $opened.PSObject.Properties.Name -contains 'connected') { throw 'Console opening claimed VPN connectivity.' }
Assert-Events @('lock', 'open:FortiClient', 'unlock')
foreach ($item in @($global:StagInstallation.Values)) {
    $original = $item.Attributes
    $item.Attributes = $original -bor [IO.FileAttributes]::ReparsePoint
    Assert-Denied $approvedOpen
    $item.Attributes = $original
}
foreach ($product in @('FortiTray', 'FortiClient Installer', 'FortiClient VPN injected', 'Other VPN')) {
    $global:StagInstallation[$installed].VersionInfo.ProductName = $product
    Assert-Denied $approvedOpen
}
$global:StagInstallation[$installed].VersionInfo.ProductName = 'FortiClient VPN'
$installedSignature = $global:StagSignatures[$installed]
foreach ($status in @('NotSigned', 'HashMismatch', 'UnknownError')) {
    $installedSignature.Status = $status
    Assert-Denied $approvedOpen
}
$installedSignature.Status = 'Valid'
foreach ($publisher in @('Microsoft Corporation', 'Fortinet, Inc. untrusted')) {
    $installedSignature.SignerCertificate = [StagCertificate]::new($publisher)
    Assert-Denied $approvedOpen
}
$installedSignature.SignerCertificate = $null
Assert-Denied $approvedOpen
$installedSignature.SignerCertificate = [StagCertificate]::new('Fortinet, Inc.')
[StagWindow]::InvalidateAfterLock = $true
Assert-Denied $approvedOpen @('lock', 'unlock')
[StagWindow]::InvalidateAfterLock = $false
[StagWindow]::FailLaunch = $true
Assert-Denied $approvedOpen @('lock', 'unlock')
[StagWindow]::FailLaunch = $false
$null = Invoke-DesktopContract $approvedOpen
Assert-Events @('lock', 'open:FortiClient', 'unlock')
# x86 is supported only when the first known installation is absent, not when it is untrusted.
$installedX86 = Add-SyntheticInstallation ([StagWindow]::InstallationRootX86)
$installedSignature.Status = 'HashMismatch'
Assert-Denied $approvedOpen
$global:StagInstallation.Remove($installed)
[StagWindow]::ExpectedExecutable = $installedX86
$null = Invoke-DesktopContract $approvedOpen
Assert-Events @('lock', 'open:FortiClient', 'unlock')

$windows = @(Invoke-DesktopContract @{ action = 'list_windows' } | ConvertFrom-Json)
if ((($windows.processId | Sort-Object) -join ',') -ne '4242,5252,6262,7272,8282,8383,8484,8585') { throw 'Window allowlist failed.' }
Assert-Events @()
foreach ($processId in @(4242, 5252, 6262, 7272, 8282, 8383, 8484, 8585)) {
    [StagWindow]::HitWindow = [IntPtr]$processId
    $approved = $processId -in @(8383, 8484, 8585)
    $null = Invoke-DesktopContract @{ action = 'focus_window'; processId = $processId }
    Assert-Events @("focus:$processId")
    $image = Invoke-DesktopContract @{ action = 'screenshot'; processId = $processId } | ConvertFrom-Json
    if ($image.processId -ne $processId -or $image.bounds.x -ne -200 -or $image.bounds.width -ne 800 -or
        $image.imageBase64 -ne 'aW1hZ2VtLXNpbnRldGljYQ==') { throw 'Window-only capture contract failed.' }
    Assert-Events @("capture:$processId")
    $null = Invoke-DesktopContract @{ action = 'type_text'; processId = $processId; text = '+{x}'; stagCriticalApproved = $approved }
    Assert-Events @("focus:$processId", 'keys:{+}', 'keys:{{}', 'keys:x', 'keys:{}}')
    $null = Invoke-DesktopContract @{ action = 'send_keys'; processId = $processId; keys = '^s'; stagCriticalApproved = $approved }
    Assert-Events @("focus:$processId", 'keys:^s')
    $null = Invoke-DesktopContract @{ action = 'click'; processId = $processId; x = -100; y = 20; button = 'right'; clicks = 2; stagCriticalApproved = $approved }
    Assert-Events @("focus:$processId", 'cursor:-100,20', 'mouse:8:0', 'mouse:16:0', 'cursor:-100,20', 'mouse:8:0', 'mouse:16:0')
    $null = Invoke-DesktopContract @{ action = 'scroll'; processId = $processId; x = 10; y = 20; delta = -240 }
    Assert-Events @("focus:$processId", 'cursor:10,20', 'mouse:2048:4294967056')
}
foreach ($processId in @(9001, 9002, 9003, 9004, 9005, 9006, 9007, 7777)) {
    foreach ($action in @('focus_window', 'screenshot', 'send_keys', 'type_text', 'click', 'scroll')) {
        Assert-Denied @{ action = $action; processId = $processId; keys = '^s'; text = 'blocked'; x = 10; y = 20; delta = 120; stagCriticalApproved = $true }
    }
}
# Check every allowed application's identity, not only one vendor's metadata.
function Assert-IdentityDenied([int]$processId) {
    foreach ($action in @('focus_window', 'screenshot', 'send_keys', 'type_text', 'click', 'scroll')) {
        Assert-Denied @{ action = $action; processId = $processId; keys = '^s'; text = 'blocked'; x = 10; y = 20; delta = 120; stagCriticalApproved = $true }
    }
    $listed = @(Invoke-DesktopContract @{ action = 'list_windows' } | ConvertFrom-Json)
    if ($listed.processId -contains $processId) { throw 'Untrusted identity exposed in list_windows.' }
    Assert-Events @()
}
foreach ($processId in @(4242, 5252, 6262, 7272, 8282, 8383, 8484, 8585)) {
    $process = $global:StagProcesses[$processId]
    $originalProduct = $process.MainModule.FileVersionInfo.ProductName
    $originalPath = $process.Path
    $signature = $global:StagSignatures[$originalPath]
    $certificate = $signature.SignerCertificate
    $process.MainModule.FileVersionInfo.ProductName = 'Unrecognized product'
    Assert-IdentityDenied $processId
    $process.MainModule.FileVersionInfo.ProductName = $originalProduct
    $process.Path = [IO.Path]::Combine([IO.Path]::GetTempPath(), 'stag-synthetic', 'renamed.exe')
    Assert-IdentityDenied $processId
    $process.Path = $originalPath
    $signature.SignerCertificate = [StagCertificate]::new('Untrusted publisher')
    Assert-IdentityDenied $processId
    $signature.SignerCertificate = $null
    Assert-IdentityDenied $processId
    $signature.SignerCertificate = $certificate
    foreach ($status in @('NotSigned', 'HashMismatch')) {
        $signature.Status = $status
        Assert-IdentityDenied $processId
    }
    $signature.Status = 'Valid'
    # Recovery after identity failures must retain the original allowed target.
    $null = Invoke-DesktopContract @{ action = 'focus_window'; processId = $processId }
    Assert-Events @("focus:$processId")
}

# Unreadable/absent module metadata must not be replaced with a title or an invented process member.
# Other applications remain listable, and recovery restores the same DBeaver process.
$dbeaver = $global:StagProcesses[7272]
$originalModule = $dbeaver.MainModule
$dbeaver | Add-Member -NotePropertyName FileVersionInfo -NotePropertyValue $originalModule.FileVersionInfo
$unreadableModule = [pscustomobject]@{}
$unreadableModule | Add-Member -MemberType ScriptProperty -Name FileVersionInfo -Value { throw 'Synthetic metadata access denied' }
foreach ($module in @($null, [pscustomobject]@{ FileVersionInfo = $null },
    [pscustomobject]@{ FileVersionInfo = [pscustomobject]@{ ProductName = '' } }, $unreadableModule)) {
    $dbeaver.MainModule = $module
    Assert-IdentityDenied 7272
    Assert-Denied @{ action = 'click'; processId = 7272; stagCheckOnly = $true }
    $listed = @(Invoke-DesktopContract @{ action = 'list_windows' } | ConvertFrom-Json)
    if ((($listed.processId | Sort-Object) -join ',') -ne '4242,5252,6262,8282,8383,8484,8585') {
        throw 'Unreadable DBeaver metadata hid unrelated allowed windows.'
    }
    Assert-Events @()
}
$dbeaver.PSObject.Properties.Remove('FileVersionInfo')
$dbeaver.MainModule = $originalModule
$listed = @(Invoke-DesktopContract @{ action = 'list_windows' } | ConvertFrom-Json)
if ($listed.processId -notcontains 7272) { throw 'DBeaver did not recover after metadata became available.' }
Assert-Events @()
$image = Invoke-DesktopContract @{ action = 'screenshot'; processId = 7272 } | ConvertFrom-Json
if ($image.processId -ne 7272) { throw 'Recovery captured a different process.' }
Assert-Events @('capture:7272')

# FortiClient input always needs main's per-action approval, regardless of model risk/intent.
foreach ($processId in @(8383, 8484, 8585)) {
    foreach ($action in @('click', 'type_text', 'send_keys')) {
        $arguments = @{ action = $action; processId = $processId; x = 10; y = 20; text = 'synthetic'; keys = '^s'; risk = 'routine'; intent = 'Navegar' }
        $inspection = Invoke-DesktopContract ($arguments + @{ stagCheckOnly = $true }) | ConvertFrom-Json
        if ($inspection.processId -ne $processId -or -not $inspection.requiresConfirmation) { throw 'FortiClient misclassified as routine.' }
        Assert-Events @()
        $approvalRequired = $false
        try { $null = Invoke-DesktopContract $arguments }
        catch { $approvalRequired = $_.Exception.Message -match 'STAG_DESKTOP_APPROVAL_REQUIRED' }
        if (-not $approvalRequired) { throw 'FortiClient sent input without approval.' }
        Assert-Events @()
        Assert-Denied ($arguments + @{ stagCriticalApproved = $false })
    }
}
$inspection = Invoke-DesktopContract @{ action = 'click'; processId = 4242; stagCheckOnly = $true } | ConvertFrom-Json
if ($inspection.requiresConfirmation) { throw 'Postman routine unnecessarily confirmed.' }
Assert-Events @()

# A routine inspection cannot approve a PID later reused by FortiClient.
$originalCode = $global:StagProcesses[6262]
$inspection = Invoke-DesktopContract @{ action = 'click'; processId = 6262; stagCheckOnly = $true } | ConvertFrom-Json
if ($inspection.requiresConfirmation) { throw 'VS Code routine misclassified.' }
Add-SyntheticProcess 6262 'FortiClient' 'FortiClient' 'Fortinet, Inc.'
Assert-Denied @{ action = 'click'; processId = 6262; x = 10; y = 20; risk = 'routine'; intent = 'Navegar' }
$global:StagProcesses[6262] = $originalCode
Assert-Events @()

# A confirmed action still rejects an overlay and a changed signature, then recovers.
[StagWindow]::HitWindow = [IntPtr]9001
Assert-Denied @{ action = 'click'; processId = 8383; x = 10; y = 20; stagCriticalApproved = $true }
$fortiSignature = $global:StagSignatures[$global:StagProcesses[8383].Path]
$fortiSignature.Status = 'HashMismatch'
Assert-Denied @{ action = 'send_keys'; processId = 8383; keys = '^s'; stagCriticalApproved = $true }
$fortiSignature.Status = 'Valid'
[StagWindow]::HitWindow = [IntPtr]8383
$null = Invoke-DesktopContract @{ action = 'click'; processId = 8383; x = 10; y = 20; stagCriticalApproved = $true }
Assert-Events @('focus:8383', 'cursor:10,20', 'mouse:2:0', 'mouse:4:0')
foreach ($product in @('FortiClient Installer', 'FortiClient VPN injected', 'Other VPN')) {
    $global:StagProcesses[8383].MainModule.FileVersionInfo.ProductName = $product
    Assert-IdentityDenied 8383
}
$global:StagProcesses[8383].MainModule.FileVersionInfo.ProductName = 'FortiClient'
$fortiSignature.SignerCertificate = [StagCertificate]::new('Fortinet, Inc. untrusted')
Assert-IdentityDenied 8383
$fortiSignature.SignerCertificate = [StagCertificate]::new('Fortinet, Inc.')

# Prefix/suffix lookalikes do not inherit the DBeaver identity.
foreach ($product in @('DBeaver Community Installer', 'DBeaver Community injected')) {
    $global:StagProcesses[7272].MainModule.FileVersionInfo.ProductName = $product
    Assert-IdentityDenied 7272
}
$global:StagProcesses[7272].MainModule.FileVersionInfo.ProductName = 'DBeaver Community'
$signature = $global:StagSignatures[$global:StagProcesses[7272].Path]
$signature.SignerCertificate = [StagCertificate]::new('DBeaver Corp untrusted')
Assert-IdentityDenied 7272
$signature.SignerCertificate = [StagCertificate]::new('DBeaver Corp')

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

# Removed operations must fail even with former main-only markers and a permitted process.
foreach ($legacy in @(
    @{ action = 'nudge_cursor' },
    @{ action = 'nudge_cursor'; stagPeriodicMovement = $true; processId = 4242 },
    @{ action = 'nudge_cursor'; stagPeriodicMovement = $true; stagHostProcessId = 10101; stagHostWindow = '11001' }
)) { Assert-Denied $legacy @() 'STAG_DESKTOP_DENIED: Operacao desconhecida' }
[StagWindow]::HitWindow = [IntPtr]4242
Invoke-DesktopContract @{ action = 'click'; processId = 4242; x = 10; y = 20 } | Out-Null
Assert-Events @('focus:4242', 'cursor:10,20', 'mouse:2:0', 'mouse:4:0')
Write-Output "Native desktop dispatcher: $contracts synthetic contracts OK; no real desktop APIs executed."
