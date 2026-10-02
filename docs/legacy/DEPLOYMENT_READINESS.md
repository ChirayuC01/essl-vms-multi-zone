# Deployment Readiness — People Upgrade

Do not schedule production rollout until all answers are owned.

| Requirement | Evidence required |
|---|---|
| Always-on Windows host, fixed IP, power protection | Host and network owner named |
| VMS sole ownership of each managed roster | Existing attendance/access software disconnected or topology separated |
| Correct terminal configuration | Serial, firmware, ADMS, face algorithm, timezone, IN/OUT role, group IDs recorded |
| Employee/Visitor classification | Non-overlapping ID patterns approved; unmatched behavior understood |
| Capacity | Current and projected face counts below verified 3,000-face limit |
| Privacy/legal basis | Policy for permanent photos and Aadhaar/PAN, notices, access, backup, retention approved |
| Directories | Company and Department master lists supplied, or an export from an existing installation agreed (`PEOPLE_TRANSFER.md`) |
| Operations | Admins/operators named; Employee removal authority and Visitor authorization process agreed |
| Backup/recovery | PostgreSQL, photos/logo, and ProgramData destinations plus restore drill scheduled |
| Licensing | Issuer key/ledger backed up; owner-technician private binding collection and expiry approval workflow defined; no machine or installation identifier exposed in the client UI/API |
| Release acceptance | Every applicable item in `PEOPLE_UPGRADE_VERIFICATION_GUIDE.md` passed and recorded |

Critical operational facts:

- The device opens the barrier locally; VMS controls who is provisioned.
- Employees remain permanently desired until Admin removal. Visitors use time-bounded Entries.
- The backend expiry/reconciliation jobs are security controls because terminal datetime fields do not enforce expiry.
- Denied attempts are not uploaded by the tested firmware.
- Device timestamps are local and must have the correct timezone configured.
- Photos are durable local artifacts; templates are algorithm-bound and not portable.
- Offline licensing resists ordinary reinstall, not an administrator erasing all stores or restoring a snapshot.
- This release requires a clean identity schema; it does not silently migrate an old production roster.

Production approval requires named sign-off from site operations, IT/network, privacy/data owner, and the product release owner.
