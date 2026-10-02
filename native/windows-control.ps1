$ErrorActionPreference = 'Stop'
[Console]::InputEncoding = New-Object System.Text.UTF8Encoding
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding
$InputBase64 = [Console]::In.ReadToEnd()
$request = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($InputBase64)) | ConvertFrom-Json

Add-Type @'
using System;
using System.Runtime.InteropServices;
public static class StagWindow {
    [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
    [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
    [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
    [DllImport("user32.dll")] public static extern void mouse_event(uint flags, uint dx, uint dy, uint data, UIntPtr extra);
    [DllImport("user32.dll")] public static extern int GetSystemMetrics(int index);
    [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
}
'@
[void][StagWindow]::SetProcessDPIAware()

function Focus-StagWindow([int]$processId) {
    $targetProcess = Get-Process -Id $processId
    if ($targetProcess.MainWindowHandle -eq 0) { throw 'Processo sem janela visivel.' }
    [void][StagWindow]::ShowWindow($targetProcess.MainWindowHandle, 9)
    [void][StagWindow]::SetForegroundWindow($targetProcess.MainWindowHandle)
    Start-Sleep -Milliseconds 150
    if ([StagWindow]::GetForegroundWindow() -ne $targetProcess.MainWindowHandle) {
        throw 'O Windows impediu o foco; nenhuma tecla foi enviada.'
    }
}

switch ($request.action) {
    'list_windows' {
        $windows = @(Get-Process | Where-Object { $_.MainWindowHandle -ne 0 -and $_.MainWindowTitle } |
            Select-Object @{Name='processId';Expression={$_.Id}}, @{Name='title';Expression={$_.MainWindowTitle}}, @{Name='process';Expression={$_.ProcessName}})
        ConvertTo-Json -InputObject $windows -Compress
    }
    'focus_window' {
        Focus-StagWindow $request.processId
        '{"ok":true}'
    }
    'send_keys' {
        Focus-StagWindow $request.processId
        Add-Type -AssemblyName System.Windows.Forms
        [Windows.Forms.SendKeys]::SendWait([string]$request.keys)
        '{"ok":true}'
    }
    'click' {
        $left = [StagWindow]::GetSystemMetrics(76)
        $top = [StagWindow]::GetSystemMetrics(77)
        $width = [StagWindow]::GetSystemMetrics(78)
        $height = [StagWindow]::GetSystemMetrics(79)
        if ($request.x -lt $left -or $request.x -ge ($left + $width) -or $request.y -lt $top -or $request.y -ge ($top + $height)) {
            throw 'Coordenadas fora da area de trabalho.'
        }
        if (-not [StagWindow]::SetCursorPos([int]$request.x, [int]$request.y)) { throw 'Nao foi possivel posicionar o cursor.' }
        [StagWindow]::mouse_event(2, 0, 0, 0, [UIntPtr]::Zero)
        [StagWindow]::mouse_event(4, 0, 0, 0, [UIntPtr]::Zero)
        '{"ok":true}'
    }
    default { throw 'Acao de desktop nao suportada.' }
}
