# VMS Development Setup — Fresh Clone on Windows

> **Carried forward from `legacy/DEVELOPMENT_SETUP.md` on 2 October 2026** at the start of the two-zone rebuild. Content below is unchanged from 0.4.19; rebuild-era entries are added as phases land.

This guide starts the source project on a new Windows development machine. It runs three long-lived services directly from IDE terminals:

1. Bundled PostgreSQL on `localhost:48103`
2. Fastify backend/API/ADMS service on `localhost:48102`
3. Next.js web console on `localhost:48101`

It does not install Windows services or use the production installer.
The development-only `48101–48103` range intentionally does not overlap the
installed VMS range (`47101–47103`), so both stacks can run at the same time.

## 1. Prerequisites

Install:

- Git for Windows.
- 64-bit Node.js 22 LTS, including npm.
- An IDE such as Visual Studio Code.

Confirm them in an ordinary, non-Administrator PowerShell terminal:

```powershell
git --version
node --version
npm --version
```

Do not run the bundled PostgreSQL terminal as Administrator. PostgreSQL deliberately refuses to run as an elevated process.

Ensure these local ports are available:

| Port | Service |
|---:|---|
| `48101` | Next.js development UI |
| `48102` | Backend operator API and terminal ADMS endpoints |
| `48103` | Bundled PostgreSQL |
| `5555` | Prisma Studio, only while running it |

For a physical terminal, the PC and terminal must be reachable on the same LAN. Windows Firewall must allow inbound TCP `48102` for the development backend process.

## 2. Clone the repository

Choose a normal development folder and clone the remote repository:

```powershell
cd C:\Work
git clone <repository-url> essl-vms-main
cd essl-vms-main
```

Replace `<repository-url>` with the real Git remote URL. Do not commit generated `.env` files, database data, photographs, license markers, or private license keys.

## 3. Install dependencies

Use the committed lock files for repeatable installations:

```powershell
cd C:\Work\essl-vms-main\backend
npm ci

cd C:\Work\essl-vms-main\web
npm ci
```

No separate PostgreSQL download is required. The backend dependency includes the pinned PostgreSQL runtime used by the project.

## 4. Create development environment files

### Backend

```powershell
cd C:\Work\essl-vms-main\backend
Copy-Item .env.example .env
$env:VMS_PG_PORT = '48103'
npm run setup:env -- --backend-port=48102
Remove-Item Env:VMS_PG_PORT
```

The setup command generates a private JWT secret and configures the bundled database connection. Review `.env`; for the standard development layout the important values are:

```dotenv
DATABASE_URL=postgresql://vms_app:devpassword@localhost:48103/vms
PORT=48102
ADMS_PORT=48102
PHOTO_STORAGE_PATH=./.dev/photos
CORS_ORIGINS=http://localhost:48101
```

If `CORS_ORIGINS` points anywhere else, change it to `http://localhost:48101` for Next.js development.

Keep `JWT_SECRET` as the generated value. Never copy a production secret or issuer private key into this clone.

### Web

```powershell
cd C:\Work\essl-vms-main\web
Copy-Item .env.example .env.local
```

Change `.env.local` to:

```dotenv
API_BASE_URL=http://localhost:48102
NEXT_PUBLIC_API_URL=http://localhost:48102
```

After changing either environment file, restart the affected development service.

## 5. Start all three services

Open the repository folder in the IDE and create three separate terminals. Keep all three running.

### Terminal 1 — PostgreSQL

```powershell
cd C:\Work\essl-vms-main\backend
npm run db:dev:start
```

On its first run this command initializes `backend\.dev\pgdata`, creates the `vms_app` role and `vms` database, and applies committed Prisma migrations. Later starts reuse the same development data and apply only new migrations.

Wait for:

```text
Bundled Postgres ready on port 48103.
```

### Terminal 2 — backend/API/jobs/ADMS

```powershell
cd C:\Work\essl-vms-main\backend
npm run db:generate
npm run dev
```

Wait until the log reports that the database is reachable and the server is listening on port `48102`.

Check it in a browser:

```text
http://localhost:48102/health
```

Expected response:

```json
{"status":"ok","database":"reachable"}
```

### Terminal 3 — web console

```powershell
cd C:\Work\essl-vms-main\web
npm run dev
```

Open:

```text
http://localhost:48101
```

## 6. Complete first-run setup

With a fresh database, the web console redirects to `/setup`.

1. Create the first Admin account.
2. Enter the customer organization name.
3. Optionally upload a PNG, JPEG, or WebP logo.
4. Submit setup; this starts the persistent 30-day trial.
5. Sign in with the Admin account you just created.
6. Create at least one Company and one Department from Directory.

Do not run the development seed before this step if you want to test the real first-run wizard. The wizard permanently closes as soon as any `AppUser` exists.

### Optional seeded development account

If you deliberately want to skip the setup wizard on a disposable database:

```powershell
cd C:\Work\essl-vms-main\backend
npm run db:seed
```

This creates the documented development-only account `admin@vms.local` with temporary password `admin` and forces an immediate password change. Never use seeded credentials outside local development.

## 7. Connect a physical eSSL terminal

1. Run `ipconfig` and note the development PC's LAN IPv4 address.
2. In the terminal's Cloud Server/ADMS settings, use that IPv4 address and port `48102`. Do not use `localhost`; from the terminal, `localhost` means the terminal itself.
3. Wait for the terminal to appear as unregistered in Devices, then register it using its exact serial number.
4. Configure its role (`IN`, `OUT`, or `BOTH`), timezone, normal/blocked access groups, direction status codes, and duplicate-punch period.
5. Configure distinct, non-overlapping category patterns before enrollment—for example Employee `1*` and Visitor `9*`.

Pattern rules:

- Empty patterns mean no automatic classification.
- An ID must match exactly one category.
- Overlapping Employee and Visitor patterns are rejected.
- IDs matching neither category remain unclaimed and are never modified automatically.
- Existing known People remain managed even if patterns later change.

After configuration, enroll and scan a test ID. An Employee should remain permanently assigned to the originating device. A Visitor should be created with `needs details`, have their JPEG stored, and only then be removed from the terminal until an Entry is authorized.

## 8. Development tools

### Prisma Studio

Run in a fourth terminal while PostgreSQL is running:

```powershell
cd C:\Work\essl-vms-main\backend
npm run db:studio
```

Open `http://localhost:5555`. `AppConfig.value` is JSONB; when manually editing a JSON string in Studio it must retain JSON quotes, for example `"Mission Startup"`. Avoid manually changing installation, trial, or license values.

### Watch incoming punches

```powershell
cd C:\Work\essl-vms-main\backend
npm run watch:punches
```

### Verify the source tree

```powershell
cd C:\Work\essl-vms-main\backend
npm run typecheck
npm test
npm run build

cd C:\Work\essl-vms-main\web
npm run lint
npm run build
```

Run the database-backed E2E harness only against its documented disposable database, never against the development or production database:

```powershell
cd C:\Work\essl-vms-main\backend
npm run verify:e2e
```

## 9. Stop and restart

Use `Ctrl+C` in the web and backend terminals, then in the PostgreSQL terminal. Stop PostgreSQL last so backend shutdown can finish cleanly.

On the next development session, restart in this order:

1. `npm run db:dev:start`
2. `npm run dev` in `backend`
3. `npm run dev` in `web`

Data survives restarts in:

- PostgreSQL: `backend\.dev\pgdata`
- Photographs: `backend\.dev\photos`
- Branding: the configured local branding path
- Trial/paid-key reinstall marker: `%ProgramData%\VMS\license-state.json`

Do not delete `%ProgramData%\VMS\license-state.json` to restart the trial. It deliberately survives repository deletion, reinstall, and upgrade.

## 10. Updating an existing clone

Commit or safely set aside your own source changes before updating, then:

```powershell
cd C:\Work\essl-vms-main
git pull

cd backend
npm ci
npm run db:generate

cd ..\web
npm ci
```

Restart PostgreSQL first; `db:dev:start` applies new committed migrations before the backend starts.

## 11. Common failures

### PostgreSQL refuses to start

- Ensure Terminal 1 is not running as Administrator.
- Check that port `48103` is unused.
- Ensure no other bundled PostgreSQL terminal is already running.
- Read the first error above the shutdown message; do not delete `pgdata` as a first response.

### Backend reports database unreachable

- Confirm Terminal 1 says PostgreSQL is ready.
- Confirm backend `.env` uses port `48103` and the same database/user configured by the development bundled script.
- Run `npm run db:generate` after dependency/schema changes.

### Browser cannot call the API

- Confirm `http://localhost:48102/health` works.
- Confirm backend `CORS_ORIGINS=http://localhost:48101`.
- Confirm both web environment values use `http://localhost:48102`.
- Restart backend/web after changing environment files.

### Terminal does not connect

- Use the PC's LAN IPv4 address, not `localhost`.
- Allow inbound TCP `48102` through Windows Firewall.
- Confirm the terminal uses the `.aspx` ADMS endpoints supported by this backend.
- Check backend logs for the exact serial number and unrecognized request paths.

### A page returns `{ "error": "internal error" }`

The browser receives a generic message by design. Read the backend terminal's matching `unhandled error` entry for the real exception and stack. Do not diagnose a 500 from the browser message alone.

## Related guides

- `INSTALL_GUIDE.md` — production Windows installer procedure.
- `PEOPLE_UPGRADE_VERIFICATION_GUIDE.md` — complete functional and hardware acceptance matrix.
- `API_REFERENCE.md` — operator and device API reference.
- `LICENSING.md` — issuer-only key generation and renewal.
- `KNOWN_ISSUES.md` — current defects and unverified assumptions.
