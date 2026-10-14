param(
  [string]$CallbackUrl,
  [string]$Name = "PC_CON",
  [string]$PublicUrl,
  [string]$EnvPath = "../.env"
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

if (Test-Path -LiteralPath $EnvPath) {
  Get-Content -LiteralPath $EnvPath | ForEach-Object {
    $line = $_.Trim()
    if (!$line -or $line.StartsWith("#")) { return }
    $parts = $line.Split("=", 2)
    if ($parts.Count -ne 2) { return }
    $key = $parts[0].Trim()
    $value = $parts[1].Trim().Trim('"').Trim("'")
    [Environment]::SetEnvironmentVariable($key, $value, "Process")
  }
}

if (!$PublicUrl) { $PublicUrl = $env:BRIDGE_PUBLIC_URL }
if (!$PublicUrl) { throw "BRIDGE_PUBLIC_URL is not set. Pass -PublicUrl or set it in .env." }
$PublicUrl = $PublicUrl.TrimEnd("/")

if (!$env:BRIDGE_OAUTH_SETUP_SECRET) { throw "BRIDGE_OAUTH_SETUP_SECRET is not set. Set it in .env or the current shell." }

if (!$CallbackUrl) {
  $callbackInput = Read-Host "ChatGPT callback URL or callback ID"
  if (!$callbackInput) { throw "Callback URL or callback ID is required." }
  if ($callbackInput -match "^https?://") {
    $CallbackUrl = $callbackInput
  } else {
    $CallbackUrl = "https://chatgpt.com/connector/oauth/$callbackInput"
  }
}

$body = @{
  redirect_uris = @($CallbackUrl)
  client_name = $Name
  setup_secret = $env:BRIDGE_OAUTH_SETUP_SECRET
} | ConvertTo-Json

$result = Invoke-RestMethod `
  -Uri "$PublicUrl/register" `
  -Method Post `
  -ContentType "application/json" `
  -Body $body

Write-Host ""
Write-Host "Paste these into ChatGPT Advanced OAuth settings:" -ForegroundColor Cyan
Write-Host "Connector URL: $PublicUrl/mcp"
Write-Host "Registration method: User-Defined OAuth Client"
Write-Host "OAuth Client ID: $($result.client_id)"
Write-Host "OAuth Client Secret: $($result.client_secret)"
Write-Host "Token endpoint auth method: client_secret_post"
Write-Host "Auth URL: $PublicUrl/authorize"
Write-Host "Token URL: $PublicUrl/token"
Write-Host "Registration URL: leave blank"
Write-Host "Authorization server base: $PublicUrl"
Write-Host "Resource: $PublicUrl/mcp"
Write-Host "Default scopes: mcp:read mcp:write"
Write-Host "Base scopes: mcp:read mcp:write"