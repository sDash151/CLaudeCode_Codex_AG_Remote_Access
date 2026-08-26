# Requires: PowerShell. Run as your normal user; Tailscale install needs elevation.
#
# Sets up the secure remote path for the Agent Approval Gateway:
#   iPhone (Tailscale app)  ->  private tailnet  ->  HTTPS  ->  127.0.0.1:<port>
#
# Nothing is exposed to the internet. No port forwarding. No public hostname.
# The laptop makes only an outbound connection to the tailnet coordination server.
#
#   .\scripts\setup-tailscale.ps1            # guided setup
#   .\scripts\setup-tailscale.ps1 -Serve     # (re)configure HTTPS proxying only
#   .\scripts\setup-tailscale.ps1 -Status    # show current state

[CmdletBinding()]
param(
    [switch]$Serve,
    [switch]$Status,
    [int]$Port = 0
)

$ErrorActionPreference = 'Stop'

function Find-Tailscale {
    $candidates = @(
        "$env:ProgramFiles\Tailscale\tailscale.exe",
        "${env:ProgramFiles(x86)}\Tailscale\tailscale.exe"
    )
    foreach ($c in $candidates) { if (Test-Path $c) { return $c } }
    $cmd = Get-Command tailscale -ErrorAction SilentlyContinue
    if ($cmd) { return $cmd.Source }
    return $null
}

function Get-GatewayPort {
    if ($Port -gt 0) { return $Port }
    $home = if ($env:AGW_HOME) { $env:AGW_HOME } else { Join-Path $env:USERPROFILE '.agw' }
    $runtime = Join-Path $home 'gateway.json'
    if (Test-Path $runtime) {
        try { return (Get-Content $runtime -Raw | ConvertFrom-Json).port } catch { }
    }
    $cfg = Join-Path $home 'config.json'
    if (Test-Path $cfg) {
        try { return (Get-Content $cfg -Raw | ConvertFrom-Json).port } catch { }
    }
    return 8787
}

$ts = Find-Tailscale

# ---------------------------------------------------------------- install ----
if (-not $ts) {
    Write-Host ''
    Write-Host 'Tailscale is not installed.' -ForegroundColor Yellow
    Write-Host ''
    Write-Host 'Install it with one of:' -ForegroundColor Cyan
    Write-Host '    winget install --id Tailscale.Tailscale --accept-source-agreements'
    Write-Host '  or download from https://tailscale.com/download/windows'
    Write-Host ''
    Write-Host 'Then run this script again.'
    Write-Host ''
    Write-Host 'On the iPhone, install the free Tailscale app from the App Store and sign in'
    Write-Host 'with the SAME account. (That is an existing app - you are not publishing one,'
    Write-Host 'so no Apple Developer Program membership is involved.)'
    exit 1
}

Write-Host "tailscale: $ts" -ForegroundColor DarkGray

# ----------------------------------------------------------------- status ----
$statusJson = $null
try { $statusJson = & $ts status --json 2>$null | ConvertFrom-Json } catch { }

if (-not $statusJson -or $statusJson.BackendState -ne 'Running') {
    Write-Host ''
    Write-Host 'Tailscale is installed but not connected.' -ForegroundColor Yellow
    Write-Host 'Run this (it opens a browser to sign in):' -ForegroundColor Cyan
    Write-Host "    & '$ts' up"
    Write-Host ''
    Write-Host 'Then run this script again.'
    exit 1
}

$dnsName = $statusJson.Self.DNSName
if ($dnsName) { $dnsName = $dnsName.TrimEnd('.') }
$tailIp = @($statusJson.Self.TailscaleIPs)[0]

Write-Host "connected as: $dnsName  ($tailIp)" -ForegroundColor Green

if ($Status) {
    Write-Host ''
    Write-Host '--- tailscale serve status ---'
    & $ts serve status
    exit 0
}

# ------------------------------------------------------------------ serve ----
$gwPort = Get-GatewayPort
Write-Host "gateway port: $gwPort" -ForegroundColor DarkGray

Write-Host ''
Write-Host 'Enabling HTTPS on the tailnet and proxying it to the gateway…' -ForegroundColor Cyan

# `tailscale serve` terminates TLS with a real Let's Encrypt certificate for the
# *.ts.net name and forwards to loopback. HTTPS is required for two reasons:
# iOS will not install a PWA to the Home Screen over plain HTTP, and Web Push
# requires a secure context.
#
# NOTE: this is `serve`, NOT `funnel`. serve keeps the site private to your
# tailnet; funnel would publish it to the public internet.
try {
    & $ts serve --bg --https=443 "http://127.0.0.1:$gwPort" | Out-Host
} catch {
    Write-Host ''
    Write-Host 'tailscale serve failed.' -ForegroundColor Red
    Write-Host 'The usual cause is that HTTPS certificates are not enabled for your tailnet.'
    Write-Host 'Enable them once at:  https://login.tailscale.com/admin/dns  ->  HTTPS Certificates'
    Write-Host 'Then re-run:  .\scripts\setup-tailscale.ps1 -Serve'
    exit 1
}

$origin = "https://$dnsName"

Write-Host ''
Write-Host '--- serve status ---' -ForegroundColor DarkGray
& $ts serve status

Write-Host ''
Write-Host '========================================================' -ForegroundColor Green
Write-Host ' Remote access is configured.' -ForegroundColor Green
Write-Host '========================================================' -ForegroundColor Green
Write-Host ''
Write-Host "  Phone URL:  $origin"
Write-Host ''
Write-Host '  Next steps:'
Write-Host "    1. node src/cli/agw.js set-origin $origin"
Write-Host '    2. node src/cli/agw.js stop ; node src/cli/agw.js start'
Write-Host '    3. node src/cli/agw.js pair'
Write-Host "    4. On the iPhone: connect Tailscale, open $origin, enter the code"
Write-Host '    5. On the iPhone: Share -> Add to Home Screen, then open it from there'
Write-Host '       (iOS only delivers Web Push to a Home Screen install, not a Safari tab)'
Write-Host ''
Write-Host '  To undo:  & ' -NoNewline; Write-Host "'$ts' serve reset" -NoNewline; Write-Host ''
Write-Host ''
