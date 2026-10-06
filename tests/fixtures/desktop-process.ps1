$ErrorActionPreference = 'Stop'
[Console]::InputEncoding = New-Object System.Text.UTF8Encoding
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding
$encoded = [Console]::In.ReadToEnd()
$request = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($encoded)) | ConvertFrom-Json
# Only synthetic data; no window enumeration, Forms, user32, mouse or keyboard.
if ($request.action -eq 'open_forticlient') {
    if ((Get-ExecutionPolicy -Scope Process) -ne 'Bypass') { throw 'Synthetic console policy contract failed.' }
    if ($request.stagCheckOnly -eq $true) {
        '{"requiresConfirmation":true}'
    } elseif ($request.stagCriticalApproved -eq $true) {
        '{"opened":true}'
    } else { throw 'STAG_DESKTOP_APPROVAL_REQUIRED: Synthetic console requires approval.' }
    return
}
if ($request.action -eq 'nudge_cursor') {
    if ($request.stagPeriodicMovement -ne $true -or
        (($request.PSObject.Properties.Name | Sort-Object) -join ',') -ne 'action,stagPeriodicMovement' -or
        (Get-ExecutionPolicy -Scope Process) -ne 'Bypass') {
        throw 'Synthetic periodic driver contract failed.'
    }
    '{"moved":false}'
    return
}
@{
    request = $request
    processPolicy = (Get-ExecutionPolicy -Scope Process).ToString()
    windows = @(@{ processId = 4242; title = 'Synthetic editor'; process = 'fixture' })
} | ConvertTo-Json -Depth 5 -Compress
