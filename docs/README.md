# Documentation

The product is being rebuilt from a single-entrance visitor system into a
**two-zone visitor access system**. Rebuild started 2 October 2026 and runs
phase by phase (`PLAN.md`).

## Reading order

1. **`PRODUCT.md`** — what the system does: zones, visitor and pass types, the
   planned / walk-in / long-term flows, gate-loading rules, controls, roles,
   settings, privacy.
2. **`DEVICE_PROTOCOL.md`** — the eSSL terminals and the raw ADMS protocol as
   verified on real hardware. Read before touching anything under
   `backend/src/adms/`.
3. **`ARCHITECTURE.md`** — how the code is laid out, the queue and jobs, the
   installer, and the packaging traps already paid for.
4. **`PLAN.md`** — the phased rebuild plan and the status of each phase.
5. **`DECISIONS.md`** — every product decision with its date and source.
6. **`EXECUTION_LOG.md`** — what each phase actually changed and how it was
   verified.

## Registers and runbooks

| File | Purpose |
|---|---|
| `KNOWN_ISSUES.md` | Defects and unproven assumptions, with impact and checks |
| `VERSIONS.md` | Release register: what each installer contains and was built from |
| `DEVELOPMENT_SETUP.md` | Running the source tree on a Windows dev machine (ports `48101–48103`) |
| `PEOPLE_TRANSFER.md` | Moving people between installations (`transfer-people.mjs`); carried forward in Phase 3 |
| `VERIFICATION.md` | Manual verification steps for each phase, and their results |
| `TESTING_WITH_TWO_TERMINALS.md` | How to test both zones with only two physical terminals (plus virtual ones) |
| `INSTALL_GUIDE.md` | Installing 0.5.0, upgrading from 0.4.19, two-zone setup, and the Cloudflare Tunnel for the visitor portal (Phase 9) |

The licensing and installer-build runbooks are still the 0.4.19 versions in
`legacy/` (`LICENSING.md`, `INSTALLER_CREATION_STEPS.md`) — unchanged for 0.5.0.

## Rules for these documents

- Every material change or decision is recorded in `EXECUTION_LOG.md` and, if
  it is a decision, `DECISIONS.md`, in the same working session.
- A failed check stays in the log after it is fixed; append the resolution.
- `legacy/` is never edited.
- No client names anywhere (CLAUDE.md hard rule #1).
