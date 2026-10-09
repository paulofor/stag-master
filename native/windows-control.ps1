$ErrorActionPreference = 'Stop'
[Console]::InputEncoding = New-Object System.Text.UTF8Encoding
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding
$InputBase64 = [Console]::In.ReadToEnd()
$request = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($InputBase64)) | ConvertFrom-Json

Add-Type -AssemblyName System.Drawing
Add-Type -ReferencedAssemblies System,System.Drawing @'
using System;
using System.Drawing;
using System.Drawing.Imaging;
using System.IO;
using System.Runtime.InteropServices;
public static class StagWindow {
    // Fixed FortiClient launcher: no shell, arguments, service control or tray automation.
    public static string[] ProgramDirectories() {
        return new string[] {
            Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles),
            Environment.GetFolderPath(Environment.SpecialFolder.ProgramFilesX86)
        };
    }
    public static IDisposable LockExecutable(string path) {
        return new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.Read);
    }
    public static void OpenFortiClient(string path) {
        var start = new System.Diagnostics.ProcessStartInfo(path);
        start.UseShellExecute = false;
        start.WorkingDirectory = Path.GetDirectoryName(path);
        using (var process = System.Diagnostics.Process.Start(start)) {
            if (process == null) throw new Exception("STAG_FORTICLIENT_DENIED: Console launch failed.");
        }
    }
    [StructLayout(LayoutKind.Sequential)] private struct Point { public int X, Y; }
    [StructLayout(LayoutKind.Sequential)] private struct Rect { public int Left, Top, Right, Bottom; }
    [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
    [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
    [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
    [DllImport("user32.dll")] private static extern bool GetCursorPos(out Point point);
    [DllImport("user32.dll")] private static extern short GetAsyncKeyState(int key);
    [DllImport("user32.dll")] public static extern void mouse_event(uint flags, uint dx, uint dy, uint data, UIntPtr extra);
    [DllImport("user32.dll")] public static extern int GetSystemMetrics(int index);
    [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
    [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
    [DllImport("user32.dll")] private static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);
    [DllImport("user32.dll")] private static extern IntPtr WindowFromPoint(Point point);
    [DllImport("user32.dll")] public static extern IntPtr GetAncestor(IntPtr hWnd, uint flags);
    [DllImport("user32.dll")] private static extern bool GetWindowRect(IntPtr hWnd, out Rect rect);
    [DllImport("user32.dll")] private static extern bool PrintWindow(IntPtr hWnd, IntPtr hdc, uint flags);
    public static uint WindowProcessId(IntPtr window) {
        uint processId;
        GetWindowThreadProcessId(window, out processId);
        return processId;
    }
    public static IntPtr WindowAt(int x, int y) { return WindowFromPoint(new Point { X = x, Y = y }); }
    public static int[] Cursor() {
        Point point;
        if (!GetCursorPos(out point)) throw new Exception("STAG_DESKTOP_DENIED: Cursor unavailable.");
        return new int[] { point.X, point.Y };
    }
    public static bool ButtonsPressed() {
        foreach (int key in new int[] { 1, 2, 4, 5, 6 })
            if ((GetAsyncKeyState(key) & 0x8000) != 0) return true;
        return false;
    }
    public static int[] Bounds(IntPtr window) {
        Rect rect;
        if (!GetWindowRect(window, out rect)) throw new Exception("STAG_DESKTOP_DENIED: Window unavailable.");
        return new int[] { rect.Left, rect.Top, rect.Right - rect.Left, rect.Bottom - rect.Top };
    }
    public static string Capture(IntPtr window) {
        int[] bounds = Bounds(window);
        if (bounds[2] <= 0 || bounds[3] <= 0 || bounds[2] > 8192 || bounds[3] > 8192 ||
            (long)bounds[2] * bounds[3] > 33554432) throw new Exception("STAG_DESKTOP_DENIED: Invalid window dimensions.");
        // Print only this window. Never copy screen pixels, which could include another application.
        using (Bitmap image = new Bitmap(bounds[2], bounds[3]))
        using (Graphics graphics = Graphics.FromImage(image)) {
            IntPtr hdc = graphics.GetHdc();
            bool printed;
            try { printed = PrintWindow(window, hdc, 2); }
            finally { graphics.ReleaseHdc(hdc); }
            if (!printed) throw new Exception("Window capture failed; no desktop fallback.");
            using (MemoryStream stream = new MemoryStream()) {
                image.Save(stream, ImageFormat.Png);
                return Convert.ToBase64String(stream.ToArray());
            }
        }
    }
}
'@
[void][StagWindow]::SetProcessDPIAware()

function Get-StagFortiClientExecutable {
    # Known Windows folders, never environment paths or values supplied by the model/renderer.
    foreach ($root in @([StagWindow]::ProgramDirectories() | Select-Object -Unique)) {
        if ([string]::IsNullOrWhiteSpace($root) -or -not [IO.Path]::IsPathRooted($root)) { continue }
        $path = $root
        $missing = $false
        foreach ($segment in @('', 'Fortinet', 'FortiClient', 'FortiClient.exe')) {
            if ($segment) { $path = [IO.Path]::Combine($path, $segment) }
            if (-not (Test-Path -LiteralPath $path)) { $missing = $true; break }
            try { $item = Get-Item -LiteralPath $path -Force -ErrorAction Stop }
            catch { throw 'STAG_FORTICLIENT_DENIED: Instalacao indisponivel.' }
            if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0 -or
                $item.PSIsContainer -ne ($segment -ne 'FortiClient.exe') -or
                $item.FullName -ine [IO.Path]::GetFullPath($path)) {
                throw 'STAG_FORTICLIENT_DENIED: Caminho de instalacao nao reconhecido.'
            }
        }
        if ($missing) { continue }
        if ($item.Name -ine 'FortiClient.exe' -or
            [string]$item.VersionInfo.ProductName -notmatch '^FortiClient(?: VPN| Standalone)?$') {
            throw 'STAG_FORTICLIENT_DENIED: Produto nao reconhecido.'
        }
        try { $signature = Get-AuthenticodeSignature -LiteralPath $item.FullName -ErrorAction Stop }
        catch { throw 'STAG_FORTICLIENT_DENIED: Assinatura indisponivel.' }
        if ($signature.Status -ne 'Valid' -or -not $signature.SignerCertificate -or
            $signature.SignerCertificate.GetNameInfo([Security.Cryptography.X509Certificates.X509NameType]::SimpleName, $false) -notmatch '^Fortinet,? Inc\.?$') {
            throw 'STAG_FORTICLIENT_DENIED: Assinatura do fornecedor nao reconhecida.'
        }
        return $item.FullName
    }
    throw 'STAG_FORTICLIENT_UNAVAILABLE: Console oficial nao encontrado.'
}

# Opening a tray-only console is a fixed, separately approved operation. It never interacts with Explorer/FortiTray.
if ($request.action -eq 'open_forticlient') {
    if ($request.stagCheckOnly -ne $true -and
        ($request.stagCriticalApproved -isnot [bool] -or $request.stagCriticalApproved -ne $true)) {
        throw 'STAG_DESKTOP_APPROVAL_REQUIRED: Abertura do FortiClient requer confirmacao especifica.'
    }
    try { $executable = Get-StagFortiClientExecutable }
    catch {
        if ($_.Exception.Message -match 'STAG_FORTICLIENT_UNAVAILABLE') {
            throw 'STAG_FORTICLIENT_UNAVAILABLE: Console oficial nao encontrado.'
        }
        throw 'STAG_FORTICLIENT_DENIED: Instalacao oficial nao pode ser verificada.'
    }
    if ($request.stagCheckOnly -eq $true) {
        '{"requiresConfirmation":true}'
        return
    }
    $lease = $null
    try {
        # Prevent replacing/writing the executable while its identity is rechecked and it is started.
        $lease = [StagWindow]::LockExecutable($executable)
        if ((Get-StagFortiClientExecutable) -ine $executable) {
            throw 'STAG_FORTICLIENT_DENIED: Instalacao mudou apos verificacao.'
        }
        [StagWindow]::OpenFortiClient($executable)
    } catch {
        throw 'STAG_FORTICLIENT_DENIED: Console oficial nao pode ser aberto.'
    } finally {
        if ($lease) { $lease.Dispose() }
    }
    '{"opened":true}'
    return
}

function Get-StagAllowedProcess([int]$processId) {
    try { $target = Get-Process -Id $processId -ErrorAction Stop }
    catch { throw 'STAG_DESKTOP_DENIED: O processo nao esta disponivel; liste as janelas novamente.' }
    $name = [string]$target.ProcessName
    switch ($name.ToLowerInvariant()) {
        'postman' { $product = '^Postman$'; $publisher = '^Postman,? Inc\.?$' }
        'idea64' { $product = '^IntelliJ IDEA(?: (?:Community|Ultimate) Edition)?$'; $publisher = '^JetBrains s\.r\.o\.?$' }
        'idea' { $product = '^IntelliJ IDEA(?: (?:Community|Ultimate) Edition)?$'; $publisher = '^JetBrains s\.r\.o\.?$' }
        'code' { $product = '^(?:Microsoft )?Visual Studio Code$'; $publisher = '^Microsoft Corporation$' }
        'dbeaver' { $product = '^DBeaver(?: Community)?$'; $publisher = '^DBeaver Corp$' }
        'forticlient' { $product = '^FortiClient(?: VPN| Standalone)?$'; $publisher = '^Fortinet,? Inc\.?$' }
        default { throw 'STAG_DESKTOP_DENIED: Somente Postman, IntelliJ IDEA, Visual Studio Code, DBeaver e FortiClient.' }
    }
    # Get-Process returns System.Diagnostics.Process; version metadata belongs to its main module.
    # Missing/inaccessible metadata must fail closed, without requesting elevation or exposing paths.
    try { $productName = [string]$target.MainModule.FileVersionInfo.ProductName }
    catch { throw 'STAG_DESKTOP_DENIED: Metadados do executavel indisponiveis.' }
    # A title, renamed executable or model-provided name cannot grant access.
    if (-not $target.Path -or [IO.Path]::GetFileName($target.Path) -ine ($name + '.exe') -or
        $target.MainWindowHandle -eq 0 -or -not [StagWindow]::IsWindowVisible($target.MainWindowHandle) -or
        [StagWindow]::WindowProcessId($target.MainWindowHandle) -ne $processId -or
        $productName -notmatch $product) {
        throw 'STAG_DESKTOP_DENIED: Executavel ou janela nao reconhecidos.'
    }
    $signature = Get-AuthenticodeSignature -LiteralPath $target.Path
    if ($signature.Status -ne 'Valid' -or -not $signature.SignerCertificate -or
        $signature.SignerCertificate.GetNameInfo([Security.Cryptography.X509Certificates.X509NameType]::SimpleName, $false) -notmatch $publisher) {
        throw 'STAG_DESKTOP_DENIED: Assinatura do fornecedor nao reconhecida.'
    }
    return $target
}

function Assert-StagWindow($target, [IntPtr]$window) {
    try { $current = Get-Process -Id $target.Id -ErrorAction Stop }
    catch { throw 'STAG_DESKTOP_DENIED: O processo encerrou durante a acao.' }
    if ($current.StartTime -ne $target.StartTime -or $current.Path -ine $target.Path -or
        $window -eq [IntPtr]::Zero -or -not [StagWindow]::IsWindowVisible($window) -or
        [StagWindow]::WindowProcessId($window) -ne $target.Id) {
        throw 'STAG_DESKTOP_DENIED: A janela ou processo mudou durante a acao.'
    }
}

function Assert-StagForeground($target) {
    Assert-StagWindow $target ([StagWindow]::GetForegroundWindow())
}

function Focus-StagWindow($target, [IntPtr]$window) {
    Assert-StagWindow $target $window
    [void][StagWindow]::ShowWindow($window, 9)
    [void][StagWindow]::SetForegroundWindow($window)
    Start-Sleep -Milliseconds 150
    if ([StagWindow]::GetForegroundWindow() -ne $window) {
        throw 'STAG_DESKTOP_DENIED: O Windows impediu o foco; nenhuma tecla foi enviada.'
    }
    Assert-StagForeground $target
}

function Get-StagCoordinateWindow($target, [int]$x, [int]$y) {
    $window = [StagWindow]::GetAncestor([StagWindow]::WindowAt($x, $y), 2)
    Assert-StagWindow $target $window
    $bounds = [StagWindow]::Bounds($window)
    if ($x -lt $bounds[0] -or $y -lt $bounds[1] -or $x -ge ($bounds[0] + $bounds[2]) -or $y -ge ($bounds[1] + $bounds[3])) {
        throw 'STAG_DESKTOP_DENIED: Coordenadas fora da janela autorizada.'
    }
    return $window
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

# Main-only fixed gesture. Never focus another window, enumerate the desktop or send buttons/keys.
if ($request.action -eq 'nudge_cursor') {
    if ($request.stagPeriodicMovement -isnot [bool] -or $request.stagPeriodicMovement -ne $true) {
        throw 'STAG_DESKTOP_DENIED: Movimento periodico nao autorizado pelo main.'
    }
    # The host is bound by main to its exact HWND/PID, not by title, executable name or a tool argument.
    # This exception exists only inside the fixed gesture; other actions still use the signed allowlist.
    function Get-StagPulseHost([IntPtr]$window) {
        $handle = [long]0
        if (($request.stagHostProcessId -isnot [int] -and $request.stagHostProcessId -isnot [long]) -or
            $request.stagHostProcessId -le 0 -or $request.stagHostProcessId -gt [int]::MaxValue -or
            $request.stagHostWindow -isnot [string] -or $request.stagHostWindow -notmatch '^[1-9][0-9]{0,18}$' -or
            -not [long]::TryParse($request.stagHostWindow, [ref]$handle) -or
            $window.ToInt64() -ne $handle -or
            [StagWindow]::WindowProcessId($window) -ne $request.stagHostProcessId) { return $null }
        try { $hostTarget = Get-Process -Id ([int]$request.stagHostProcessId) -ErrorAction Stop }
        catch { throw 'STAG_DESKTOP_DENIED: Janela do STAG Plus indisponivel.' }
        Assert-StagWindow $hostTarget $window
        return $hostTarget
    }
    $moved = $false
    $reason = 'unverified_target'
    try {
        $window = [StagWindow]::GetForegroundWindow()
        $target = Get-StagPulseHost $window
        if (-not $target) { $target = Get-StagAllowedProcess ([int][StagWindow]::WindowProcessId($window)) }
        if ($target.ProcessName -ieq 'FortiClient') {
            '{"moved":false,"reason":"forticlient"}'
            return
        }
        if ([StagWindow]::ButtonsPressed()) {
            '{"moved":false,"reason":"buttons_pressed"}'
            return
        }
        $origin = [StagWindow]::Cursor()
        $reason = 'cursor_outside'
        if ((Get-StagCoordinateWindow $target $origin[0] $origin[1]) -ne $window) {
            throw 'STAG_DESKTOP_DENIED: Cursor fora da janela em primeiro plano.'
        }
        $bounds = [StagWindow]::Bounds($window)
        $dx = if ($origin[0] + 2 -lt $bounds[0] + $bounds[2]) { 2 } else { -2 }
        $x = $origin[0] + $dx
        $y = $origin[1]
        $reason = 'target_changed'
        if ((Get-StagCoordinateWindow $target $x $y) -ne $window) {
            throw 'STAG_DESKTOP_DENIED: Destino do cursor mudou.'
        }
        $current = [StagWindow]::Cursor()
        if ([StagWindow]::ButtonsPressed()) {
            '{"moved":false,"reason":"buttons_pressed"}'
            return
        }
        if (($current -join ',') -ne ($origin -join ',')) {
            '{"moved":false,"reason":"pointer_busy"}'
            return
        }
        Assert-StagForeground $target
        if ([StagWindow]::GetForegroundWindow() -ne $window -or
            (Get-StagCoordinateWindow $target $x $y) -ne $window) {
            throw 'STAG_DESKTOP_DENIED: Alvo mudou antes do movimento.'
        }
        Move-StagCursor $x $y
        $moved = $true
        # Do not undo a user's concurrent movement or drag, or restore over a different program.
        $current = [StagWindow]::Cursor()
        if ($current[0] -eq $x -and $current[1] -eq $y -and -not [StagWindow]::ButtonsPressed() -and
            [StagWindow]::GetForegroundWindow() -eq $window -and
            (Get-StagCoordinateWindow $target $origin[0] $origin[1]) -eq $window) {
            Assert-StagForeground $target
            Move-StagCursor $origin[0] $origin[1]
        }
    } catch {
        if ($_.Exception.Message -notmatch 'STAG_DESKTOP_DENIED') { throw }
    }
    if ($moved) { '{"moved":true}' }
    else { @{ moved = $false; reason = $reason } | ConvertTo-Json -Compress }
    return
}

if ($request.action -ne 'list_windows') {
    if (-not $request.processId -or [int]$request.processId -le 0) { throw 'STAG_DESKTOP_DENIED: processId obrigatorio.' }
    $target = Get-StagAllowedProcess ([int]$request.processId)
}

# Classify the verified executable, never a title, model-provided name or risk label.
$fortiInteraction = $request.action -in @('click', 'type_text', 'send_keys') -and
    $target -and $target.ProcessName -ieq 'FortiClient'
if ($request.stagCheckOnly -eq $true) {
    if ($request.action -notin @('click', 'type_text', 'send_keys')) { throw 'STAG_DESKTOP_DENIED: Inspecao invalida.' }
    @{ processId = $target.Id; requiresConfirmation = [bool]$fortiInteraction } | ConvertTo-Json -Compress
    return
}
if ($fortiInteraction -and $request.stagCriticalApproved -ne $true) {
    throw 'STAG_DESKTOP_APPROVAL_REQUIRED: FortiClient requer confirmacao especifica antes de enviar entrada.'
}

switch ($request.action) {
    'list_windows' {
        $windows = @(foreach ($candidate in (Get-Process | Where-Object { $_.MainWindowHandle -ne 0 -and $_.MainWindowTitle })) {
            try {
                $allowed = Get-StagAllowedProcess $candidate.Id
                [pscustomobject]@{ processId = $allowed.Id; title = $allowed.MainWindowTitle; process = $allowed.ProcessName }
            } catch { continue }
        })
        ConvertTo-Json -InputObject $windows -Compress
    }
    'screenshot' {
        Assert-StagWindow $target $target.MainWindowHandle
        $before = [StagWindow]::Bounds($target.MainWindowHandle)
        $image = [StagWindow]::Capture($target.MainWindowHandle)
        Assert-StagWindow $target $target.MainWindowHandle
        $after = [StagWindow]::Bounds($target.MainWindowHandle)
        if (($before -join ',') -ne ($after -join ',')) { throw 'STAG_DESKTOP_DENIED: A janela mudou durante a captura; capture novamente.' }
        @{
            processId = $target.Id
            bounds = @{ x = $before[0]; y = $before[1]; width = $before[2]; height = $before[3] }
            imageBase64 = $image
        } | ConvertTo-Json -Depth 4 -Compress
    }
    'focus_window' {
        Focus-StagWindow $target $target.MainWindowHandle
        '{"ok":true}'
    }
    'send_keys' {
        # One app-local chord per call. System navigation and composite SendKeys cannot escape the allowlist.
        $keys = [string]$request.keys
        if ($keys -notmatch '^[+^%]*(?:[a-z0-9]|\{(?:ENTER|RETURN|TAB|ESC|ESCAPE|UP|DOWN|LEFT|RIGHT|HOME|END|PGUP|PGDN|DEL|DELETE|BACKSPACE|BS|F[1-9]|F1[0-2])\})$' -or
            ($keys.Contains('%') -and $keys -match '\{(?:TAB|ESC|ESCAPE)\}' ) -or
            ($keys.Contains('^') -and $keys -match '\{(?:ESC|ESCAPE)\}')) {
            throw 'STAG_DESKTOP_DENIED: Atalho global ou composto; envie um atalho do aplicativo por chamada.'
        }
        Focus-StagWindow $target $target.MainWindowHandle
        Add-Type -AssemblyName System.Windows.Forms
        Assert-StagForeground $target
        [Windows.Forms.SendKeys]::SendWait($keys)
        '{"ok":true}'
    }
    'type_text' {
        Focus-StagWindow $target $target.MainWindowHandle
        Add-Type -AssemblyName System.Windows.Forms
        # Revalidate between characters, including Enter/Tab which can change windows.
        foreach ($character in ([regex]::Matches([string]$request.text, '\r\n|[\uD800-\uDBFF][\uDC00-\uDFFF]|[\s\S]'))) {
            Assert-StagForeground $target
            [Windows.Forms.SendKeys]::SendWait((ConvertTo-StagLiteralKeys $character.Value))
        }
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
        $coordinateWindow = Get-StagCoordinateWindow $target ([int]$request.x) ([int]$request.y)
        Focus-StagWindow $target $coordinateWindow
        for ($i = 0; $i -lt $clicks; $i++) {
            Assert-StagForeground $target
            $null = Get-StagCoordinateWindow $target ([int]$request.x) ([int]$request.y)
            Move-StagCursor ([int]$request.x) ([int]$request.y)
            $null = Get-StagCoordinateWindow $target ([int]$request.x) ([int]$request.y)
            Assert-StagForeground $target
            [StagWindow]::mouse_event($down, 0, 0, 0, [UIntPtr]::Zero)
            [StagWindow]::mouse_event($up, 0, 0, 0, [UIntPtr]::Zero)
            if ($i -lt ($clicks - 1)) { Start-Sleep -Milliseconds 80 }
        }
        '{"ok":true}'
    }
    'scroll' {
        $delta = [int]$request.delta
        if ($delta -eq 0 -or $delta -lt -1200 -or $delta -gt 1200) { throw 'Rolagem invalida.' }
        $coordinateWindow = Get-StagCoordinateWindow $target ([int]$request.x) ([int]$request.y)
        Focus-StagWindow $target $coordinateWindow
        Assert-StagForeground $target
        Move-StagCursor ([int]$request.x) ([int]$request.y)
        $null = Get-StagCoordinateWindow $target ([int]$request.x) ([int]$request.y)
        Assert-StagForeground $target
        # Win32 expects the two's-complement DWORD representation for a negative delta.
        $wheelData = [BitConverter]::ToUInt32([BitConverter]::GetBytes($delta), 0)
        [StagWindow]::mouse_event(0x0800, 0, 0, $wheelData, [UIntPtr]::Zero)
        '{"ok":true}'
    }
    default { throw 'Acao de desktop nao suportada.' }
}
