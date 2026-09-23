# Phase 6 packaging, task 3  - registers VMS as three independent Windows
# services: VmsPostgres (the bundled cluster from `bundled-postgres.mjs`),
# VmsBackend (the packaged `server.cjs`), and VmsWeb (the operator console,
# task 6). Kept as separate services, not one, per CLAUDE.md: "the VMS is
# never in the real-time barrier path" and a VMS outage must never strand
# authorized people — but the barrier logic lives in the terminal itself
# either way. The real reason is DEPLOYMENT_READINESS.md's #1 hard
# requirement: the machine must never be effectively off. Splitting them
# means a crash/restart in one never takes another down with it, and
# Windows can be told the ordering (Web depends on Backend depends on
# Postgres) without coupling their lifecycles.
#
# Task 6 was originally scoped as a Tauri desktop shell per
# VMS_PRD_Technical_Plan.md, but that document frames it as an explicitly
# OPTIONAL, per-client "kiosk feel" wrapper with zero effect on function or
# security  - and it still needs a persistently-running web server behind
# it either way (Tauri would spawn one as a sidecar). That persistent
# server didn't exist as a service at all before this change; VmsWeb is it.
# The Tauri wrapper itself remains not started, deferred until a client
# actually wants the app-icon feel  - see docs/SESSION_HANDOFF_PHASE6.md.
#
# Verified against a real Windows service manager (task 3, then again for
# VmsWeb here). Two real issues turned up and were fixed: VmsPostgres
# refusing to run under LocalSystem (see the NetworkService reconfiguration
# below), and re-running this script while services were already registered
# failing on a file lock (see Remove-ServiceIfRegistered above).
#
# Prerequisites (deliberately not automated  - see comments below):
#   1. Run this in an Administrator PowerShell. Service registration
#      requires elevation; a script that silently re-launches itself
#      elevated is a step too clever for a first run.
#   2. Download WinSW (https://github.com/winsw/winsw/releases)  - the
#      latest "WinSW-x64.exe" asset  - and place it at:
#      backend\scripts\windows-services\winsw.exe
#      Not auto-downloaded here on purpose: fetching and silently running an
#      external executable during an install script is worth a deliberate,
#      visible step rather than something this script does on your behalf.
#   3. `npm install` and `npm run package` already done in backend\ (task 1),
#      and `npm run db:bundled:init` already run at least once (task 2) so
#      the data directory exists.

#Requires -RunAsAdministrator

param(
    # Installer-configurable; the web console's own port is fixed (see
    # New-WinswServiceXml call for VmsWeb below) since the frontend build is
    # shipped pre-built and its own listen port isn't baked into anything
    # that would need a rebuild to change.
    [int]$BackendPort = 47102
)

$ErrorActionPreference = "Stop"

$scriptDir   = Split-Path -Parent $MyInvocation.MyCommand.Path
$backendRoot = (Resolve-Path (Join-Path $scriptDir "..\..")).Path
$repoRoot    = Split-Path -Parent $backendRoot
$webRoot     = Join-Path $repoRoot "web"
$distPackage = Join-Path $backendRoot "dist-package"
$winswSource = Join-Path $scriptDir "winsw.exe"

if (-not (Test-Path $winswSource)) {
    throw "winsw.exe not found at $winswSource. Download WinSW-x64.exe from https://github.com/winsw/winsw/releases and place it there before running this script."
}

if (-not (Test-Path (Join-Path $distPackage "server.cjs"))) {
    throw "$distPackage\server.cjs not found. Run 'npm run package' in backend\ first (Phase 6 task 1)."
}

$installedWebServer = Join-Path $webRoot "server.js"
$builtWebServer = Join-Path $webRoot ".next\standalone\server.js"
if (Test-Path $installedWebServer) {
    $webRuntimeRoot = $webRoot
    $webServerJs = $installedWebServer
} elseif (Test-Path $builtWebServer) {
    # Manual source-tree service installation: mirror the static/public
    # assets that build-release.mjs places beside the standalone server.
    $webRuntimeRoot = Split-Path -Parent $builtWebServer
    $standaloneNext = Join-Path $webRuntimeRoot ".next"
    New-Item -ItemType Directory -Force -Path $standaloneNext | Out-Null
    if (Test-Path (Join-Path $webRoot ".next\static")) {
        $standaloneStatic = Join-Path $standaloneNext "static"
        New-Item -ItemType Directory -Force -Path $standaloneStatic | Out-Null
        Copy-Item (Join-Path $webRoot ".next\static\*") $standaloneStatic -Recurse -Force
    }
    if (Test-Path (Join-Path $webRoot "public")) {
        $standalonePublic = Join-Path $webRuntimeRoot "public"
        New-Item -ItemType Directory -Force -Path $standalonePublic | Out-Null
        Copy-Item (Join-Path $webRoot "public\*") $standalonePublic -Recurse -Force
    }
    $webServerJs = $builtWebServer
} else {
    throw "Standalone web server not found. Run 'npm install' then 'npm run build' in web\ first (next.config.ts must use output: standalone)."
}

# Task 7: a real installer bundles its own node.exe (release/node/node.exe,
# staged by installer/build-release.mjs) so a client machine needs nothing
# pre-installed. Check for that first; fall back to PATH for the existing
# manual-dev-machine case (already verified working in tasks 3/6). Either
# way, Windows services do not inherit an interactive user's PATH reliably,
# so this resolves it once, now, and bakes the full path into each service
# config.
$bundledNodeExe = Join-Path $repoRoot "node\node.exe"
if (Test-Path $bundledNodeExe) {
    $nodeExe = $bundledNodeExe
} else {
    $nodeCommand = Get-Command node.exe -ErrorAction SilentlyContinue
    if (-not $nodeCommand) {
        throw "node.exe not found at $bundledNodeExe or on PATH."
    }
    $nodeExe = $nodeCommand.Source
}

# Task 4: ensure .env exists with a real JWT_SECRET and DATABASE_URL before
# either service is registered. Idempotent (only touches placeholder values,
# except PORT/ADMS_PORT which the installer always owns), so safe to run on
# every install, unlike the WinSW download above.
Write-Host "Ensuring backend\.env is configured..."
& $nodeExe (Join-Path $backendRoot "scripts\first-run-env.mjs") "--backend-port=$BackendPort"
if ($LASTEXITCODE -ne 0) {
    throw "first-run-env.mjs failed - see output above."
}

# The web console ships as a pre-built .next bundle (no source, no rebuild
# step here), so it can't learn a changed backend port via NEXT_PUBLIC_* --
# that's inlined at build time. It instead reads API_BASE_URL at runtime (see
# web/src/app/layout.tsx); this is what keeps it in sync with $BackendPort.
Write-Host "Ensuring web\.env is configured..."
& $nodeExe (Join-Path $webRoot "scripts\first-run-env.mjs") "--backend-port=$BackendPort"
if ($LASTEXITCODE -ne 0) {
    throw "web first-run-env.mjs failed - see output above."
}

function New-WinswServiceXml {
    param(
        [string]$Id,
        [string]$DisplayName,
        [string]$Description,
        [string]$Arguments,
        [string]$WorkingDirectory,
        [string]$AppRoot,
        [string[]]$DependsOn,
        [hashtable]$Environment = @{}
    )

    $dependsXml = ""
    foreach ($dep in $DependsOn) {
        $dependsXml += "  <depend>$dep</depend>`r`n"
    }

    $environmentXml = "  <env name=`"VMS_APP_ROOT`" value=`"$AppRoot`"/>`r`n"
    foreach ($name in ($Environment.Keys | Sort-Object)) {
        $environmentXml += "  <env name=`"$name`" value=`"$($Environment[$name])`"/>`r`n"
    }

    return @"
<service>
  <id>$Id</id>
  <name>$DisplayName</name>
  <description>$Description</description>
  <executable>$nodeExe</executable>
  <arguments>$Arguments</arguments>
  <workingdirectory>$WorkingDirectory</workingdirectory>
$environmentXml$dependsXml  <startmode>Automatic</startmode>
  <onfailure action="restart" delay="5 sec"/>
  <onfailure action="restart" delay="30 sec"/>
  <resetfailure>1 hour</resetfailure>
  <stoptimeout>30 sec</stoptimeout>
  <log mode="roll-by-size">
    <sizeThreshold>10240</sizeThreshold>
    <keepFiles>8</keepFiles>
  </log>
</service>
"@
}

# Re-running this script while a service from a previous run is still
# registered fails: Copy-Item hits "the process cannot access the file...
# being used by another process" (the running service has its own .exe
# open), and even past that, WinSW's own "install" refuses an already-
# registered service ID. Fully removing it first -- stop, then deregister
# -- makes re-running this whole script safe without a separate uninstall
# step first, e.g. after rebuilding the backend or the web console.
#
# Deregisters via `sc.exe delete $Id` rather than `& $ExePath uninstall`
# (the first version of this fix, and what uninstall-services.ps1 still
# does). That version looked for the exe at the CALLER's own (possibly
# brand-new) path -- fine when re-running in place, but Phase 6 task 8
# found the real gap: reinstalling the same service NAME from a DIFFERENT
# path (e.g. moving from a dev checkout to C:\VMS via the real installer)
# means that path doesn't exist yet, Test-Path fails, the uninstall call
# silently never happens, and the following `install` fails against a
# still-registered (merely stopped) service. `sc.exe delete` works by
# service name alone via the SCM, independent of any file path -- correct
# for a same-path rerun AND a different-path reinstall alike.
#
# A second, worse bug surfaced verifying that fix live: `Stop-Service`'s
# "Collection was modified" race can throw BEFORE the stop request ever
# reaches the SCM, leaving the service genuinely still running. Calling
# `sc.exe delete` on a still-running service only marks it pending-deletion
# -- the OLD binary path stays registered and, critically, WinSW's own
# <onfailure> directive becomes a native SCM recovery action (confirmed via
# `sc.exe qfailure`: RESTART, 5s then 30s). So a later force-kill of that
# lingering process reads to Windows as a CRASH, not an intentional stop,
# and SCM auto-restarts it from the STALE registration -- which is exactly
# what happened: three services quietly kept serving from the old dev
# checkout for the rest of a verification session, `sc.exe delete` reporting
# "SUCCESS" the entire time. `Stop-Process -Force` makes this actively
# worse, not better, for the same reason.
#
# The fix is to never call delete on a service until it is CONFIRMED
# stopped -- poll, and escalate to a graceful `sc.exe stop` (bypasses the
# .NET race entirely, and unlike a process kill, a clean SCM-level stop does
# not trigger the recovery actions) if Stop-Service didn't land.
function Wait-ServiceStopped {
    param([string]$Id, [int]$TimeoutSeconds = 20)
    $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
    while ((Get-Date) -lt $deadline) {
        $svc = Get-Service -Name $Id -ErrorAction SilentlyContinue
        if (-not $svc -or $svc.Status -eq "Stopped") { return $true }
        Start-Sleep -Milliseconds 500
    }
    return $false
}

function Remove-ServiceIfRegistered {
    param([string]$Id)
    $svc = Get-Service -Name $Id -ErrorAction SilentlyContinue
    if (-not $svc) { return }

    Write-Host "Removing existing $Id so it can be reinstalled..."
    try {
        Stop-Service -Name $Id -Force -ErrorAction Stop
    } catch {
        # Known "Collection was modified" .NET race -- may or may not have
        # actually reached the SCM. Wait-ServiceStopped below is what
        # actually decides whether a fallback is needed, not this catch.
    }

    if (-not (Wait-ServiceStopped -Id $Id -TimeoutSeconds 15)) {
        Write-Host "$Id did not stop via Stop-Service -- falling back to 'sc.exe stop' (graceful; a force-kill here would read as a crash and trigger the service's own auto-restart)."
        & sc.exe stop $Id | Out-Null
        if (-not (Wait-ServiceStopped -Id $Id -TimeoutSeconds 20)) {
            throw "$Id would not stop. Resolve manually (check what's using it, e.g. Get-CimInstance Win32_Process to find its real PID and BINARY_PATH_NAME) before re-running this script -- deleting a still-running service leaves a stale registration that its own recovery actions will keep resurrecting."
        }
    }

    & sc.exe delete $Id | Out-Null

    # sc.exe delete on an already-stopped service is immediate, but confirm
    # rather than assume -- a lingering registration here means the
    # following fresh `install` call fails or, worse, silently no-ops
    # against the stale entry (both observed this session).
    $deadline = (Get-Date).AddSeconds(10)
    while ((Get-Date) -lt $deadline) {
        if (-not (Get-Service -Name $Id -ErrorAction SilentlyContinue)) { return }
        Start-Sleep -Milliseconds 500
    }
    throw "$Id was deleted but is still visible to Get-Service after 10s. Resolve manually before re-running this script."
}

# Reverse dependency order (Web depends on Backend depends on Postgres) --
# same reasoning as uninstall-services.ps1: stopping a dependency out from
# under a running dependent service is refused by Windows, so the dependent
# has to go first. This whole pass happens BEFORE any fresh install below,
# so a re-run never tries to stop Postgres while a still-running Backend
# still depends on it.
Remove-ServiceIfRegistered -Id "VmsWeb"
Remove-ServiceIfRegistered -Id "VmsBackend"
Remove-ServiceIfRegistered -Id "VmsPostgres"

Write-Host "Registering VmsPostgres..."
$postgresExe = Join-Path $backendRoot "vms-postgres.exe"
Copy-Item $winswSource $postgresExe -Force
$postgresXml = New-WinswServiceXml `
    -Id "VmsPostgres" `
    -DisplayName "VMS Bundled Postgres" `
    -Description "Bundled PostgreSQL instance for the Visitor Management System." `
    -Arguments "`"$backendRoot\scripts\bundled-postgres.mjs`" start" `
    -WorkingDirectory "$backendRoot" `
    -AppRoot "$backendRoot" `
    -DependsOn @()
Set-Content -Path (Join-Path $backendRoot "vms-postgres.xml") -Value $postgresXml -Encoding UTF8
& $postgresExe install
if ($LASTEXITCODE -ne 0) { throw "VmsPostgres service registration failed with exit code $LASTEXITCODE." }

# PostgreSQL refuses to start under an administrative account ("Execution of
# PostgreSQL by a user with administrative permissions is not permitted")  -
# and a Windows service defaults to LocalSystem, which counts as one. Move
# VmsPostgres to the built-in NetworkService account (non-admin, no password
# needed for virtual accounts) and grant it write access to the data
# directory and the backend root (where WinSW writes its own log files).
Write-Host "Reconfiguring VmsPostgres to run as NT AUTHORITY\NetworkService (Postgres refuses to run as an administrator)..."
New-Item -ItemType Directory -Force -Path (Join-Path $backendRoot "data") | Out-Null
icacls "$backendRoot\data" /grant "NT AUTHORITY\NetworkService:(OI)(CI)F" /T | Out-Null
if ($LASTEXITCODE -ne 0) { throw "Failed to grant NetworkService access to backend\data (icacls exit $LASTEXITCODE)." }
icacls "$backendRoot" /grant "NT AUTHORITY\NetworkService:(M)" | Out-Null
if ($LASTEXITCODE -ne 0) { throw "Failed to grant NetworkService access to the backend log directory (icacls exit $LASTEXITCODE)." }

# embedded-postgres checks executable mode on every start and calls chmod
# when Windows reports 0666. Restrictive server ACLs otherwise make that
# unhandled chmod reject with EPERM and put VmsPostgres into a crash loop.
$embeddedPgBin = Join-Path $backendRoot "node_modules\@embedded-postgres\windows-x64\native\bin"
foreach ($binary in @("postgres.exe", "initdb.exe")) {
    $binaryPath = Join-Path $embeddedPgBin $binary
    if (-not (Test-Path $binaryPath)) { throw "Bundled PostgreSQL binary not found: $binaryPath" }
    icacls $binaryPath /grant "NT AUTHORITY\NetworkService:(M)" | Out-Null
    if ($LASTEXITCODE -ne 0) { throw "Failed to grant NetworkService Modify permission on $binaryPath (icacls exit $LASTEXITCODE)." }
}
& sc.exe config VmsPostgres obj= "NT AUTHORITY\NetworkService" | Out-Null
if ($LASTEXITCODE -ne 0) { throw "Failed to configure the VmsPostgres service account (sc.exe exit $LASTEXITCODE)." }

Write-Host "Registering VmsBackend..."
$backendExe = Join-Path $distPackage "vms-backend.exe"
Copy-Item $winswSource $backendExe -Force
$backendXml = New-WinswServiceXml `
    -Id "VmsBackend" `
    -DisplayName "VMS Backend" `
    -Description "VMS operator API, device ADMS endpoints, and scheduled jobs." `
    -Arguments "`"$distPackage\server.cjs`"" `
    -WorkingDirectory "$distPackage" `
    -AppRoot "$backendRoot" `
    -DependsOn @("VmsPostgres")
Set-Content -Path (Join-Path $distPackage "vms-backend.xml") -Value $backendXml -Encoding UTF8
& $backendExe install
if ($LASTEXITCODE -ne 0) { throw "VmsBackend service registration failed with exit code $LASTEXITCODE." }

# The device initiates every ADMS connection. Local /health success does not
# prove a terminal can reach this port, so own one named, scoped firewall rule
# and replace it on upgrade if the installer-selected port changes.
$firewallRuleName = "VMS-Backend-ADMS"
Get-NetFirewallRule -Name $firewallRuleName -ErrorAction SilentlyContinue |
    Remove-NetFirewallRule -ErrorAction Stop
New-NetFirewallRule `
    -Name $firewallRuleName `
    -DisplayName "VMS Backend and terminal ADMS (TCP $BackendPort)" `
    -Description "Inbound VMS operator API and eSSL terminal ADMS traffic." `
    -Direction Inbound `
    -Action Allow `
    -Protocol TCP `
    -LocalPort $BackendPort `
    -RemoteAddress LocalSubnet `
    -Profile Any | Out-Null

Write-Host "Registering VmsWeb..."
$webExe = Join-Path $webRoot "vms-web.exe"
Copy-Item $winswSource $webExe -Force
# Fixed, not installer-configurable -- see the -BackendPort param comment
# above for why only the backend's port needs to be a choice.
$FrontendPort = 47101
$webXml = New-WinswServiceXml `
    -Id "VmsWeb" `
    -DisplayName "VMS Web Console" `
    -Description "Operator web console for the Visitor Management System." `
    -Arguments "`"$webServerJs`"" `
    -WorkingDirectory "$webRuntimeRoot" `
    -AppRoot "$webRoot" `
    -DependsOn @("VmsBackend") `
    -Environment @{ PORT = "$FrontendPort"; HOSTNAME = "0.0.0.0" }
Set-Content -Path (Join-Path $webRoot "vms-web.xml") -Value $webXml -Encoding UTF8
& $webExe install
if ($LASTEXITCODE -ne 0) { throw "VmsWeb service registration failed with exit code $LASTEXITCODE." }

Write-Host ""
Write-Host "All three services registered. Starting VmsPostgres, then VmsBackend, then VmsWeb..."
Start-Service -Name VmsPostgres
Start-Sleep -Seconds 5
Start-Service -Name VmsBackend
Start-Sleep -Seconds 5
Start-Service -Name VmsWeb

Write-Host ""
Get-Service VmsPostgres, VmsBackend, VmsWeb | Format-Table -AutoSize
Write-Host "Check backend\vms-postgres.wrapper.log, dist-package\vms-backend.wrapper.log, and web\vms-web.wrapper.log if any failed to start."
Write-Host "Operator console: http://localhost:$FrontendPort"
