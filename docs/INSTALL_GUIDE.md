# VMS Windows Installation Guide

> **Carried forward from `legacy/INSTALL_GUIDE.md` on 8 October 2026** (Phase 9)
> and updated for **0.5.0**, the two-zone product. New sections: *New client:
> what to do after the installer*, *Upgrading 0.4.19 → 0.5.0*, *Two-zone setup after install*, and *Visitor portal through
> a Cloudflare Tunnel*. Older release-specific notes below still apply.

## New client: what to do after the installer

The installer sets up the services and the database; everything below is
per client and is done once. Allow about an hour on site.

**Before the visit** — ask the client for: their Cloudflare account invite and
domain (§ *Whose Cloudflare account, and which domain*), the privacy notice
text, their visitor types, zone layout, host list with mobile numbers, and
(when SMS goes live) their msg91 account with the portal domain whitelisted.

1. **Install** with the installer (§ *Install* below) and complete first
   setup (Admin, organisation name, logo).
2. **Terminals and zones** — § *Two-zone setup after install*: roles,
   timezone, Employee/Visitor ID patterns, zones, exit-code default, admin
   card check.
3. **Pass types, settings, operators** — visitor types, privacy notice,
   timings, visitor ID prefix, hosts with mobiles.
4. **Tunnel** — § *Setting up the tunnel*, steps 1–3, in the client's
   Cloudflare account. The route's URL is **`localhost:47101`** (the
   installed web port — not 48101, which is development only).
5. **Portal address** — the installer cannot know the client's domain, so
   every link in SMS/email still points at `http://localhost:47101` until
   this is set. In the install folder's `backend\.env` (e.g.
   `C:\VMS\backend\.env`) add or change:

   ```
   PUBLIC_PORTAL_URL=https://visit.<client-domain>
   ```

   then restart the **VmsBackend** service.
6. **Check from your laptop** (in a source checkout's `backend` folder):

   ```
   node scripts\check-portal.mjs https://visit.<client-domain>
   ```

   ✅ **All checks passed** — the portal works and the console, backend and
   terminal endpoints are not reachable from the internet.
7. **One real visit end to end:** raise a request for your own mobile.
   ✅ The link in **Outbox** starts with `https://visit.<client-domain>`;
   on your phone (mobile data) the code, notice, camera and submit work;
   Clear it and walk through the gate.
8. **Handover notes:** Cloudflare account owner's email, domain, hostname,
   tunnel name, installer version and SHA-256.

Not needed on a client: `DEV_ALLOWED_ORIGINS` (development only). The block
on the console for anything arriving through Cloudflare is built in.

## Upgrading 0.5.3 → 0.5.4

Same steps as below (back up, verify the SHA-256 in `VERSIONS.md`, run the
installer as Administrator over the existing install). No database change.
Then, as an Admin:

1. **Operators:** give every operator a mobile number. A visit request for a
   host without one is now refused.
2. **Settings → Messaging:**
   - paste the site's MSG91 auth key and the MSG91 template ID for each of
     the 11 templates (MSG91 → SMS → Templates; not the DLT IDs). Each
     template's variables must be named `var1`, `var2`, … in the order they
     appear in the registered text;
   - set *Send SMS* to *Through MSG91* and save;
   - send a test SMS to your own mobile, then check the Outbox page: a
     failure shows MSG91's reason under the status.
3. Leave email off unless the site has an SMTP account; when it does, tick
   *Send email too*, fill the server, port, sign-in and From address, save and
   send a test email.

## Upgrading 0.5.2 → 0.5.3

Same steps as below (back up, verify the SHA-256 in `VERSIONS.md`, run the
installer as Administrator over the existing install). The services apply
five additive database changes on start; people, photos, passes, punches and
settings are kept. Then, as an Admin:

1. Hard-refresh the browser (Ctrl+F5): the console now has a left sidebar.
2. **Pass types:** open each type that requires the exit code and check
   *which exits* (they were copied from the zones' old "exit code by
   default"). A pass with no pass type no longer needs an exit code.
3. **Zones** now have their own page (Site setup); terminals are still
   placed into zones on **Devices**.
4. **Operators:** make sure every host has a phone number (exit codes and
   arrival messages go there).
5. Register a test visitor (the ID is issued automatically) and provision
   them once, to see a face load end to end.

## Upgrading 0.4.19 → 0.5.0

0.5.0 upgrades an existing site **in place**, keeping every person, photo,
pass, punch, report and setting. Its database changes are additive, and it
behaves like 0.4.19 until an Admin sets up zones.

1. **Back up first.** Stop the services `VmsWeb`, `VmsBackend`, then
   `VmsPostgres` (Services console, or Administrator PowerShell:
   `Stop-Service VmsWeb, VmsBackend, VmsPostgres`). Copy the whole
   `backend\data` folder under the install directory (database, photos,
   documents) and `%ProgramData%\VMS` (licence state) to a dated backup
   location. Start the services again.
2. Check that nobody is inside on a pass that matters (Inside Now). Passes
   live at upgrade time keep their terminals, but an upgrade is safest with
   the site quiet.
3. Verify the installer's SHA-256 against `VERSIONS.md`, then run it as
   Administrator over the existing install (same product, upgrades in place).
4. The services start and apply the database changes. Open the console:
   the version label shows **0.5.0**; people, photos, Employees, punches,
   reports and operators are all there.
5. Nothing changes at the gates yet: with no zones, a pass loads every
   terminal as before. Continue with *Two-zone setup* when ready.

If anything looks wrong, stop the services, restore the backed-up
`backend\data` folder, and reinstall 0.4.19.

## Two-zone setup after install

1. **Devices:** set each terminal's role (IN / OUT), timezone (`330`), and
   **distinct** Employee / Visitor ID patterns. The visitor pattern must cover
   the system visitor IDs: `V*` with the default prefix (or the digit prefix
   you chose, e.g. `9*`, for terminals that accept only numbers).
2. **Zones:** create the zones (e.g. Premise, and Yard inside it); then on
   **Devices** place each terminal into its zone.
3. **Pass types:** the site's visitor types with their required fields,
   maximum validity, whether the host must Clear, and for single entry
   whether the exit needs the exit code and at which zones' exits (usually
   the office/outer one).
4. **Settings:** privacy notice text (visitors cannot proceed without it),
   timings, visitor ID prefix, walk-in rule, document limits.
5. **Access / Operators:** roles' grids; give hosts a mobile number (exit
   codes and notifications go there).
6. Verify the **terminal admin card** holder's ID matches neither ID pattern
   (the VMS must never touch it) and that the card opens each barrier with the
   VMS stopped — it is the outage fallback.

## Visitor portal through a Cloudflare Tunnel

Visitors complete their details and open their exit on their own phones, so
the portal must be reachable from the internet. A Cloudflare Tunnel does this
without opening any inbound port: a small service on the VMS PC connects out
to Cloudflare. **Only the portal paths are published** — `/v/…` (pages),
`/_next/…` (their scripts) and `/public-api/…` (their API). The operator
console, the backend and the terminal endpoints (`/iclock`) stay on the LAN.

> Cloudflare's dashboard changes over time; the menu names below are as of
> October 2026. If a screen differs, keep to the two rules that matter: the
> service is `http://localhost:47101`, and the **path** filter is
> `^/(v/|_next/|public-api/)`.

### Whose Cloudflare account, and which domain

**Each client has their own Cloudflare account, in their name; you are added
as a member to set it up and support it.** Their visitors' personal data
passes through the tunnel, so under the DPDP Act the account belongs with
the client (the data fiduciary), not with us. A link on their own domain is
also what visitors trust in an SMS, and their portal keeps working whatever
happens to our relationship.

A **fixed domain is required in production.** A quick tunnel
(`trycloudflare.com`) changes address on every restart, which breaks every
link already sent, and is for testing only. SMS providers in India also
generally need the link domain whitelisted against the sender's DLT
registration — confirm with the SMS provider early, it can take days.

**Ask the client (before installation day):**

1. A domain whose DNS is on Cloudflare. Either a cheap dedicated one
   (e.g. `clientname-visit.in`, about ₹700–1,000 a year), or their company
   domain **if** its DNS is already on Cloudflare (on the free plan a single
   subdomain cannot be put on Cloudflare while the rest of the DNS stays
   elsewhere).
2. A **free Cloudflare account created with their own email**, with that
   domain added.
3. An invitation for us as a member: Cloudflare dashboard → *Manage account*
   → **Members** → *Invite*, with our email, role **Administrator** (enough to
   create the tunnel and hostname). They can remove it at any time.
4. The SMS provider account (msg91) with the portal domain whitelisted.

Then set up the tunnel below from their account, and record in the site's
handover notes: the account owner's email, the domain, the hostname and the
tunnel name.

**Exception — a client who will not manage Cloudflare:** host them on our own
account and product domain (e.g. `clientname.<our-domain>`), with **one
tunnel per client**, never shared. Only with a contract that names us as
their data processor and says what happens to the hostname if they leave.

### Setting up the tunnel

**Needs:** access to the client's Cloudflare account, with the domain added.
Choose a hostname, e.g. `visit.example.com`.

1. **Create the tunnel:** Cloudflare dashboard → Networks → **Tunnels**
   (shown as *Tunnels & Mesh* in October 2026) → **Create a tunnel** → type
   *Cloudflared* → name it `vms-portal`.
2. **Install the connector on the VMS PC:** choose *Windows*, download and
   install `cloudflared`, then run the shown command in Administrator
   PowerShell — `cloudflared.exe service install <token>`. It installs the
   **Cloudflared** Windows service (automatic start). Treat the token as a
   password. ✅ The tunnel's page shows the connector **Connected** with this
   PC's name.
3. **Publish the portal:** on the tunnel's page, tab **Published application
   routes** (formerly "Public hostname") → add a route: subdomain `visit`,
   domain `example.com`, **Path** `^/(v/|_next/|public-api/)`, service type
   **HTTP**, URL `localhost:47101` (dev testing: `localhost:48101`). Save.
   Requests that match no route get Cloudflare's 404.
   - Not the **Hostname routes** tab — that is private-network access for
     Cloudflare's WARP client, not a public website.
   - Reloaded or left the wizard before this step? Nothing is lost: open
     Networks → Tunnels → `vms-portal` and add the route from that tab.
4. **Tell the VMS its public address:** in the backend `.env` (install
   directory `backend\.env`) set
   `PUBLIC_PORTAL_URL=https://visit.example.com`, then restart `VmsBackend`.
   Links in SMS and email are built from this.
5. **Check from a phone on mobile data (not the site Wi-Fi):**
   - `https://visit.example.com/v/test` → the portal page says the link is
     not valid (the portal is reachable);
   - `https://visit.example.com/login` → **404** (console not published);
   - `https://visit.example.com/public-api/../api/auth/me` and
     `https://visit.example.com/iclock/cdata` → **404**;
   - a real request: the link arrives, the code arrives, the camera opens
     (HTTPS), submit works.

Even if the path filter were missing or wrong, the web app itself refuses
everything except the portal paths for any request that came through
Cloudflare, so the console cannot be reached from the internet.

The portal limits each visitor address to 60 requests a minute, meters codes
(one a minute, five an hour), burns a code after the configured wrong tries,
and sends `no-referrer`, `noindex` and anti-framing headers. The backend
trusts the forwarded visitor address only from the web app on the same PC.

---

## Before installation

- Use an always-on supported Windows PC with fixed LAN addressing, backup destination, and access to every eSSL terminal.
- Confirm the VMS will be the sole roster manager for each terminal.
- Decide distinct, non-overlapping Employee and Visitor ID patterns before connecting any terminal. For example, `1*` for Employees and `9*` for Visitors. Empty patterns classify nobody automatically; an ID matching both categories is rejected/left unclaimed.
- Obtain organization name/logo and the initial Admin details.
- For this schema-changing release, do not reuse old persistent PostgreSQL data. Uninstall preserves data; archive old database/photos manually after confirming they are not needed.
- Release staging always embeds the production Ed25519 public key committed at `installer/license-public.pem` (since 0.5.2; 0.5.0/0.5.1 embedded a dev key by mistake). Issue client keys only with the matching private key in `C:\Secure\VMS-Licensing`.
- **A site on 0.5.0/0.5.1** refuses real keys ("not valid for this installation or is corrupted"). Install 0.5.2 over it, or replace the **last** `LICENSE_PUBLIC_KEY=` line in `C:\VMS\backend\.env` with the line below and restart `VmsBackend`:

  ```
  LICENSE_PUBLIC_KEY="-----BEGIN PUBLIC KEY-----\nMCowBQYDK2VwAyEAo1ZliCVoXSRy8Vuu2mS4TsSjj+v9de9EB9n4ZADRpq4=\n-----END PUBLIC KEY-----"
  ```

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

## Terminal attendance log — enable cyclic deletion

*From 0.4.x (field, October 2026, on a ZAM230 IN terminal).* A terminal whose attendance (T&A) log fills up **refuses every face** (`Failed to verify` / `Error! Reach T&A data max capacity`) and the barrier stays shut. VMS cannot clear terminal logs yet and does not warn as they fill (see `KNOWN_ISSUES.md`), so set every terminal to make room for itself. Do this at installation and on every terminal already in service.

> **Not yet verified on our units.** The menu path and value ranges below are the usual eSSL/ZKTeco firmware layout. They have not been confirmed on the ZAM180 or ZAM230 firmware in the field. Record the exact path, option names and allowed values each firmware actually shows, and correct this section.

**Before you start:** the terminal must show **online** on the VMS Devices page. Cyclic deletion removes the oldest records on the terminal without checking VMS. That is safe only while punches reach VMS within seconds of being made. Clearing or rotating the terminal log never touches the history held in VMS.

1. **Check how full the terminal is:** **Menu → System Info → Device Capacity**. Note *Attendance records* (used / total) and *Attendance photos* (used / total).
2. **Open the attendance settings:** **Menu → System → Attendance**. On some firmware this is called *Attendance Parameters* or *Att. Rule*.
3. **Cyclic Delete ATT Data:** change it from *Disabled* to a number. When the log is full, the terminal then deletes that many of its oldest records and carries on, instead of refusing faces. Use the largest value offered (999 if the range is 1–999), so deletions happen rarely and in one batch. Note whether the screen describes the value as a record count or something else.
4. **Cyclic Delete ATT Photo:** if present, set it the same way. Attendance photo storage is far smaller than record storage (1,000 on the ZAM180) and can fill within days.
5. **Logs Alert / Attendance Log Alert:** if present, set it to a few thousand records (e.g. 5000). The terminal then warns on screen before the log is full.
6. **Attendance photos:** if the site does not need a photo of every punch, set the camera/photo option (often *Camera Mode* or *Save attendance photo*) to *No photo*.
7. **Leave Duplicate Punch Period unchanged.** VMS records its value in each device's settings; if you change it on the terminal, update the Devices page too.
8. **Save and leave the menu.** Some firmware saves only when you back out of the screen.
9. **Verify:** scan a known face. It should verify, and the punch should appear in VMS for this terminal with the correct IN/OUT direction.

If the terminal is **already full** and refusing faces, cyclic deletion may only take effect at the next write. In that case clear the attendance data once by hand first: **Menu → Data Mgt. → Delete Data → Delete Attendance Data** (and attendance photos if full). Before doing so, export any history from before VMS was connected that the client needs, and confirm that the latest terminal records already appear in VMS. **Never** choose *Delete All Data* or any option that deletes users: that wipes every enrolled face.

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

Licence keys cannot be revoked: installing a shorter key over a longer one takes effect at once, but the replaced key stays valid for that installation until its own expiry (`KNOWN_ISSUES.md`).

Back up PostgreSQL, backend photo/logo storage, and ProgramData license marker together. Test restore on a separate machine; a changed MachineGuid requires a replacement paid key. See `LICENSING.md` and the full acceptance guide.

For cloning and running the source directly in an IDE, see `DEVELOPMENT_SETUP.md`.
