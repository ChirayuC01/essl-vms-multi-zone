# VMS Phase 0 — ADMS Test Server (Windows setup)

This is a throwaway server whose only job is to prove the AiFace-Arion's
PUSH protocol works the way the plan assumes, before any real app gets built.

## 1. Install Node.js (skip if already installed)

Open Command Prompt and run:

    node -v

If you see a version number, skip to step 2. If you get "not recognized":

1. Go to https://nodejs.org and download the **LTS** installer for Windows.
2. Run it, accept the defaults, finish the install.
3. Close and reopen Command Prompt, run `node -v` again to confirm.

## 2. Set up this project

1. Unzip/copy this `vms-adms-test-server` folder somewhere simple, e.g. `C:\vms-test`.
2. Open Command Prompt in that folder (type `cmd` in the folder's address bar in File Explorer, or `cd C:\vms-test`).
3. Run:

       npm install

   This downloads Fastify (the one dependency). Takes a few seconds.

## 3. Start the server

       npm start

You should see:

    ADMS test server listening on port 8080.

Leave this window open — this is your live log of everything the device sends.

## 4. Network — already done and verified

Both machines are on the same LAN and can reach each other:

| | |
|---|---|
| Laptop (Wi-Fi) | `192.168.0.106` |
| Device (Ethernet) | `192.168.0.25` |
| Subnet mask | `255.255.255.0` |
| Gateway | `192.168.0.1` |

Verified with:

    ping 192.168.0.25                                    -> replies OK
    powershell Test-NetConnection 192.168.0.25 -Port 4370 -> TcpTestSucceeded : True

So the address you type into the device in step 6 is **`192.168.0.106`** (your laptop).

### Worth doing: pin the device's IP

The device picked up `192.168.0.25` from the router via DHCP, which means it
can change after a reboot or when the lease expires. That matters — the VMS
needs a stable address to reach the device for roster queries and
reconciliation (`device.ip` in the plan's data model).

Two ways to fix it, either is fine:
- **DHCP reservation on the router** (preferred): bind the device's MAC address to `192.168.0.25` in the router admin page. The device keeps using DHCP but always gets the same address.
- **Static IP on the device**: Menu → COMM. → Ethernet → DHCP off, then set IP `192.168.0.25`, Subnet `255.255.255.0`, Gateway `192.168.0.1`. Pick an address **outside the router's DHCP pool** so it can't be handed to another machine later.

Set the Gateway either way — it was `0.0.0.0` before, which blocks anything
needing to leave the subnet (NTP time sync, and later the license/update
checks in the plan's Phase 6).

## 5. Allow the port through Windows Firewall

The first time the server starts, Windows may pop up **"Windows Defender
Firewall has blocked some features of this app"** for Node.js. Click
**Allow access** (at least for Private networks).

If it doesn't prompt (or you dismissed it), add the rule manually:

1. Search "Windows Defender Firewall with Advanced Security" in the Start menu.
2. Inbound Rules → New Rule → Port → TCP → Specific local port: `8080` → Allow the connection → apply to all profiles → name it `VMS ADMS test`.

Without this step the device's requests will silently fail to reach your PC.

## 6. Point the device at your server

On the device: **Menu → COMM. → Cloud server settings**

- Server Address: `192.168.0.106`
- Server Port: `8080`
- Enable: ON

## 7. Watch it work

Within moments you should see `CDATA` and `GETREQUEST` log lines appear in
your first Command Prompt window — that's the device checking in. This
alone proves primitive #1 from Phase 0 (receiving data from the device).

To test creating a user (primitive #2), open a browser while the server is
running and visit something like:

    http://localhost:8080/queue?cmd=DATA%20UPDATE%20USERINFO%20PIN=100%09Name=TestVendor%09Pri=0

(`%09` is a tab character — the ADMS format separates fields with tabs.)
The next time the device polls `/iclock/getrequest` (every ~30s by default),
it will receive this command. Watch the `DEVICECMD` log line for the
result, and check the device's own **User Mgmt.** screen to see if
`TestVendor` actually appeared. The exact field names/format the device
accepts may need a bit of trial and error — that's expected, and exactly
what Phase 0 is for. Note whatever works (or doesn't) so it can go straight
into the real backend later.
