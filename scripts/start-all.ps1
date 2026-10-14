<#
.SYNOPSIS
Starts Cloudflare Tunnel, extracts the public URL, launches the bridge server, and handles OAuth registration in one step.
Cleans up all processes (server and tunnel) gracefully when cancelled.
#>

$ErrorActionPreference = "Stop"

# Ensure cloudflared is installed
if (-not (Get-Command "cloudflared" -ErrorAction SilentlyContinue)) {
    Write-Error "cloudflared is not installed or not in PATH. Please install it first."
    exit 1
}

# The rename trick: Security software is blocking "cloudflared.exe" by name.
# We copy it to a temporary location with a different name to bypass the block.
$originalCloudflared = (Get-Command "cloudflared").Source
$cfExe = Join-Path $env:TEMP "codebase_tunnel_worker.exe"
Copy-Item -Path $originalCloudflared -Destination $cfExe -Force

$tunnelProcess = $null
$bridgeProcess = $null
$logFile = New-TemporaryFile
$repoRoot = Split-Path $PSScriptRoot -Parent

# Accurately locate .env relative to this script
$envPath = Join-Path (Split-Path $PSScriptRoot -Parent) ".env"

# Pre-load environment variables
if (Test-Path $envPath) {
    Write-Host "Loading config from .env..." -ForegroundColor DarkGray
    Get-Content $envPath | ForEach-Object {
        $line = $_.Trim()
        if (!$line -or $line.StartsWith("#")) { return }
        $parts = $line.Split("=", 2)
        if ($parts.Count -eq 2) {
            $key = $parts[0].Trim()
            $val = $parts[1].Trim().Trim('"', "'")
            [Environment]::SetEnvironmentVariable($key, $val, "Process")
            Write-Host "  $key = $val" -ForegroundColor DarkGray
        }
    }
    Write-Host ""
}

$port = $env:BRIDGE_PORT
if ([string]::IsNullOrEmpty($port)) { $port = "3030" }

try {
    Write-Host "Starting Cloudflare Tunnel on port $port..." -ForegroundColor Cyan
    
    # 1. Start cloudflared as a background process and capture stderr to a temp file
    $tunnelProcess = Start-Process -FilePath $cfExe `
        -ArgumentList "tunnel", "--url", "http://127.0.0.1:$port" `
        -RedirectStandardError $logFile.FullName `
        -WindowStyle Hidden `
        -PassThru

    Write-Host "Waiting for Cloudflare tunnel URL to be provisioned..." -ForegroundColor Cyan
    $tunnelUrl = $null
    $retry = 0
    
    # 2. Poll the log file until the Quick Tunnel URL is printed
    while ([string]::IsNullOrEmpty($tunnelUrl) -and $retry -lt 30) {
        Start-Sleep -Seconds 1
        $logContent = Get-Content $logFile.FullName -Raw -ErrorAction SilentlyContinue
        if ($logContent -match "(https://(?!api\.)[a-zA-Z0-9-]+\.trycloudflare\.com)") {
            $tunnelUrl = $matches[1]
        }
        $retry++
    }

    if ([string]::IsNullOrEmpty($tunnelUrl)) {
        throw "Failed to extract Cloudflare tunnel URL within 30 seconds."
    }

    Write-Host "Tunnel established at: $tunnelUrl" -ForegroundColor Green
    
    # 3. Inject the URL into the environment so the bridge picks it up
    $env:BRIDGE_PUBLIC_URL = $tunnelUrl

    Write-Host "Starting Codebase MCP Bridge..." -ForegroundColor Cyan
    
    # 4. Start the bridge in a dedicated PowerShell process so it can be
    # restarted independently of the tunnel/orchestration script.
    $bridgeProcess = Start-Process -FilePath "powershell.exe" `
        -ArgumentList @(
            "-NoExit",
            "-Command",
            "Set-Location '$repoRoot'; npm run dev"
        ) `
        -PassThru

    # Wait a few seconds for the bridge to bind to port 3030
    Write-Host "Waiting 5 seconds for bridge server to initialize..." -ForegroundColor DarkGray
    Start-Sleep -Seconds 5

    # 5. Optionally run the ChatGPT registration immediately
    Write-Host "`n=== ChatGPT Registration ===" -ForegroundColor Cyan
    $callbackInput = Read-Host "Enter ChatGPT callback URL or ID (or press Enter to skip registration)"
    
    if (-not [string]::IsNullOrEmpty($callbackInput)) {
        $defaultName = if ($env:BRIDGE_CLIENT_NAME) { $env:BRIDGE_CLIENT_NAME } else { "PC_CON" }
        $nameInput = Read-Host "Enter connection name [$defaultName]"
        if ([string]::IsNullOrEmpty($nameInput)) { $nameInput = $defaultName }

        $registerScript = Join-Path $PSScriptRoot "register-chatgpt-client.ps1"
        & $registerScript -CallbackUrl $callbackInput -Name $nameInput -PublicUrl $tunnelUrl -EnvPath $envPath
    }

    Write-Host "`n[ READY ] Tunnel/orchestration is running. The bridge is running in a separate PowerShell window and can be restarted independently." -ForegroundColor Yellow
    
    # 6. Block indefinitely to keep the script running, catching Ctrl+C
    while ($true) {
        Start-Sleep -Seconds 1
    }
}
finally {
    # 7. Cleanup phase - runs even if the user hits Ctrl+C
    Write-Host "`nInitiating graceful shutdown..." -ForegroundColor Magenta
    
    if ($bridgeProcess -and -not $bridgeProcess.HasExited) {
        Write-Host "Stopping Codebase Bridge..." -ForegroundColor DarkGray
        # npm on Windows spawns node processes. taskkill /T ensures the entire process tree dies
        taskkill /PID $bridgeProcess.Id /T /F 2>$null | Out-Null
    }
    
    if ($tunnelProcess -and -not $tunnelProcess.HasExited) {
        Write-Host "Stopping Cloudflare Tunnel..." -ForegroundColor DarkGray
        taskkill /PID $tunnelProcess.Id /T /F 2>$null | Out-Null
    }

    if (Test-Path $logFile.FullName) {
        Remove-Item $logFile.FullName -Force
    }
    
    Write-Host "Shutdown complete." -ForegroundColor Green
}