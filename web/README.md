# VMS Web Console

Next.js/React frontend for the on-premise VMS. It consumes the separate Fastify backend; it is not a standalone application and does not own device ADMS endpoints or background jobs.

## Development

Follow [`docs/DEVELOPMENT_SETUP.md`](../docs/DEVELOPMENT_SETUP.md) for the complete clean-clone setup, PostgreSQL, environment files, backend, web, and physical-terminal workflow.

From this directory, after dependencies and the backend are ready:

```powershell
npm run dev
```

Open `http://localhost:48101`. The development frontend expects the backend at the configured public API URL (`http://localhost:48102` in the documented local setup). These development-only ports avoid the installed VMS `47101–47103` range.

Release builds are created by the repository installer workflow, not deployed to Vercel:

```powershell
npm run lint
npm run build
```

See [`docs/INSTALL_GUIDE.md`](../docs/INSTALL_GUIDE.md) for installed Windows operation and [`docs/VERSIONS.md`](../docs/VERSIONS.md) for the current release candidate.
