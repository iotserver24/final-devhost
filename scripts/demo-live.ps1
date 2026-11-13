# Local live demo for Windows. Monitoring and rollback stay off. Does not print secrets.
$ErrorActionPreference = 'Stop'

Set-Location (Join-Path $PSScriptRoot '..')

$env:CONTROLLER_MONITOR_ENABLED = 'false'
$env:CONTROLLER_ROLLBACK_ENABLED = 'false'

$port = if ($env:CONTROLLER_PORT) { $env:CONTROLLER_PORT } else { '8787' }
$envFile = Join-Path (Get-Location) 'apps/controller/.env'
if (Test-Path $envFile) {
    $filePort = (Get-Content $envFile | Where-Object { $_ -match '^CONTROLLER_PORT=' } | Select-Object -First 1) -replace '^CONTROLLER_PORT=', ''
    if ($filePort) { $port = $filePort }
}
$env:CONTROLLER_PORT = $port
$env:CONTROLLER_API_URL = "http://127.0.0.1:$port"

Write-Host 'Nexathon live desk'
Write-Host "  Controller: http://127.0.0.1:$port (monitoring off, rollback off)"
Write-Host '  Dashboard:  http://127.0.0.1:5173'
Write-Host ''
Write-Host 'Talk track: this view is the local controller, not rehearsal fixtures.'
Write-Host 'Rollback is disabled. A fix, if you start one, is a draft pull request for review.'
Write-Host ''
Write-Host 'After an incident exists, start an AI remediation run from a new shell:'
Write-Host '  bun run --cwd apps/controller start:run -- --incident=<incident id>'
Write-Host 'Add --rehearsal to walk the same phases with placeholder text and no model call.'
Write-Host ''

$controller = Start-Process -FilePath 'bun' -ArgumentList 'run', '--cwd', 'apps/controller', 'start' -PassThru -NoNewWindow
try {
    for ($i = 0; $i -lt 10; $i++) {
        try {
            Invoke-WebRequest -Uri "http://127.0.0.1:$port/api/incidents" -UseBasicParsing -TimeoutSec 1 | Out-Null
            break
        } catch { Start-Sleep -Milliseconds 300 }
    }
    bun run --cwd apps/dashboard dev
} finally {
    if ($controller -and -not $controller.HasExited) { Stop-Process -Id $controller.Id -Force -ErrorAction SilentlyContinue }
}
