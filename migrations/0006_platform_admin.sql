-- Range indexes for the D1 metrics fallback (admin overview).
CREATE INDEX pass_versions_created ON pass_versions (created_at);
CREATE INDEX registrations_created ON registrations (created_at);
CREATE INDEX outbox_kind_created ON outbox (kind, created_at);
CREATE INDEX connection_runs_started ON connection_runs (started_at);
