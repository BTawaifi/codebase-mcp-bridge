Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$scripts = Get-ChildItem -Path "scripts" -Filter "*.ps1" -File
if (!$scripts) {
  Write-Host "No PowerShell scripts found."
  exit 0
}

$failed = $false
foreach ($script in $scripts) {
  $tokens = $null
  $parseErrors = $null
  [System.Management.Automation.Language.Parser]::ParseFile($script.FullName, [ref]$tokens, [ref]$parseErrors) | Out-Null
  if ($parseErrors.Count -gt 0) {
    $failed = $true
    foreach ($parseError in $parseErrors) {
      Write-Error "$($script.FullName):$($parseError.Extent.StartLineNumber):$($parseError.Message)"
    }
  }
}

if ($failed) { exit 1 }
Write-Host "PowerShell syntax OK: $($scripts.Count) script(s)."
