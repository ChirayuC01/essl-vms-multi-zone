-- Settings are Administrator-only by default (owner decision, 5 Oct 2026).
--
-- The Phase 2b seed gave every role with the old site-wide view the
-- "settings:view" cell. Remove it from the seeded roles; Administrators
-- always hold it, and an Admin may grant it to any role from the Access page.
-- No operator loses anything they had in 0.4.19: settings did not exist then.
DELETE FROM "role_permission"
 WHERE "permission" = 'settings:view'
   AND "role_id" IN ('role_authorized_person', 'role_security_incharge', 'role_security', 'role_host', 'role_hr', 'role_hod');
