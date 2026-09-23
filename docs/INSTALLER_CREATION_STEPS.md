Run the following from **PowerShell** in the repository root:

```powershell
Set-Location 'C:\Work\essl-vms-main'
```

First increment this line in `installer\vms-installer.iss`; never rebuild changed code under an existing version:

```ini
AppVersion=0.4.19
```

Then run:

```powershell
$env:VMS_LICENSE_PUBLIC_KEY_FILE = 'C:\Secure\VMS-Licensing\vms-license-public.pem'

Push-Location backend
npx prisma generate
npm run package
Pop-Location

Push-Location web
npm run build
Pop-Location

node installer\build-release.mjs

& 'C:\Program Files (x86)\Inno Setup 6\ISCC.exe' `
  'installer\vms-installer.iss'
```

The finished installer will be created at:

```text
C:\Work\essl-vms-main\installer\Output\vms-setup.exe
```

Verify it before copying:

```powershell
(Get-Item 'installer\Output\vms-setup.exe').VersionInfo.ProductVersion
Get-FileHash 'installer\Output\vms-setup.exe' -Algorithm SHA256
```

The reported version must match `AppVersion`. `npm run package` reads that same value and embeds it in the backend `/health` response, so the operator console and Windows installation metadata cannot drift. Keep the generated SHA-256 value so you can verify that the installer copied to the client is unchanged.

Development uses `48101–48103` only through ignored local environment files
and development npm commands. Release staging validates that the installer
templates still use web `47101`, backend `47102`, and PostgreSQL `47103`; it
stops with an error if a development backend URL leaks into either the
templates or compiled Next.js payload. `npm run build` explicitly supplies
the installed defaults, so `web/.env.local` cannot be baked into the release.

Only the public licensing key is used while building. Never use or copy this private key into the project or installer:

```text
C:\Secure\VMS-Licensing\vms-license-private.pem
```
