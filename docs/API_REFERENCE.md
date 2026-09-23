# VMS API Reference — People Upgrade

**Current packaged artifact:** 0.4.18, built 10 September 2026. The superseded 0.4.14 artifact is defective because its frontend targets the development backend port. Historical release APIs are recorded in `VERSIONS.md`.

All operator routes use JWT and RBAC. Device ADMS routes remain unauthenticated because the terminal protocol cannot supply JWTs. After license expiry, renewal/auth/health/branding remain available; other operator routes return HTTP 402 `{ "error": "LICENSE_EXPIRED", "expiresAt": "..." }`. ADMS and background jobs continue.

## Core routes

| Area | Routes | Notes |
|---|---|---|
| Health | `/health` | Public liveness/database check; 0.4.13+ also returns the packaged VMS version used by the console. |
| Auth/setup | `/api/auth/*`, `/api/setup` | First setup creates Admin, organization branding, and trial. Signed-in operators can read `/api/auth/me`, update their own optional name/phone with `PATCH /api/auth/me`, and change their password after confirming the current password. Email and role are immutable through the self-profile route. |
| People | `/api/people`, `/api/people/:id`, `/api/people/by-pin/:id`, photo/audit/provision subroutes | `EMPLOYEE` or `VISITOR`; eSSL ID is case-insensitively unique text. |
| Employee access | `/api/people/:id/device-access`, `/api/people/:id/resign`, `/api/people/:id/rehire` | Admin assign/remove/restore; resignation revokes every desired assignment; rehire requires device IDs, clears resignation, and queues permanent access on the selected devices. |
| Directories | `/api/companies`, `/api/departments`, `/:id`, `/bulk-assign` | Both roles can view, add, and bulk-assign; only Admin can deactivate/reactivate. Names are case-insensitively unique. |
| Entries | `/api/entries/*` | Visitor-only authorization with optional `personToMeetId`, required purpose, mode, retention, and devices. |
| Operators | `/api/operators`, `/api/operators/active` | Admin management with optional name/phone; every signed-in operator can list active operators for the Person-to-meet picker. |
| Devices | `/api/devices/*` | Includes `employeeIdPatterns` and `visitorIdPatterns`; overlap rejected. |
| Reports | `/api/reports`, `/api/reports/:key` | `attendance` supports dates/category/directories/Person/Device; `resigned-employees` supports dates/Person/directories; the report UI and CSV exports display timestamps in IST while JSON retains standard UTC instants. |
| Branding | `/api/branding`, `/api/branding/logo` | Public read; Admin update. PNG/JPEG/WebP ≤2 MB; no SVG. |
| License | `/api/license` | Authenticated status without installation or machine identifiers; Admin installs a signed key. |
| Operations | `/api/commands`, `/api/alerts`, `/api/events`, `/api/maintenance/*` | SSE follows auth/license rules. |
| ADMS | `/iclock/cdata[.aspx]`, `/getrequest[.aspx]`, `/devicecmd[.aspx]`, `/fdata[.aspx]` | Raw-buffer tolerant; every write goes through queue. |

## Person payload and rules

```json
{
  "esslUserId": "EMP001A",
  "category": "EMPLOYEE",
  "name": "Example Person",
  "mobile": "9876543210",
  "companyId": "...",
  "departmentId": "...",
  "aadharNumber": "123456789012",
  "panNumber": "ABCDE1234F",
  "deviceIds": ["..."]
}
```

A complete profile requires name, mobile, active Company, active Department, category, and Aadhaar or PAN. Aadhaar normalizes to 12 digits. PAN is trimmed, uppercased, validated by `^[A-Z]{5}[0-9]{4}[A-Z]$`, and unique. Employee create/conversion requires devices. Only Admin may change category, directory active status, branding, licenses, or permanent access.

Automatically created People may have `needsDetails=true`. A classified Visitor is removed only after photo and biometric metadata are durable; completing the profile does not authorize entry. Employees remain permanently desired on assigned devices until Admin removal.

## Device patterns

Patterns are case-insensitive `*` globs. Empty lists classify nobody. Employee and Visitor lists may not overlap. A runtime double match or no match is recorded for review and never causes a photo pull, roster mutation, or delete. Known People stay managed if patterns later change.

## Attendance

The `attendance` report returns Person/date, category, current Company/Department, devices, first IN, last OUT, worked seconds, counts, and unmatched warnings. Punches combine across devices and sort by normalized UTC. IN opens an interval; the next OUT closes it. Only complete intervals count. Retention summarizes a complete Person/day transactionally before raw deletion.

## Common status codes

| Code | Meaning |
|---|---|
| 200/201/202 | success/created/queued |
| 400 | malformed or validation failure |
| 401/403 | unauthenticated/permission denied |
| 402 | software license expired |
| 404 | resource not found |
| 409 | duplicate, inactive directory, conflicting state, or wrong-machine key |
| 413/415 | upload too large/unsupported media |

Use `PEOPLE_UPGRADE_VERIFICATION_GUIDE.md` for acceptance examples and physical behavior.
