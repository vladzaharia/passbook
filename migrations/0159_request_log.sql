-- Request log (PX16). One row per Test call of a developer org (the sandbox): method, route, path, status, code,
-- duration. Metadata is kept for 7 days; request and response bodies for 24 hours. Nothing is written for a Live call
-- or a real org: the write path skips them, the INSERT selects from developer orgs only, and the triggers refuse
-- a body or a query value anywhere else. A sandbox keeps at most 2,000 rows an hour and 20,000 in all
-- (request_log_budget, kept by triggers), so one free sandbox cannot fill the database.
CREATE TABLE request_log (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES orgs (id),
  key_id TEXT,
  via TEXT CHECK (via IS NULL OR via = 'try'),
  mode TEXT NOT NULL CHECK (mode IN ('live', 'test')),
  request_id TEXT NOT NULL,
  method TEXT NOT NULL,
  route TEXT,
  path TEXT NOT NULL,
  query TEXT,
  status INTEGER NOT NULL,
  code TEXT,
  duration_ms INTEGER NOT NULL,
  at INTEGER NOT NULL,
  has_bodies INTEGER NOT NULL DEFAULT 0 CHECK (has_bodies IN (0, 1)),
  request_body TEXT,
  response_body TEXT,
  CHECK (has_bodies = 1 OR (request_body IS NULL AND response_body IS NULL))
);
CREATE INDEX request_log_org ON request_log (org_id, id DESC);
CREATE INDEX request_log_at ON request_log (at);
CREATE INDEX request_log_org_at ON request_log (org_id, at);
CREATE INDEX request_log_bodies ON request_log (at) WHERE has_bodies = 1;

CREATE TRIGGER request_log_developer_no_live BEFORE INSERT ON request_log
WHEN NEW.mode = 'live' AND EXISTS (SELECT 1 FROM orgs o WHERE o.id = NEW.org_id AND o.kind = 'developer')
BEGIN SELECT RAISE(ABORT, 'a developer org holds no Live data'); END;
CREATE TRIGGER request_log_bodies_developer_test_only BEFORE INSERT ON request_log
WHEN NEW.has_bodies = 1 AND (NEW.mode <> 'test' OR NOT EXISTS (SELECT 1 FROM orgs o WHERE o.id = NEW.org_id AND o.kind = 'developer'))
BEGIN SELECT RAISE(ABORT, 'request bodies are kept for developer Test traffic only'); END;
CREATE TRIGGER request_log_bodies_developer_test_only_update BEFORE UPDATE OF has_bodies, request_body, response_body ON request_log
WHEN NEW.has_bodies = 1 AND (NEW.mode <> 'test' OR NOT EXISTS (SELECT 1 FROM orgs o WHERE o.id = NEW.org_id AND o.kind = 'developer'))
BEGIN SELECT RAISE(ABORT, 'request bodies are kept for developer Test traffic only'); END;

-- The per-sandbox row budget: the hour it counts, the rows written in it, and the rows held. The INSERT reads it
-- (one primary-key lookup) and these triggers keep it, so no call counts rows.
CREATE TABLE request_log_budget (
  org_id TEXT PRIMARY KEY REFERENCES orgs (id),
  hour INTEGER NOT NULL,
  hour_rows INTEGER NOT NULL,
  total_rows INTEGER NOT NULL
) WITHOUT ROWID;
CREATE TRIGGER request_log_budget_add AFTER INSERT ON request_log
BEGIN
  INSERT INTO request_log_budget (org_id, hour, hour_rows, total_rows) VALUES (NEW.org_id, NEW.at / 3600000, 1, 1)
  ON CONFLICT (org_id) DO UPDATE SET
    hour_rows = CASE WHEN hour = excluded.hour THEN hour_rows + 1 ELSE 1 END,
    hour = excluded.hour,
    total_rows = total_rows + 1;
END;
CREATE TRIGGER request_log_budget_drop AFTER DELETE ON request_log
BEGIN
  UPDATE request_log_budget SET total_rows = max(total_rows - 1, 0) WHERE org_id = OLD.org_id;
END;
CREATE TRIGGER request_log_query_developer_test_only BEFORE INSERT ON request_log
WHEN instr(coalesce(NEW.query, ''), '=') > 0 AND (NEW.mode <> 'test' OR NOT EXISTS (SELECT 1 FROM orgs o WHERE o.id = NEW.org_id AND o.kind = 'developer'))
BEGIN SELECT RAISE(ABORT, 'query values are kept for developer Test traffic only'); END;

-- Incident notes for the public status page: a title, a short note, the component it touches (null: the service).
-- Platform admins write them; the page shows open ones and those resolved in the last 14 days.
CREATE TABLE status_incidents (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  note TEXT NOT NULL,
  component TEXT CHECK (component IS NULL OR component IN ('api', 'apple_push', 'email', 'webhooks', 'google', 'samsung')),
  impact TEXT NOT NULL CHECK (impact IN ('notice', 'degraded', 'outage')),
  started_at INTEGER NOT NULL,
  resolved_at INTEGER
);
CREATE INDEX status_incidents_started ON status_incidents (started_at DESC);
