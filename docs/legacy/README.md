# Legacy documentation (single-entrance VMS, through release 0.4.19)

Everything in this folder describes the product **before** the two-zone visitor
access rebuild began (2 October 2026). The files were moved here unchanged and
are kept for their history and reasoning. **They do not describe current
behaviour.**

Do not update these files. When something here is still true, it has been (or
will be) carried into the current documents in `docs/`, which win wherever the
two disagree.

| Legacy file | What replaced it |
|---|---|
| `VMS_PROJECT_CONTEXT.md` §2–4, `VMS_PRD_Technical_Plan.md` §0/§4 | `docs/DEVICE_PROTOCOL.md` (hardware and protocol facts, still authoritative for the verified firmware) |
| `VMS_PRD_Technical_Plan.md`, `PEOPLE_ATTENDANCE_BRANDING_LICENSING_UPGRADE_PLAN.md`, `API_REFERENCE.md` | `docs/PRODUCT.md` (what the product does) and `docs/ARCHITECTURE.md` (how it is built) |
| `PHASE_*_PLAN.md`, `PEOPLE_UPGRADE_EXECUTION_LOG.md`, session handoffs | `docs/PLAN.md`, `docs/EXECUTION_LOG.md`, `docs/DECISIONS.md` |
| `SESSION_HANDOFF_PHASE6.md` (packaging traps) | `docs/ARCHITECTURE.md` § Packaging traps |
| `DPDP_SHARED_TERMINAL_RISK.md` | `docs/PRODUCT.md` § Privacy |
| `KNOWN_ISSUES.md`, `VERSIONS.md`, `DEVELOPMENT_SETUP.md` | Copied forward unchanged to `docs/` because they are live registers/runbooks |
| `INSTALL_GUIDE.md`, `LICENSING.md`, `PEOPLE_TRANSFER.md`, `INSTALLER_CREATION_STEPS.md`, `DEPLOYMENT_READINESS.md`, `PEOPLE_UPGRADE_VERIFICATION_GUIDE.md` | Still accurate for the installer and licensing as shipped in 0.4.19. Each is copied forward into `docs/` when a rebuild phase changes its area (see `docs/PLAN.md`). Until then, use the copy here. |
| `deliverables/`, `postman/`, `reference/adms-test-server/` | Historical artefacts. The Phase 0 ADMS reference server remains a useful protocol rig. |
