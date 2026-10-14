param(
  [string]$CallbackUrl,
  [string]$Name = "PC_CON",
  [string]$PublicUrl,
  [string]$EnvPath
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"
. (Join-Path $PSScriptRoot "load-env.ps1")

if (!$EnvPath) { $EnvPath = $DefaultEnvPath }
Import-BridgeEnv -Path $EnvPath | Out-Null

if (!$PublicUrl) { $PublicUrl = $env:BRIDGE_PUBLIC_URL }
if (!$PublicUrl) { throw "BRIDGE_PUBLIC_URL is not set. Pass -PublicUrl or set it in .env." }
$PublicUrl = $PublicUrl.TrimEnd("/")

if (!$env:BRIDGE_OAUTH_SETUP_SECRET) { throw "BRIDGE_OAUTH_SETUP_SECRET is not set. Set it in .env or the current shell." }

if (!$CallbackUrl) {
  $CallbackUrl = Read-Host "ChatGPT callback URL or callback ID"
  if (!$CallbackUrl) { throw "Callback URL or callback ID is required." }
}
# Accept either the full callback URL or just the ID ChatGPT shows, however the value arrived.
if ($CallbackUrl -notmatch "^https?://") {
  $CallbackUrl = "https://chatgpt.com/connector/oauth/$CallbackUrl"
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
