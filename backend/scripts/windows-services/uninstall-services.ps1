# Phase 6 packaging, task 3/6  - removes the three services registered by
# install-services.ps1. Stops/uninstalls VmsWeb, then VmsBackend, then
# VmsPostgres (reverse of install order, since each depends on the one
# before it and Windows will refuse to stop a dependency out from under a
# running dependent service).

#Requires -RunAsAdministrator

$ErrorActionPreference = "Continue"

# Deregisters via `sc.exe delete $Id` (by service name, via the SCM) rather
# than `& $ExePath uninstall` (which needed the exe to still exist at a
# specific path -- broke when a service was registered from a path this
# copy of the script doesn't know about, e.g. after moving the install.
# Fixed alongside the same gap in install-services.ps1, task 8.)
#
# Waits to CONFIRM the service actually stopped before deleting -- calling
# delete on a still-running service (possible if Stop-Service's "Collection
# was modified" race meant the stop never reached the SCM) only marks it
# pending-deletion. The old binary path stays registered, and WinSW's own
# <onfailure> config is a native SCM recovery action (`sc.exe qfailure`
# confirms it), so anything that later force-kills that lingering process
# reads as a crash and gets auto-restarted from the stale registration --
# this was found happening for real, silently, across a whole verification
# session. This script keeps $ErrorActionPreference = Continue (attempt all
# three regardless), so a service that will not stop is reported and
# skipped rather than aborting the rest.
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

function Remove-WinswService {
    param([string]$Id)

    $svc = Get-Service -Name $Id -ErrorAction SilentlyContinue
    if (-not $svc) {
        Write-Host "$Id is not registered -- nothing to do."
        return
    }
    Write-Host "Stopping $Id..."
    try {
        Stop-Service -Name $Id -Force -ErrorAction Stop
    } catch {
        # See comment above -- Wait-ServiceStopped below is what actually
        # decides whether a fallback is needed, not this catch.
    }

    if (-not (Wait-ServiceStopped -Id $Id -TimeoutSeconds 15)) {
        Write-Host "$Id did not stop via Stop-Service -- trying 'sc.exe stop' (graceful; avoids triggering its own auto-restart)."
        & sc.exe stop $Id | Out-Null
        if (-not (Wait-ServiceStopped -Id $Id -TimeoutSeconds 20)) {
            Write-Warning "$Id would not stop -- skipping its removal. Resolve manually (it will keep running under its current registration)."
            return
        }
    }

    Write-Host "Uninstalling $Id..."
    & sc.exe delete $Id | Out-Null
}

Remove-WinswService -Id "VmsWeb"
Remove-WinswService -Id "VmsBackend"
Remove-WinswService -Id "VmsPostgres"

# Remove only the firewall rule owned by this product. Rules created or
# managed by the client's administrators are never touched.
Get-NetFirewallRule -Name "VMS-Backend-ADMS" -ErrorAction SilentlyContinue |
    Remove-NetFirewallRule -ErrorAction SilentlyContinue

Write-Host ""
Write-Host "Done. Data directories (backend\data\pgdata, backend\data\photos) were left untouched."
