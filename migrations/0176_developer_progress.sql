-- Developer progress (D5). Three more set-once funnel columns: the first successful call with a sandbox key (not a
-- try token), the first change to a Test pass, the first webhook captured. And the quickstart track: the same steps
-- since the track last started, which a sandbox reset restarts while the funnel keeps its first values. Triggers
-- stamp both from what the database records, so no page or beacon can claim a step.
ALTER TABLE developer_sandboxes ADD COLUMN first_key_call_at INTEGER;
ALTER TABLE developer_sandboxes ADD COLUMN first_change_at INTEGER;
ALTER TABLE developer_sandboxes ADD COLUMN first_webhook_at INTEGER;
-- Null until the first reset: the track then starts at the quickstart view, else the sandbox's creation.
ALTER TABLE developer_sandboxes ADD COLUMN track_started_at INTEGER;
ALTER TABLE developer_sandboxes ADD COLUMN track_key_call_at INTEGER;
ALTER TABLE developer_sandboxes ADD COLUMN track_pass_at INTEGER;
ALTER TABLE developer_sandboxes ADD COLUMN track_change_at INTEGER;
ALTER TABLE developer_sandboxes ADD COLUMN track_webhook_at INTEGER;

-- Sandboxes made before this migration: what their rows still show. A change is dated by the pass's last change.
UPDATE developer_sandboxes SET
  first_key_call_at = (SELECT MIN(r.at) FROM request_log r
    WHERE r.org_id = developer_sandboxes.org_id AND r.via IS NULL AND r.status < 400),
  first_change_at = (SELECT MIN(p.modified_at) FROM passes p
    WHERE p.org_id = developer_sandboxes.org_id AND p.mode = 'test' AND p.version > 1),
  first_webhook_at = (SELECT MIN(c.created_at) FROM webhook_captures c WHERE c.org_id = developer_sandboxes.org_id);
UPDATE developer_sandboxes SET
  track_key_call_at = first_key_call_at,
  track_change_at = first_change_at,
  track_webhook_at = first_webhook_at,
  track_pass_at = COALESCE(first_pass_at, (SELECT MIN(p.created_at) FROM passes p
    WHERE p.org_id = developer_sandboxes.org_id AND p.mode = 'test'));

DROP TRIGGER developer_sandboxes_funnel_set_once;
CREATE TRIGGER developer_sandboxes_funnel_set_once
BEFORE UPDATE OF quickstart_viewed_at, first_call_at, first_pass_at, first_preview_at, first_live_key_at,
  first_key_call_at, first_change_at, first_webhook_at, closed_at, close_reason
ON developer_sandboxes
WHEN (OLD.quickstart_viewed_at IS NOT NULL AND NEW.quickstart_viewed_at IS NOT OLD.quickstart_viewed_at)
  OR (OLD.first_call_at IS NOT NULL AND NEW.first_call_at IS NOT OLD.first_call_at)
  OR (OLD.first_pass_at IS NOT NULL AND NEW.first_pass_at IS NOT OLD.first_pass_at)
  OR (OLD.first_preview_at IS NOT NULL AND NEW.first_preview_at IS NOT OLD.first_preview_at)
  OR (OLD.first_live_key_at IS NOT NULL AND NEW.first_live_key_at IS NOT OLD.first_live_key_at)
  OR (OLD.first_key_call_at IS NOT NULL AND NEW.first_key_call_at IS NOT OLD.first_key_call_at)
  OR (OLD.first_change_at IS NOT NULL AND NEW.first_change_at IS NOT OLD.first_change_at)
  OR (OLD.first_webhook_at IS NOT NULL AND NEW.first_webhook_at IS NOT OLD.first_webhook_at)
  OR (OLD.closed_at IS NOT NULL AND NEW.closed_at IS NOT NULL
      AND (NEW.closed_at IS NOT OLD.closed_at OR NEW.close_reason IS NOT OLD.close_reason))
BEGIN SELECT RAISE(ABORT, 'a funnel column is set once'); END;

-- A track step is set once per start. A restart moves track_started_at forward and clears every step with it.
CREATE TRIGGER developer_sandboxes_track_set_once
BEFORE UPDATE OF track_started_at, track_key_call_at, track_pass_at, track_change_at, track_webhook_at
ON developer_sandboxes
WHEN NEW.track_started_at IS OLD.track_started_at AND (
     (OLD.track_key_call_at IS NOT NULL AND NEW.track_key_call_at IS NOT OLD.track_key_call_at)
  OR (OLD.track_pass_at IS NOT NULL AND NEW.track_pass_at IS NOT OLD.track_pass_at)
  OR (OLD.track_change_at IS NOT NULL AND NEW.track_change_at IS NOT OLD.track_change_at)
  OR (OLD.track_webhook_at IS NOT NULL AND NEW.track_webhook_at IS NOT OLD.track_webhook_at))
BEGIN SELECT RAISE(ABORT, 'a track step is set once per start'); END;
CREATE TRIGGER developer_sandboxes_track_restart
BEFORE UPDATE OF track_started_at ON developer_sandboxes
WHEN NEW.track_started_at IS NOT OLD.track_started_at AND (
     NEW.track_started_at IS NULL OR NEW.track_started_at <= COALESCE(OLD.track_started_at, OLD.created_at)
  OR NEW.track_key_call_at IS NOT NULL OR NEW.track_pass_at IS NOT NULL
  OR NEW.track_change_at IS NOT NULL OR NEW.track_webhook_at IS NOT NULL)
BEGIN SELECT RAISE(ABORT, 'a track restart moves forward and clears every step'); END;

-- The steps. Each stamps its funnel column once and its track step once per start; a row older than the start
-- (a request logged after a reset it began before) counts for the funnel only.
CREATE TRIGGER developer_progress_key_call AFTER INSERT ON request_log
WHEN NEW.via IS NULL AND NEW.status < 400
BEGIN
  UPDATE developer_sandboxes SET
    first_key_call_at = COALESCE(first_key_call_at, NEW.at),
    track_key_call_at = CASE WHEN track_key_call_at IS NULL AND NEW.at >= COALESCE(track_started_at, 0)
      THEN NEW.at ELSE track_key_call_at END
  WHERE org_id = NEW.org_id
    AND (first_key_call_at IS NULL OR (track_key_call_at IS NULL AND NEW.at >= COALESCE(track_started_at, 0)));
END;

CREATE TRIGGER developer_progress_pass AFTER INSERT ON passes
WHEN NEW.mode = 'test'
BEGIN
  UPDATE developer_sandboxes SET track_pass_at = NEW.created_at
  WHERE org_id = NEW.org_id AND track_pass_at IS NULL AND NEW.created_at >= COALESCE(track_started_at, 0);
END;

CREATE TRIGGER developer_progress_change AFTER UPDATE OF version ON passes
WHEN NEW.mode = 'test' AND NEW.version > OLD.version
BEGIN
  UPDATE developer_sandboxes SET
    first_change_at = COALESCE(first_change_at, NEW.modified_at),
    track_change_at = CASE WHEN track_change_at IS NULL AND NEW.modified_at >= COALESCE(track_started_at, 0)
      THEN NEW.modified_at ELSE track_change_at END
  WHERE org_id = NEW.org_id
    AND (first_change_at IS NULL
      OR (track_change_at IS NULL AND NEW.modified_at >= COALESCE(track_started_at, 0)));
END;

CREATE TRIGGER developer_progress_webhook AFTER INSERT ON webhook_captures
BEGIN
  UPDATE developer_sandboxes SET
    first_webhook_at = COALESCE(first_webhook_at, NEW.created_at),
    track_webhook_at = CASE WHEN track_webhook_at IS NULL AND NEW.created_at >= COALESCE(track_started_at, 0)
      THEN NEW.created_at ELSE track_webhook_at END
  WHERE org_id = NEW.org_id
    AND (first_webhook_at IS NULL
      OR (track_webhook_at IS NULL AND NEW.created_at >= COALESCE(track_started_at, 0)));
END;
