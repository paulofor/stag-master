$ErrorActionPreference = 'Stop'
[Console]::InputEncoding = New-Object System.Text.UTF8Encoding
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding
$encoded = [Console]::In.ReadToEnd()
$request = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($encoded)) | ConvertFrom-Json
# Only synthetic data; no window enumeration, Forms, user32, mouse or keyboard.
@{
    request = $request
    processPolicy = (Get-ExecutionPolicy -Scope Process).ToString()
    windows = @(@{ processId = 4242; title = 'Synthetic editor'; process = 'fixture' })
} | ConvertTo-Json -Depth 5 -Compress
