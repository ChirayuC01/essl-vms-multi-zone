# Offline Licensing Runbook

This is the current owner and support runbook for trial, paid-license issuance, renewal, reinstall adoption, and expiry behavior.

## Security boundary

The customer-facing License page and `GET /api/license` show only license state, type, plan, expiry, remaining days, and expiry warning. They do **not** return or display the installation ID, Windows-derived binding, or any equivalent identifier. License-install audit rows use a neutral identifier, and reports redact the entity ID of any older license audit rows.

The binding is still required internally because licenses work offline and must be valid only for one Windows installation. A new v3 key does not contain that value: its readable payload contains only version, license ID, expiry, and plan, while its signature is calculated over the payload plus the private binding. A determined local Windows administrator can still reverse-engineer an offline verifier. Hiding the binding from the UI, API, audit exports, tools, and key payload prevents casual discovery; it is not a promise that machine binding is undetectable. Stronger resistance requires online activation or hardware-backed licensing.

## Trial lifecycle

1. Installing the software does not start the trial.
2. The 30-day trial starts when first-Admin setup completes.
3. Trial start and latest observed time are stored in PostgreSQL and `%ProgramData%\VMS\license-state.json`.
4. Reconciliation always keeps the earliest trial start and latest observed time. Moving the Windows clock backwards therefore does not extend the trial and raises a clock warning.
5. Ordinary uninstall, reinstall, and upgrade preserve ProgramData, so they do not restart the trial.

An administrator who deliberately deletes both PostgreSQL and ProgramData, or restores an old VM snapshot, can still bypass this offline protection. Preventing that reliably requires online activation or hardware-backed state.

## One-time issuer setup and release build

Run this only on the product owner's secured computer:

```powershell
node backend/scripts/license/generate-keypair.mjs `
  --output-dir "C:\Secure\VMS-Licensing"
```

Back up the private PEM and ledger separately. Never commit, email, install, or copy either one to a customer machine. A release contains only the public key:

```powershell
$env:VMS_LICENSE_PUBLIC_KEY_FILE='C:\Secure\VMS-Licensing\vms-license-public.pem'
node installer/build-release.mjs
```

Release staging refuses to continue without the public key. It excludes all issuer scripts, keys, and ledger material; only the request-only collector is copied to `C:\VMS\tools`.

## Privately collect the license binding

There is deliberately no client-visible Machine ID. The installer includes a request-only helper at `C:\VMS\tools\create-license-request.mjs`. It contains no signing key, cannot issue a license, and writes the binding only to the requested file.

Example, where `X:` is secured removable media:

```powershell
& 'C:\VMS\node\node.exe' `
  'C:\VMS\tools\create-license-request.mjs' `
  --output 'X:\license-request.txt'
```

The console reports only the output path, never the binding value. Take the secured media back to the issuer computer. For remote support, transfer this file only through an owner-controlled secure channel and delete the temporary copy afterward.

## Generate a paid or renewal key

On the secured issuer computer:

```powershell
node backend/scripts/license/issue-license.mjs `
  --private-key "C:\Secure\VMS-Licensing\vms-license-private.pem" `
  --ledger "C:\Secure\VMS-Licensing\vms-license-ledger.json" `
  --machine-id-file "X:\license-request.txt" `
  --client-name "Private customer label" `
  --expires-at "2027-08-01T18:30:00+05:30" `
  --plan "standard"
```

`--expires-at` must include an exact time and either `Z` or a timezone offset. It is normalized to UTC before signing. The v3 key's readable payload contains version, random license ID, exact UTC expiry, and optional plan. The signature—not the payload—is bound to the private installation value. The customer name and binding stay only in the private issuer ledger.

Deliver only the printed license key. Back up the updated ledger immediately. The ledger records the client label, binding, expiry, plan, issue time, key fingerprint, and issued key. If the ledger is lost, the client label cannot be recovered from the license key.

To verify a key and resolve its private client label:

```powershell
node backend/scripts/license/inspect-license.mjs `
  --public-key "C:\Secure\VMS-Licensing\vms-license-public.pem" `
  --ledger "C:\Secure\VMS-Licensing\vms-license-ledger.json" `
  "<license-key>"
```

This reconstructs the v3 signed data using the private ledger, verifies the Ed25519 signature, and resolves the customer label. It is not decryption, and its output omits the private binding.

## What happens when the client installs the key

The License navigation entry is intentionally hidden. An Admin opens `/license` directly, pastes the key, and selects **Install license**. The backend performs all checks before replacing anything:

1. Parse the two-part signed key.
2. Verify its Ed25519 signature using the public key shipped in VMS.
3. Require a supported payload version (new issuance uses v3; v1/v2 remain accepted for compatibility).
4. Reconstruct the signed data using this installation's internal binding and verify that it matches.
5. Confirm the exact signed expiry is still in the future.
6. Store the key and its indexed metadata in PostgreSQL. Every later status calculation re-verifies the key and derives expiry/plan from the signed payload instead of trusting editable database columns.
7. Mirror it to `%ProgramData%\VMS\license-state.json`.
8. Return the new active status, plan, expiry, and remaining days.

Malformed, altered, expired, or wrong-machine keys are rejected and do not replace the current stored license. A valid renewal takes effect immediately; no service restart or reinstall is required.

## Expiry behavior

At the exact signed UTC instant, VMS becomes expired. It does not delete or block any Person and it does not interrupt the terminal/barrier path.

Still available:

- Sign-in needed for renewal.
- Password change.
- Public branding and health checks.
- Authenticated license status.
- Admin license installation.
- Terminal ADMS communication.
- Punch ingestion and command dispatch.
- Retention, reconciliation, expiry, and safety jobs.
- Existing device-side biometric matching and barrier access.

Blocked until renewal:

- Normal operator pages and APIs, including People, entries, reports, devices, directories, settings, operators, and their SSE stream.
- Blocked APIs return HTTP 402 with `{ "error": "LICENSE_EXPIRED", "expiresAt": "..." }`.

The Admin is directed to the License page. After a valid renewal key is installed, normal APIs and pages work immediately and existing data remains unchanged.

## Reinstall, upgrade, and replacement machines

- Ordinary reinstall or upgrade preserves the ProgramData marker. On startup, VMS verifies and imports its valid paid key into a recreated database automatically.
- Uninstall intentionally does not remove the ProgramData marker or application data.
- A full Windows reinstall, changed `MachineGuid`, VM clone, VM replacement, or hardware migration changes the internal binding. The existing key is rejected and the owner must privately collect the new binding and issue a replacement key.
- Keep the old ledger entry for history; issue a new license ID instead of editing an old ledger record.

Use `PEOPLE_UPGRADE_VERIFICATION_GUIDE.md` for the complete acceptance matrix.
