-- Request log for every org's Test calls (Workbench v2 S2). The log was a sandbox's; now any org's Test traffic is kept,
-- metadata 7 days, redacted bodies 24 hours and only where the org records them (the sandbox by default, other orgs by
-- the `requestLog.bodies` setting; the write path decides, the triggers only fence Live). Nothing is written for a Live
-- call, in any org.
-- resource_id: the pass, template or key the route touched. api_version: the PassBook-Version date.
-- flags: which of Idempotency-Key (1), If-Match (2) and PassBook-Version (4) the call carried. Never their values.
ALTER TABLE request_log ADD COLUMN resource_id TEXT;
ALTER TABLE request_log ADD COLUMN api_version TEXT;
ALTER TABLE request_log ADD COLUMN bodies_truncated INTEGER NOT NULL DEFAULT 0 CHECK (bodies_truncated IN (0, 1));
ALTER TABLE request_log ADD COLUMN flags INTEGER NOT NULL DEFAULT 0 CHECK (flags BETWEEN 0 AND 7);
CREATE INDEX request_log_org_resource ON request_log (org_id, resource_id, id DESC) WHERE resource_id IS NOT NULL;

DROP TRIGGER request_log_developer_no_live;
DROP TRIGGER request_log_bodies_developer_test_only;
DROP TRIGGER request_log_bodies_developer_test_only_update;
DROP TRIGGER request_log_query_developer_test_only;

CREATE TRIGGER request_log_no_live BEFORE INSERT ON request_log
WHEN NEW.mode <> 'test'
BEGIN SELECT RAISE(ABORT, 'a Live call is never logged'); END;
CREATE TRIGGER request_log_bodies_test_only BEFORE INSERT ON request_log
WHEN NEW.has_bodies = 1 AND NEW.mode <> 'test'
BEGIN SELECT RAISE(ABORT, 'request bodies are kept for Test traffic only'); END;
CREATE TRIGGER request_log_bodies_test_only_update BEFORE UPDATE OF has_bodies, request_body, response_body ON request_log
WHEN NEW.has_bodies = 1 AND NEW.mode <> 'test'
BEGIN SELECT RAISE(ABORT, 'request bodies are kept for Test traffic only'); END;
CREATE TRIGGER request_log_query_test_only BEFORE INSERT ON request_log
WHEN instr(coalesce(NEW.query, ''), '=') > 0 AND NEW.mode <> 'test'
BEGIN SELECT RAISE(ABORT, 'query values are kept for Test traffic only'); END;
