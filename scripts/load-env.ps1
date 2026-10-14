# Shared .env loader for the bridge's PowerShell scripts. Dot-source it, then call Import-BridgeEnv.
# Values are set for this process only and never printed (the file can hold BRIDGE_OAUTH_SETUP_SECRET).

$script:BridgeRepoRoot = Split-Path $PSScriptRoot -Parent
$script:DefaultEnvPath = Join-Path $script:BridgeRepoRoot ".env"

function Import-BridgeEnv {
  param([string]$Path = $script:DefaultEnvPath)

  if (!(Test-Path -LiteralPath $Path)) { return @() }
  $loaded = @()
  foreach ($raw in Get-Content -LiteralPath $Path) {
    $line = $raw.Trim()
    if (!$line -or $line.StartsWith("#")) { continue }
    $parts = $line.Split("=", 2)
    if ($parts.Count -ne 2) { continue }
    $key = $parts[0].Trim()
    $value = $parts[1].Trim()
    if ($value.Length -ge 2 -and (($value[0] -eq '"' -and $value[-1] -eq '"') -or ($value[0] -eq "'" -and $value[-1] -eq "'"))) {
      $value = $value.Substring(1, $value.Length - 2)
    }
    [Environment]::SetEnvironmentVariable($key, $value, "Process")
    $loaded += $key
  }
  return $loaded
}
