-- SCIM receiver (PB-5 review R3): a session revocation the receiver could not carry out (binding off or frozen,
-- dry run, breaker open, a cap reached) stays on the mirror row until the sweep ends the sessions, so a missed
-- push is not lost. `revoked_at` limits one revocation per subject an hour. Deterministic: no clock, no defaults
-- but constants.
ALTER TABLE idp_directory_users ADD COLUMN revoke_pending INTEGER NOT NULL DEFAULT 0 CHECK (revoke_pending IN (0, 1));
ALTER TABLE idp_directory_users ADD COLUMN revoked_at INTEGER;
CREATE INDEX idp_directory_users_pending ON idp_directory_users(last_modified) WHERE revoke_pending = 1;
