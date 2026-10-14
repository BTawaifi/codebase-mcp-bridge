param(
  [string]$EnvPath
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"
. (Join-Path $PSScriptRoot "load-env.ps1")

if (!$EnvPath) { $EnvPath = $DefaultEnvPath }
if (!(Test-Path -LiteralPath $EnvPath)) {
  throw "Missing $EnvPath. Create it from .env.example first."
}
Import-BridgeEnv -Path $EnvPath | Out-Null

Write-Host "BRIDGE_PUBLIC_URL=$env:BRIDGE_PUBLIC_URL"
Write-Host "BRIDGE_REPO_ROOT=$env:BRIDGE_REPO_ROOT"
Write-Host "Starting bridge..."
Set-Location -LiteralPath $BridgeRepoRoot
npm run dev
