param([Parameter(Mandatory = $true)][string]$ScriptPath)
$ErrorActionPreference = 'Stop'
$ScriptPath = (Resolve-Path $ScriptPath).Path

# These types have no P/Invoke. Run the real dispatcher against synthetic Windows APIs.
Write-Output 'Native desktop harness: compiling synthetic types.'
Add-Type @'
using System;
using System.Collections.Generic;
public static class StagWindow {
    public static List<string> Events = new List<string>();
    public static bool BlockFocus = false;
    private static IntPtr foreground = new IntPtr(4242);
    public static bool SetProcessDPIAware() { return true; }
    public static bool ShowWindow(IntPtr window, int command) { return true; }
    public static bool SetForegroundWindow(IntPtr window) {
        Events.Add("focus:" + window);
        if (!BlockFocus) foreground = window;
        return !BlockFocus;
    }
    public static IntPtr GetForegroundWindow() { return BlockFocus ? IntPtr.Zero : foreground; }
    public static int GetSystemMetrics(int index) {
        switch (index) {
            case 76: return -1920;
            case 77: return 0;
            case 78: return 3840;
            case 79: return 1080;
            default: throw new Exception("Unexpected metric");
        }
    }
    public static bool SetCursorPos(int x, int y) { Events.Add("cursor:" + x + "," + y); return true; }
    public static void mouse_event(uint flags, uint dx, uint dy, uint data, UIntPtr extra) {
        Events.Add("mouse:" + flags + ":" + data);
    }
}
namespace System.Windows.Forms {
    public static class SendKeys {
        public static void SendWait(string text) { StagWindow.Events.Add("keys:" + text); }
    }
}
'@
Write-Output 'Native desktop harness: running production dispatcher against synthetic APIs.'

# Shadow every desktop boundary, so this harness never loads user32 or Forms.
function Add-Type {
    param([string]$TypeDefinition, [string]$AssemblyName)
    if ($AssemblyName -eq 'System.Windows.Forms') { return }
    if ($TypeDefinition -and $TypeDefinition.Contains('public static class StagWindow')) { return }
    throw 'Unexpected native dependency in desktop test.'
}
function Get-Process {
    param([int]$Id)
    if ($Id -and $Id -ne 4242) { throw 'Synthetic process not found.' }
    [pscustomobject]@{ Id = 4242; MainWindowHandle = [IntPtr]4242; MainWindowTitle = 'Synthetic editor'; ProcessName = 'fixture' }
}
function Start-Sleep { param([int]$Milliseconds) }

# InputEncoding resets Console.In on some runtimes; replace only the stdin boundary.
# The native functions and switch dispatcher remain the production source.
$source = Get-Content -Raw $ScriptPath
$dispatcher = [scriptblock]::Create($source.Replace('[Console]::In.ReadToEnd()', '$global:StagSyntheticInput'))

function Invoke-DesktopContract($arguments) {
    [StagWindow]::Events.Clear()
    $global:StagSyntheticInput = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes(($arguments | ConvertTo-Json -Compress)))
    & $dispatcher
}
function Assert-Events([string[]]$expected) {
    if (([StagWindow]::Events -join '|') -cne ($expected -join '|')) {
        throw "Unexpected synthetic events: $([StagWindow]::Events -join '|')"
    }
}

$windows = Invoke-DesktopContract @{ action = 'list_windows' } | ConvertFrom-Json
if (@($windows).Count -ne 1 -or $windows.processId -ne 4242) { throw 'Window list contract failed.' }
Assert-Events @()
$null = Invoke-DesktopContract @{ action = 'focus_window'; processId = 4242 }
Assert-Events @('focus:4242')
$null = Invoke-DesktopContract @{ action = 'type_text'; processId = 4242; text = '+^%{ENTER}' }
Assert-Events @('focus:4242', 'keys:{+}{^}{%}{{}ENTER{}}')
$null = Invoke-DesktopContract @{ action = 'send_keys'; processId = 4242; keys = '^s' }
Assert-Events @('focus:4242', 'keys:^s')
$null = Invoke-DesktopContract @{ action = 'click'; x = -100; y = 20; button = 'right'; clicks = 2 }
Assert-Events @('cursor:-100,20', 'mouse:8:0', 'mouse:16:0', 'mouse:8:0', 'mouse:16:0')
$null = Invoke-DesktopContract @{ action = 'click'; x = 10; y = 20 }
Assert-Events @('cursor:10,20', 'mouse:2:0', 'mouse:4:0')
$null = Invoke-DesktopContract @{ action = 'scroll'; x = 10; y = 20; delta = -240 }
Assert-Events @('cursor:10,20', 'mouse:2048:4294967056')
$null = Invoke-DesktopContract @{ action = 'scroll'; x = 10; y = 20; delta = 120 }
Assert-Events @('cursor:10,20', 'mouse:2048:120')

foreach ($invalid in @(
    @{ action = 'click'; x = -1921; y = 20 },
    @{ action = 'click'; x = 10; y = 20; clicks = 3 },
    @{ action = 'scroll'; x = 10; y = 20; delta = 0 },
    @{ action = 'scroll'; x = 10; y = 20; delta = -1201 }
)) {
    $failed = $false
    try { $null = Invoke-DesktopContract $invalid } catch { $failed = $true }
    if (-not $failed) { throw 'Invalid desktop input accepted.' }
    Assert-Events @()
}
[StagWindow]::BlockFocus = $true
$failed = $false
try { $null = Invoke-DesktopContract @{ action = 'type_text'; processId = 4242; text = 'fixture' } } catch { $failed = $true }
if (-not $failed) { throw 'Blocked foreground window accepted.' }
Assert-Events @('focus:4242')
Write-Output 'Native desktop dispatcher: 13 synthetic contracts OK; no real Windows APIs executed.'
