-- A step-up round trip (prompt=login, max_age=0) records when it started; the callback then
-- requires an auth_time from after that, so a provider that ignores max_age cannot pass it.
ALTER TABLE oidc_flows ADD COLUMN step_up_started_at INTEGER;
