<#
.SYNOPSIS
  Lets Chrome and Edge on THIS PC use the webcam for the VMS console when it
  is opened over plain HTTP from another machine (http://<server-ip>:47101).

.DESCRIPTION
  Browsers only expose getUserMedia (the webcam) on a "secure context":
  localhost or HTTPS. The console runs over HTTP on the LAN, so operator PCs
  see "Camera access needs localhost or HTTPS". Chrome and Edge honour the
  OverrideSecurityRestrictionsOnInsecureOrigin policy, which treats one named
  origin as secure. This script writes that policy for the console origin only.

  Run once per operator PC, as Administrator, then restart the browser.
  Firefox is not covered: set media.devices.insecure.enabled and
  media.getusermedia.insecure.enabled to true in about:config instead.

.EXAMPLE
  .\enable-webcam-on-operator-pc.ps1 -ConsoleUrl http://192.168.0.50:47101

.EXAMPLE
  .\enable-webcam-on-operator-pc.ps1 -ConsoleUrl http://192.168.0.50:47101 -Remove
#>
param(
    [Parameter(Mandatory = $true)]
    [string]$ConsoleUrl,
    [switch]$Remove
)

$ErrorActionPreference = "Stop"

$uri = [Uri]$ConsoleUrl
$origin = "$($uri.Scheme)://$($uri.Authority)"

$policyKeys = @(
    "HKLM:\SOFTWARE\Policies\Google\Chrome\OverrideSecurityRestrictionsOnInsecureOrigin",
    "HKLM:\SOFTWARE\Policies\Microsoft\Edge\OverrideSecurityRestrictionsOnInsecureOrigin"
)

function Get-OriginEntries($key) {
    if (-not (Test-Path $key)) { return @() }
    Get-ItemProperty $key | Get-Member -MemberType NoteProperty |
        Where-Object { $_.Name -match '^\d+$' } |
        ForEach-Object { @{ Name = $_.Name; Value = Get-ItemPropertyValue $key $_.Name } }
}

foreach ($key in $policyKeys) {
    $entries = Get-OriginEntries $key

    if ($Remove) {
        $entries | Where-Object { $_.Value -eq $origin } |
            ForEach-Object { Remove-ItemProperty $key -Name $_.Name }
        continue
    }

    if ($entries | Where-Object { $_.Value -eq $origin }) { continue }
    New-Item -Path $key -Force | Out-Null
    # The policy is a numbered list; append after the highest existing index.
    $max = ($entries | ForEach-Object { [int]$_.Name } | Measure-Object -Maximum).Maximum
    New-ItemProperty -Path $key -Name (1 + [int]$max) -Value $origin -PropertyType String | Out-Null
}

if ($Remove) {
    Write-Host "Removed $origin from the Chrome/Edge insecure-origin override policy. Restart the browser."
} else {
    Write-Host "Chrome and Edge will now treat $origin as secure. Restart the browser, then 'Use webcam' works from this PC."
    Write-Host "Check: chrome://policy or edge://policy should list OverrideSecurityRestrictionsOnInsecureOrigin = $origin"
}
