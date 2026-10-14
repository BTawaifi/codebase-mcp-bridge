<#
.SYNOPSIS
Starts a Cloudflare quick tunnel, extracts the public URL, launches the bridge with it, and optionally registers a
ChatGPT OAuth client, in one step. Stops the bridge and the tunnel when you press Ctrl+C.

.NOTES
Windows only (uses taskkill). Set CLOUDFLARED_PATH to use a cloudflared binary that isn't on PATH.
#>

$ErrorActionPreference = "Stop"
. (Join-Path $PSScriptRoot "load-env.ps1")

$cloudflared = if ($env:CLOUDFLARED_PATH) { $env:CLOUDFLARED_PATH } else { (Get-Command "cloudflared" -ErrorAction SilentlyContinue).Source }
if (!$cloudflared -or !(Test-Path -LiteralPath $cloudflared)) {
    Write-Error "cloudflared was not found. Install it, or set CLOUDFLARED_PATH to its location."
    exit 1
}

$tunnelProcess = $null
$bridgeProcess = $null
$logFile = New-TemporaryFile
$envPath = $DefaultEnvPath

$loadedKeys = Import-BridgeEnv -Path $envPath
if ($loadedKeys) {
    # Key names only: .env can hold BRIDGE_OAUTH_SETUP_SECRET.
    Write-Host "Loaded from .env: $($loadedKeys -join ', ')" -ForegroundColor DarkGray
}

$port = if ($env:BRIDGE_PORT) { $env:BRIDGE_PORT } else { "3030" }

try {
    Write-Host "Starting Cloudflare Tunnel on port $port..." -ForegroundColor Cyan
    $tunnelProcess = Start-Process -FilePath $cloudflared `
        -ArgumentList "tunnel", "--url", "http://127.0.0.1:$port" `
        -RedirectStandardError $logFile.FullName `
        -WindowStyle Hidden `
        -PassThru

    Write-Host "Waiting for the tunnel URL..." -ForegroundColor Cyan
    $tunnelUrl = $null
    for ($i = 0; $i -lt 30 -and !$tunnelUrl; $i++) {
        Start-Sleep -Seconds 1
        $logContent = Get-Content $logFile.FullName -Raw -ErrorAction SilentlyContinue
        if ($logContent -match "(https://(?!api\.)[a-zA-Z0-9-]+\.trycloudflare\.com)") { $tunnelUrl = $matches[1] }
        if ($tunnelProcess.HasExited) { throw "cloudflared exited early (code $($tunnelProcess.ExitCode)). Log: $logContent" }
    }
    if (!$tunnelUrl) { throw "Failed to get a Cloudflare tunnel URL within 30 seconds." }
    Write-Host "Tunnel established at: $tunnelUrl" -ForegroundColor Green

    # The bridge process inherits this, so OAuth metadata advertises the public URL.
    $env:BRIDGE_PUBLIC_URL = $tunnelUrl

    Write-Host "Starting Codebase MCP Bridge..." -ForegroundColor Cyan
    # Separate window so the bridge can be restarted without dropping the tunnel.
    $shell = if (Get-Command "pwsh" -ErrorAction SilentlyContinue) { "pwsh" } else { "powershell.exe" }
    $quotedRoot = $BridgeRepoRoot.Replace("'", "''")
    $bridgeProcess = Start-Process -FilePath $shell `
        -ArgumentList @("-NoExit", "-Command", "Set-Location -LiteralPath '$quotedRoot'; npm run dev") `
        -PassThru

    Write-Host "Waiting for the bridge to report healthy..." -ForegroundColor DarkGray
    $healthy = $false
    for ($i = 0; $i -lt 60 -and !$healthy; $i++) {
        try { Invoke-RestMethod "http://127.0.0.1:$port/health" -TimeoutSec 2 | Out-Null; $healthy = $true }
        catch { Start-Sleep -Seconds 1 }
    }
    if (!$healthy) { throw "The bridge did not answer http://127.0.0.1:$port/health within 60 seconds. Check its window for errors." }

    Write-Host "`n=== ChatGPT Registration ===" -ForegroundColor Cyan
    $callbackInput = Read-Host "Enter ChatGPT callback URL or ID (or press Enter to skip registration)"
    if ($callbackInput) {
        $defaultName = if ($env:BRIDGE_CLIENT_NAME) { $env:BRIDGE_CLIENT_NAME } else { "PC_CON" }
        $nameInput = Read-Host "Enter connection name [$defaultName]"
        if (!$nameInput) { $nameInput = $defaultName }
        & (Join-Path $PSScriptRoot "register-chatgpt-client.ps1") -CallbackUrl $callbackInput -Name $nameInput -PublicUrl $tunnelUrl -EnvPath $envPath
    }

    Write-Host "`n[ READY ] Tunnel is running; the bridge runs in its own window and can be restarted independently. Ctrl+C stops both." -ForegroundColor Yellow
    while ($true) { Start-Sleep -Seconds 1 }
}
finally {
    Write-Host "`nShutting down..." -ForegroundColor Magenta
    # npm spawns child node processes; /T kills the whole tree.
    if ($bridgeProcess -and -not $bridgeProcess.HasExited) { taskkill /PID $bridgeProcess.Id /T /F 2>$null | Out-Null }
    if ($tunnelProcess -and -not $tunnelProcess.HasExited) { taskkill /PID $tunnelProcess.Id /T /F 2>$null | Out-Null }
    if (Test-Path $logFile.FullName) { Remove-Item $logFile.FullName -Force }
    Write-Host "Shutdown complete." -ForegroundColor Green
}
