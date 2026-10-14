param(
  [string]$EnvPath
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"
. (Join-Path $PSScriptRoot "load-env.ps1")

if (!$EnvPath) { $EnvPath = $DefaultEnvPath }
Import-BridgeEnv -Path $EnvPath | Out-Null

if (!$env:BRIDGE_PUBLIC_URL) { throw "BRIDGE_PUBLIC_URL is not set." }
$port = if ($env:BRIDGE_PORT) { $env:BRIDGE_PORT } else { "3030" }
$publicUrl = $env:BRIDGE_PUBLIC_URL.TrimEnd("/")

Write-Host "Local health:" -ForegroundColor Cyan
Invoke-RestMethod "http://127.0.0.1:$port/health" | ConvertTo-Json

Write-Host "Public health:" -ForegroundColor Cyan
Invoke-RestMethod "$publicUrl/health" | ConvertTo-Json

Write-Host "OAuth metadata:" -ForegroundColor Cyan
Invoke-RestMethod "$publicUrl/.well-known/oauth-authorization-server" | ConvertTo-Json

Write-Host "Protected resource metadata:" -ForegroundColor Cyan
Invoke-RestMethod "$publicUrl/.well-known/oauth-protected-resource/mcp" | ConvertTo-Json
