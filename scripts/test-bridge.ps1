param(
  [string]$EnvPath = ".env"
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

if (Test-Path -LiteralPath $EnvPath) {
  Get-Content -LiteralPath $EnvPath | ForEach-Object {
    $line = $_.Trim()
    if (!$line -or $line.StartsWith("#")) { return }
    $parts = $line.Split("=", 2)
    if ($parts.Count -ne 2) { return }
    [Environment]::SetEnvironmentVariable($parts[0].Trim(), $parts[1].Trim(), "Process")
  }
}

if (!$env:BRIDGE_PUBLIC_URL) { throw "BRIDGE_PUBLIC_URL is not set." }

Write-Host "Local health:" -ForegroundColor Cyan
Invoke-RestMethod "http://127.0.0.1:3030/health" | ConvertTo-Json

Write-Host "Public health:" -ForegroundColor Cyan
Invoke-RestMethod "$env:BRIDGE_PUBLIC_URL/health" | ConvertTo-Json

Write-Host "OAuth metadata:" -ForegroundColor Cyan
Invoke-RestMethod "$env:BRIDGE_PUBLIC_URL/.well-known/oauth-authorization-server" | ConvertTo-Json

Write-Host "Protected resource metadata:" -ForegroundColor Cyan
Invoke-RestMethod "$env:BRIDGE_PUBLIC_URL/.well-known/oauth-protected-resource/mcp" | ConvertTo-Json