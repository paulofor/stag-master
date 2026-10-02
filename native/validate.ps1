param([Parameter(Mandatory = $true)][string]$ScriptPath)
$ErrorActionPreference = 'Stop'
$tokens = $null
$parseErrors = $null
$ast = [System.Management.Automation.Language.Parser]::ParseFile($ScriptPath, [ref]$tokens, [ref]$parseErrors)
if ($parseErrors.Count -gt 0) {
    $parseErrors | ForEach-Object { Write-Error $_ }
    exit 1
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
Write-Output 'PowerShell parser and literal text contracts OK; no desktop automation executed.'
