param([Parameter(Mandatory = $true)][string]$ScriptPath)
$ErrorActionPreference = 'Stop'
$tokens = $null
$parseErrors = $null
$ast = [System.Management.Automation.Language.Parser]::ParseFile($ScriptPath, [ref]$tokens, [ref]$parseErrors)
if ($parseErrors.Count -gt 0) {
    $parseErrors | ForEach-Object { Write-Error $_ }
    exit 1
}
# Compile the production native type without invoking any Windows API. Synthetic dispatch tests
# replace that type, so compilation must be checked separately as well.
$nativeDefinition = $ast.Find({ param($node)
    $node -is [System.Management.Automation.Language.StringConstantExpressionAst] -and
    $node.Value.Contains('public static class StagWindow')
}, $true)
if ($null -eq $nativeDefinition) { throw 'Native window type missing.' }
$references = @('System', 'System.Drawing')
if ($PSVersionTable.PSEdition -eq 'Core') {
    $references += @('System.Drawing.Common', 'System.Drawing.Primitives', 'System.Runtime', 'System.ComponentModel.Primitives', 'System.Private.Windows.GdiPlus', 'System.Private.Windows.Core', 'System.Diagnostics.Process')
}
Add-Type -TypeDefinition $nativeDefinition.Value -ReferencedAssemblies $references
# Exercise only file sharing with a disposable synthetic executable, never the process launcher.
if ([Environment]::OSVersion.Platform -eq [PlatformID]::Win32NT) {
    $syntheticFile = [IO.Path]::GetTempFileName()
    $lease = $null
    try {
        [IO.File]::WriteAllText($syntheticFile, 'synthetic executable bytes')
        $lease = [StagWindow]::LockExecutable($syntheticFile)
        $blocked = $false
        try {
            $writer = [IO.File]::Open($syntheticFile, [IO.FileMode]::Open, [IO.FileAccess]::Write, [IO.FileShare]::ReadWrite)
            $writer.Dispose()
        } catch [IO.IOException] { $blocked = $true }
        if (-not $blocked) { throw 'Executable could be replaced while its identity was being checked.' }
        $lease.Dispose()
        $lease = $null
        [IO.File]::WriteAllText($syntheticFile, 'synthetic recovery')
    } finally {
        if ($lease) { $lease.Dispose() }
        [IO.File]::Delete($syntheticFile)
    }
}
# Execute only the pure escaping function extracted from the parsed, versioned script.
# No user32, windows, cursor, keyboard or screenshot is touched by these assertions.
$literalFunction = $ast.Find({ param($node)
    $node -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq 'ConvertTo-StagLiteralKeys'
}, $true)
if ($null -eq $literalFunction) { throw 'Literal text function missing.' }
. ([scriptblock]::Create($literalFunction.Extent.Text))
if ((ConvertTo-StagLiteralKeys '+^%~(){}[]') -cne '{+}{^}{%}{~}{(}{)}{{}{}}{[}{]}') {
    throw 'Literal metacharacters were interpreted as shortcuts.'
}
if ((ConvertTo-StagLiteralKeys "line1`r`nline2`t3") -cne 'line1{ENTER}line2{TAB}3') {
    throw 'Literal newline/tab conversion failed.'
}
if ((ConvertTo-StagLiteralKeys '{ENTER}') -cne '{{}ENTER{}}') {
    throw 'Literal key tokens were interpreted as shortcuts.'
}
Write-Output 'PowerShell parser, native C# compilation and literal text contracts OK; no desktop automation executed.'
