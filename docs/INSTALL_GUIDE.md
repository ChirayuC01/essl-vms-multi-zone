# VMS Windows Installation Guide

## Before installation

- Use an always-on supported Windows PC with fixed LAN addressing, backup destination, and access to every eSSL terminal.
- Confirm the VMS will be the sole roster manager for each terminal.
- Decide distinct, non-overlapping Employee and Visitor ID patterns before connecting any terminal. For example, `1*` for Employees and `9*` for Visitors. Empty patterns classify nobody automatically; an ID matching both categories is rejected/left unclaimed.
- Obtain organization name/logo and the initial Admin details.
- For this schema-changing release, do not reuse old persistent PostgreSQL data. Uninstall preserves data; archive old database/photos manually after confirming they are not needed.
- The release owner must stage with `VMS_LICENSE_PUBLIC_KEY_FILE` pointing to the production Ed25519 public key.

## Install

1. Run the installer as Administrator. Release candidate 0.4.11 is not yet Authenticode-signed, so Windows may show **Unknown publisher**; verify its SHA-256 against `VERSIONS.md` before proceeding.
2. Confirm services `VmsPostgres`, `VmsBackend`, and `VmsWeb` start and remain running after reboot.
3. Verify the installer-created Windows Firewall rule for inbound backend/ADMS traffic as described below. A terminal cannot check in until this is working.
4. Open the console URL shown by the installer.

After adopting each terminal, open **Devices** and confirm its timezone is `+05:30` (`330` minutes) for an India installation. This value normalizes the terminal's local ATTLOG clock to UTC before storage; leaving it at `0` makes every punch-derived screen and attendance report 5h30 late. Current source defaults new devices to `330` and lets an Admin correct it on the Devices page.
5. Complete first setup: Admin, organization name, optional PNG/JPEG/WebP logo. This starts the 30-day trial.
6. Create Company and Department directory values.
7. Add each device, timezone, access groups, role/direction maps, capacity, and distinct non-overlapping Employee/Visitor patterns. Never reuse the same exact ID or wildcard space in both categories.
8. Configure the terminal’s ADMS/server address to this PC and verify heartbeat/punch traffic.
9. Perform the smoke tests in `PEOPLE_UPGRADE_VERIFICATION_GUIDE.md` before live enrollment.

Installer 0.4.7 and later stops existing VMS services before replacing application files, preventing the Prisma query-engine DLL lock seen during earlier upgrades. Do not choose **Skip this file** if Windows ever reports a replacement failure; cancel, close VMS development/Prisma tools, and retry as Administrator.

## Firewall access for terminals

The backend and terminal ADMS endpoints share the installer-selected backend port (`47102` by default). Installer 0.4.1 and later creates or updates the named `VMS-Backend-ADMS` inbound TCP rule automatically, using the selected port and restricting remote addresses to `LocalSubnet`. Verify it in Administrator PowerShell:

```powershell
Get-NetFirewallRule -Name 'VMS-Backend-ADMS' |
    Get-NetFirewallPortFilter |
    Format-Table Protocol,LocalPort
```

For the old 0.4.0 release candidate only, or if the owned rule was manually removed, create it with the following command; replace `47102` if setup used a different port:

```powershell
New-NetFirewallRule `
    -Name 'VMS-Backend-ADMS' `
    -DisplayName 'VMS Backend and terminal ADMS' `
    -Direction Inbound `
    -Action Allow `
    -Protocol TCP `
    -LocalPort 47102 `
    -RemoteAddress LocalSubnet `
    -Profile Any
```

If terminals are on a separately routed VLAN, add the approved terminal subnet CIDR or CIDRs to the rule's remote-address scope. Do not expose this port beyond the site networks that need it.

Confirm the backend is listening:

```powershell
Get-NetTCPConnection -LocalPort 47102 -State Listen |
    Format-Table LocalAddress,LocalPort,State,OwningProcess
```

From another Windows machine on the terminal network, confirm inbound reachability before configuring the terminal. Replace the example IP with the VMS server's LAN IP:

```powershell
Test-NetConnection 192.168.0.50 -Port 47102
```

`TcpTestSucceeded` must be `True`. Configure the terminal's ADMS server address to the VMS server's LAN IP and this same port; do not use `localhost` or a VM-only NAT address.

## Open the console from another LAN device

Open the VMS server's LAN address and web port from the other device, for example:

```text
http://192.168.0.50:47101
```

Installer 0.4.6 and later automatically sends browser API, photo, report-download, and live-event traffic to the same hostname/IP on the selected backend port (`47102` by default). It no longer sends a remote browser to that browser's own `localhost`. The backend port remains restricted by the installer firewall rule to `LocalSubnet`; do not expose either service directly to the internet.

Source version 0.4.14 adds **Use webcam** beside manual enrollment-photo upload. Browser camera access is available on `localhost` or an HTTPS origin; browsers normally block it when the console is opened through a plain-HTTP LAN IP. The ordinary JPEG upload remains available in that case.

To enable the webcam on an operator PC anyway, run once **as Administrator** on that PC (copy the script from the server's `backend\scripts\windows-services\` folder):

```powershell
.\enable-webcam-on-operator-pc.ps1 -ConsoleUrl http://192.168.0.50:47101
```

It writes the Chrome/Edge `OverrideSecurityRestrictionsOnInsecureOrigin` policy for that one console origin; restart the browser afterwards. The address must match exactly what operators type (IP vs hostname, and port). `-Remove` undoes it. Firefox users set `media.devices.insecure.enabled` and `media.getusermedia.insecure.enabled` to `true` in `about:config` instead.

### Webcam on many operator PCs — Group Policy

When the operator PCs are joined to a Windows domain, the client's IT can push the same setting to every PC at once instead of running the script on each one. This needs no browser policy templates (ADMX) — it is a plain registry preference.

**This is done by the client's domain administrator on their domain controller** (or an admin PC with the RSAT Group Policy tools). The Group Policy Management console and its Preferences branch do not exist on an ordinary operator PC, a Windows Home PC, or a PC that is not domain-joined — on those, use the script above; it writes exactly the same registry keys. To find out whether a site can use this route, ask IT "are the operator PCs domain-joined?" (or on a PC: **Settings → System → About** shows the domain under *Related settings → Domain or workgroup*).

Steps for the domain administrator:

1. Open **Group Policy Management** (`gpmc.msc`). Right-click the OU that contains the operator PCs (or the domain) → **Create a GPO in this domain, and Link it here…** → name it `VMS console webcam`.
2. Right-click the new GPO → **Edit**. Go to **Computer Configuration → Preferences → Windows Settings → Registry**.
3. Right-click **Registry → New → Registry Item** and enter:
   - Action: `Update`
   - Hive: `HKEY_LOCAL_MACHINE`
   - Key path: `SOFTWARE\Policies\Google\Chrome\OverrideSecurityRestrictionsOnInsecureOrigin`
   - Value name: `1`
   - Value type: `REG_SZ`
   - Value data: `http://192.168.0.50:47101` (the exact console address operators type — IP or hostname, and port)
4. Repeat step 3 for Microsoft Edge with key path `SOFTWARE\Policies\Microsoft\Edge\OverrideSecurityRestrictionsOnInsecureOrigin`, same value name, type, and data.
5. Close the editor. The policy reaches each PC at the next refresh (up to 90 minutes, or immediately with `gpupdate /force` on the PC). Operators restart Chrome/Edge once.

Check on any operator PC: `chrome://policy` or `edge://policy` lists `OverrideSecurityRestrictionsOnInsecureOrigin` with the console address. PCs added to the OU later receive it automatically. If the server's address or port changes, edit the value data in the GPO.

If IT prefers the browser's own templates, the same setting is under **Computer Configuration → Policies → Administrative Templates → Google → Google Chrome** (and **Microsoft Edge**) → *Origins or hostname patterns for which restrictions on insecure origins should not apply*, after importing the Chrome/Edge ADMX files. The result is identical.

Firefox is not covered by this policy; use Chrome or Edge on operator PCs, or set the two `about:config` keys above per PC.

For an upgrade from 0.4.5 or earlier, run 0.4.6 over the existing installation and let setup restart all three services. A hard refresh in the remote browser may be needed to discard an older cached frontend. Verify from the remote device:

```text
http://192.168.0.50:47102/health
```

Then sign in through port `47101`. If the health URL is unreachable, check the `VMS-Backend-ADMS` firewall rule and confirm that the remote device is in the allowed site subnet.

## Windows Server 2016 — 0.4.0 service recovery

Installer 0.4.1 and later applies and validates these permissions automatically. The commands below are recovery instructions only for the old 0.4.0 release candidate, which can leave `VmsPostgres` in a restart loop on a Windows Server machine with restrictive inherited ACLs. Its log reports `EPERM: operation not permitted, chmod ...postgres.exe`. PostgreSQL itself and Windows Server 2016 are compatible; the bundled wrapper needs Modify permission on two executables while running as `NetworkService`.

In Administrator PowerShell, run:

```powershell
$pgBin = 'C:\VMS\backend\node_modules\@embedded-postgres\windows-x64\native\bin'

icacls "$pgBin\postgres.exe" /grant 'NT AUTHORITY\NETWORK SERVICE:(M)'
icacls "$pgBin\initdb.exe" /grant 'NT AUTHORITY\NETWORK SERVICE:(M)'

Start-Service VmsPostgres
Start-Sleep -Seconds 20
Start-Service VmsBackend
Start-Sleep -Seconds 10
Restart-Service VmsWeb

Get-Service VmsPostgres,VmsBackend,VmsWeb |
    Format-Table Name,Status,StartType
```

All three services must remain `Running`. Verify the backend with:

```powershell
Invoke-RestMethod 'http://localhost:47102/health'
```

Installer 0.4.13 and later also return `version`; the same value appears subtly beside the organization name in the signed-in console. For 0.4.11 and earlier, check **Installed apps** or the installer `ProductVersion` instead.

If PostgreSQL still stops, inspect `C:\VMS\backend\vms-postgres.err.log` and `C:\VMS\backend\vms-postgres.out.log`. This manual repair applies to 0.4.0; upgrade to 0.4.1 so subsequent installs apply the executable ACLs and validate the native-command exit codes automatically.

## Existing terminal roster

Classified Employee/Visitor USER or BIOPHOTO data creates People automatically. Employees stay on the originating device with permanent desired access. Visitors are removed only after their photo is durable, and need a completed profile plus explicit Entry to return. Unmatched/ambiguous IDs are review-only and are never touched.

## Bringing People from another installation

When a site takes over People already registered on another VMS installation — a department moving, or a second site for the same operator — their details and enrollment photographs can be transferred instead of re-registered and re-captured. `backend/scripts/transfer-people.mjs` exports a department or company from the source installation over its operator API and registers them here, creating the companies and departments as it goes.

Register the terminal on this machine first: an Employee needs at least one device at registration. Full procedure, flags and caveats in `PEOPLE_TRANSFER.md`.

## Create a license request

The License link is intentionally absent from navigation; an Admin can open `/license` directly. Installer 0.4.5 and later places a request-only helper at `C:\VMS\tools\create-license-request.mjs`. It contains no issuer key and cannot generate a license.

Run this during initial setup or renewal, preferably writing directly to secured removable media:

```powershell
& 'C:\VMS\node\node.exe' `
  'C:\VMS\tools\create-license-request.mjs' `
  --output 'X:\license-request.txt'
```

Send that file only to the product owner through the approved channel. See `LICENSING.md` for issuance and renewal.

## Upgrade, reinstall, and uninstall

Ordinary upgrade/reinstall preserves PostgreSQL, photos, branding, and `%ProgramData%\VMS\license-state.json`; the paid key is re-imported automatically. Uninstall removes services/program files but intentionally preserves data and license state. Never assume uninstall means clean install.

Never install changed application code under a reused product version. Setup
will replace the files, but Windows and VMS will continue to report the shared
version, making the two builds impossible to distinguish. Increment
`AppVersion` for every changed installer.

If startup reports the legacy `vendor` table, stop. Archive/relocate the old PostgreSQL and photo directories deliberately; do not delete them until ownership confirms no production data is required.

## Backup

Back up PostgreSQL, backend photo/logo storage, and ProgramData license marker together. Test restore on a separate machine; a changed MachineGuid requires a replacement paid key. See `LICENSING.md` and the full acceptance guide.

For cloning and running the source directly in an IDE, see `DEVELOPMENT_SETUP.md`.
