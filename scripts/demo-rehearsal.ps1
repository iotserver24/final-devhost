# Rehearsal dashboard for Windows: fixture incidents only, no controller, no cloud calls.
$ErrorActionPreference = 'Stop'

Set-Location (Join-Path $PSScriptRoot '..')

Write-Host 'Nexathon rehearsal desk (fixture data)'
Write-Host '  Dashboard: http://127.0.0.1:5173'
Write-Host 'The header will say "Rehearsal data". Nothing calls Vercel, GitHub, Slack, or rollback.'
Write-Host ''

$env:NEXT_PUBLIC_DATA_MODE = 'fixtures'
bun run --cwd apps/dashboard dev
