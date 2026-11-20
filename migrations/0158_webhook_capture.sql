-- Webhook tester (PX11). A capture endpoint stores PassBook's own signed delivery instead of sending it. It
-- exists only in a developer org in Test, never changes target or url, and nothing reads it from outside.
ALTER TABLE webhook_endpoints ADD COLUMN target TEXT NOT NULL DEFAULT 'url' CHECK (target IN ('url', 'capture'));

CREATE TRIGGER webhook_endpoints_capture_scope BEFORE INSERT ON webhook_endpoints
WHEN NEW.target = 'capture' AND (NEW.mode != 'test'
  OR NOT EXISTS (SELECT 1 FROM orgs o WHERE o.id = NEW.org_id AND o.kind = 'developer'))
BEGIN SELECT RAISE(ABORT, 'a capture endpoint is for a developer org in Test'); END;

-- One capture endpoint per org: two concurrent creates leave one.
CREATE UNIQUE INDEX webhook_endpoints_one_capture ON webhook_endpoints (org_id) WHERE target = 'capture';

CREATE TRIGGER webhook_endpoints_target_immutable BEFORE UPDATE OF target ON webhook_endpoints
WHEN NEW.target IS NOT OLD.target
BEGIN SELECT RAISE(ABORT, 'immutable webhook endpoint target'); END;

CREATE TRIGGER webhook_endpoints_capture_url BEFORE UPDATE OF url ON webhook_endpoints
WHEN OLD.target = 'capture' AND NEW.url IS NOT OLD.url
BEGIN SELECT RAISE(ABORT, 'a capture endpoint has no url to change'); END;

CREATE TABLE webhook_captures (
  id TEXT PRIMARY KEY,
  endpoint_id TEXT NOT NULL,
  org_id TEXT NOT NULL,
  mode TEXT NOT NULL CHECK (mode = 'test'),
  event_id TEXT NOT NULL,
  event_type TEXT NOT NULL,
  trigger TEXT NOT NULL CHECK (trigger IN ('event', 'replay', 'test')),
  headers TEXT NOT NULL CHECK (json_valid(headers)),
  body TEXT NOT NULL CHECK (length(CAST(body AS BLOB)) <= 262144),
  status INTEGER NOT NULL DEFAULT 200,
  duration_ms INTEGER NOT NULL DEFAULT 0 CHECK (duration_ms >= 0),
  created_at INTEGER NOT NULL,
  FOREIGN KEY (endpoint_id, org_id, mode) REFERENCES webhook_endpoints (id, org_id, mode) ON DELETE CASCADE
);
CREATE INDEX webhook_captures_endpoint ON webhook_captures (endpoint_id, org_id, mode, created_at DESC, id DESC);
CREATE INDEX webhook_captures_age ON webhook_captures (created_at);

-- Captures per org and clock hour. A row is counted when it is stored, and pruning does not give it back.
CREATE TABLE webhook_capture_hours (
  org_id TEXT NOT NULL REFERENCES orgs (id) ON DELETE CASCADE,
  hour INTEGER NOT NULL,
  n INTEGER NOT NULL CHECK (n > 0),
  PRIMARY KEY (org_id, hour)
);

CREATE TRIGGER webhook_captures_target BEFORE INSERT ON webhook_captures
WHEN NOT EXISTS (SELECT 1 FROM webhook_endpoints e WHERE e.id = NEW.endpoint_id AND e.target = 'capture')
BEGIN SELECT RAISE(ABORT, 'not a capture endpoint'); END;

-- At most 600 an hour per org.
CREATE TRIGGER webhook_captures_hourly BEFORE INSERT ON webhook_captures
BEGIN
  INSERT INTO webhook_capture_hours (org_id, hour, n) VALUES (NEW.org_id, NEW.created_at / 3600000, 1)
    ON CONFLICT (org_id, hour) DO UPDATE SET n = n + 1;
  SELECT RAISE(ABORT, 'capture hourly limit')
    WHERE (SELECT n FROM webhook_capture_hours WHERE org_id = NEW.org_id AND hour = NEW.created_at / 3600000) > 600;
END;

-- At most 200 per endpoint: the oldest go first.
CREATE TRIGGER webhook_captures_prune AFTER INSERT ON webhook_captures
BEGIN
  DELETE FROM webhook_captures WHERE endpoint_id = NEW.endpoint_id AND rowid NOT IN (
    SELECT rowid FROM webhook_captures WHERE endpoint_id = NEW.endpoint_id
    ORDER BY created_at DESC, rowid DESC LIMIT 200);
END;

-- Erasing a pass erases what the sandbox captured about it.
CREATE TRIGGER webhook_captures_pass_erased AFTER DELETE ON passes
WHEN EXISTS (SELECT 1 FROM webhook_endpoints e WHERE e.org_id = OLD.org_id AND e.target = 'capture')
BEGIN
  DELETE FROM webhook_captures
  WHERE endpoint_id IN (SELECT e.id FROM webhook_endpoints e WHERE e.org_id = OLD.org_id AND e.target = 'capture')
    AND CASE WHEN json_valid(body) THEN json_extract(body, '$.pass.id') END = OLD.id;
END;

CREATE TRIGGER webhook_captures_append_only BEFORE UPDATE ON webhook_captures
BEGIN SELECT RAISE(ABORT, 'captures are append-only'); END;

-- Last, so it runs first: a Live row of a developer org is refused before any other check (see 0156).
CREATE TRIGGER webhook_captures_developer_no_live BEFORE INSERT ON webhook_captures
WHEN NEW.mode = 'live' AND EXISTS (SELECT 1 FROM orgs o WHERE o.id = NEW.org_id AND o.kind = 'developer')
BEGIN SELECT RAISE(ABORT, 'a developer org holds no Live data'); END;
