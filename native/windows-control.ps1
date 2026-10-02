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

function Move-StagCursor([int]$x, [int]$y) {
    $left = [StagWindow]::GetSystemMetrics(76)
    $top = [StagWindow]::GetSystemMetrics(77)
    $width = [StagWindow]::GetSystemMetrics(78)
    $height = [StagWindow]::GetSystemMetrics(79)
    if ($x -lt $left -or $x -ge ($left + $width) -or $y -lt $top -or $y -ge ($top + $height)) {
        throw 'Coordenadas fora da area de trabalho.'
    }
    if (-not [StagWindow]::SetCursorPos($x, $y)) { throw 'Nao foi possivel posicionar o cursor.' }
}

function ConvertTo-StagLiteralKeys([string]$text) {
    # Escape each SendKeys metacharacter before introducing newline/tab key tokens.
    $literal = [regex]::Replace($text, '[+^%~(){}\[\]]', { param($match) '{' + $match.Value + '}' })
    $literal = [regex]::Replace($literal, '\r\n|\r|\n', '{ENTER}')
    return $literal.Replace("`t", '{TAB}')
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
    'type_text' {
        Focus-StagWindow $request.processId
        Add-Type -AssemblyName System.Windows.Forms
        [Windows.Forms.SendKeys]::SendWait((ConvertTo-StagLiteralKeys ([string]$request.text)))
        '{"ok":true}'
    }
    'click' {
        # Validate before any cursor or button event, even when called outside the app.
        $button = if ($request.button) { [string]$request.button } else { 'left' }
        $clicks = if ($null -ne $request.clicks) { [int]$request.clicks } else { 1 }
        if ($clicks -notin @(1, 2)) { throw 'Quantidade de cliques invalida.' }
        switch ($button) {
            'left' { $down = 2; $up = 4 }
            'right' { $down = 8; $up = 16 }
            'middle' { $down = 32; $up = 64 }
            default { throw 'Botao de mouse invalido.' }
        }
        Move-StagCursor ([int]$request.x) ([int]$request.y)
        for ($i = 0; $i -lt $clicks; $i++) {
            [StagWindow]::mouse_event($down, 0, 0, 0, [UIntPtr]::Zero)
            [StagWindow]::mouse_event($up, 0, 0, 0, [UIntPtr]::Zero)
            if ($i -lt ($clicks - 1)) { Start-Sleep -Milliseconds 80 }
        }
        '{"ok":true}'
    }
    'scroll' {
        $delta = [int]$request.delta
        if ($delta -eq 0 -or $delta -lt -1200 -or $delta -gt 1200) { throw 'Rolagem invalida.' }
        Move-StagCursor ([int]$request.x) ([int]$request.y)
        # Win32 expects the two's-complement DWORD representation for a negative delta.
        $wheelData = [BitConverter]::ToUInt32([BitConverter]::GetBytes($delta), 0)
        [StagWindow]::mouse_event(0x0800, 0, 0, $wheelData, [UIntPtr]::Zero)
        '{"ok":true}'
    }
    default { throw 'Acao de desktop nao suportada.' }
}
