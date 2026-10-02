# Execution Log — Two-Zone Rebuild

Append-only. One entry per material change or verification, per phase. A
failed check stays recorded after it is fixed; append the resolution.

Entry shape: date · phase · status · change · files · verification (exact
result) · issues · next action.

---

### 2026-10-02 — Phase 0 — Docs baseline and legacy split

- **Status:** `IMPLEMENTED_AWAITING_VERIFICATION`.
- **Baseline:** commit `0bd3080` ("replicated vms for one zone") exists. The
  working tree also shows ~117 files modified before this phase began; the
  diff is **line endings only** (`git diff --ignore-cr-at-eol` is empty). Left
  untouched — not part of this phase.
- **Change:**
  - `git mv` of every file under `docs/` (22 documents plus `deliverables/`,
    `postman/`, `reference/`) into `docs/legacy/`, content unchanged.
  - Added `docs/legacy/README.md` mapping each legacy file to its replacement.
  - New current docs: `README.md`, `PRODUCT.md`, `DEVICE_PROTOCOL.md`,
    `ARCHITECTURE.md`, `PLAN.md`, `DECISIONS.md`, this log.
  - Copied forward unchanged (live registers/runbooks): `KNOWN_ISSUES.md`,
    `VERSIONS.md`, `DEVELOPMENT_SETUP.md`, each with a carry-forward note.
  - Rewrote `CLAUDE.md` and `AGENTS.md` for the two-zone product: hard rules
    kept, rule #9 amended (exit code / override, admin-card outage release,
    automatic release on recovery), doc pointers moved to the new set.
- **Not changed:** no source, schema, config or installer file.
- **Verification (2026-10-02):**
  - Backend `npm run typecheck`: PASS.
  - Backend `npm test`: **82/82 PASS**. Run through Windows Node
    (`cmd.exe /c … npm test`): `node_modules` is installed for Windows, so
    `tsx` under WSL fails with "esbuild installed for another platform". This
    is environmental, not a test failure.
  - Web `npm run lint` and `npm run build`: PASS (Windows Node), all 20 routes
    built.
  - `verify:e2e`: not run. No source changed in this phase, and it needs a
    `*_test` database.
  - `git status`: only renames into `docs/legacy/`, new files under `docs/`,
    and `CLAUDE.md`/`AGENTS.md`. Apart from the pre-existing line-ending noise,
    `git diff --ignore-cr-at-eol` touches only those two files.
- **Next action:** owner reviews `docs/README.md` → `PRODUCT.md` against what
  the client was told; on acceptance, Phase 1 (zones and gates) begins.
