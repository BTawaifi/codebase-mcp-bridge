param(
  [string]$EnvPath = "../.env"
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

if (!(Test-Path -LiteralPath $EnvPath)) {
  throw "Missing $EnvPath. Create it from .env.example first."
}

Get-Content -LiteralPath $EnvPath | ForEach-Object {
  $line = $_.Trim()
  if (!$line -or $line.StartsWith("#")) { return }
  $parts = $line.Split("=", 2)
  if ($parts.Count -ne 2) { return }
  [Environment]::SetEnvironmentVariable($parts[0].Trim(), $parts[1].Trim(), "Process")
}

Write-Host "BRIDGE_PUBLIC_URL=$env:BRIDGE_PUBLIC_URL"
Write-Host "BRIDGE_REPO_ROOT=$env:BRIDGE_REPO_ROOT"
Write-Host "Starting bridge..."
npm run dev