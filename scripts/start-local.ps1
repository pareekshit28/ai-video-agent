$ErrorActionPreference = 'Stop'
$projectDirectory = Split-Path -Parent $PSScriptRoot
Set-Location -LiteralPath $projectDirectory
if (-not (Get-Command node.exe -ErrorAction SilentlyContinue)) {
    $nodeDirectory = 'C:\Program Files\nodejs'
    if (-not (Test-Path -LiteralPath (Join-Path $nodeDirectory 'node.exe'))) {
        throw 'Install Node.js 20.9 or later, then run this script again.'
    }
    $env:PATH = $nodeDirectory + ';' + $env:PATH
}
if (-not (Test-Path -LiteralPath (Join-Path $projectDirectory 'node_modules\next\package.json'))) {
    & npm.cmd ci
    if ($LASTEXITCODE -ne 0) { throw 'Dependency installation failed.' }
}
Write-Host 'Open http://127.0.0.1:3000 after signing in to Codex CLI.'
& npm.cmd run dev
exit $LASTEXITCODE
