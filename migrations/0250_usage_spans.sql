-- Live pass spans (AD4, AD10). A span is the stretch a Live pass counts as live: it starts at the first taken
-- signal and ends at the first of expiry, void, removal, deletion, the last Apple device unregistering (Apple
-- spans only) or 90 days without use. Triggers keep it, so no create or write path can skip it. Times come from
-- the event or the row that caused them, never from the database clock. No foreign keys: a purged pass keeps its
-- span for the recount window. A replacement pass (identity move) takes over the old pass's open span.
CREATE TABLE pass_live_spans (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  -- The pass the span follows now; a move re-points it to the replacement.
  pass_id TEXT NOT NULL,
  -- apple, google, samsung or web (printed or scanned with no wallet signal).
  platform TEXT NOT NULL CHECK (platform IN ('apple', 'google', 'samsung', 'web')),
  live_from INTEGER NOT NULL,
  live_to INTEGER,
  end_reason TEXT CHECK (end_reason IS NULL OR end_reason IN
    ('expiry', 'void', 'removal', 'deletion', 'unregistered', 'idle')),
  expires_at INTEGER,
  last_used_at INTEGER NOT NULL,
  CHECK ((live_to IS NULL) = (end_reason IS NULL))
);
CREATE INDEX pass_live_spans_pass ON pass_live_spans (pass_id) WHERE live_to IS NULL;
CREATE INDEX pass_live_spans_org ON pass_live_spans (org_id, live_from);
CREATE UNIQUE INDEX pass_live_spans_one_open ON pass_live_spans (pass_id) WHERE live_to IS NULL;

CREATE TABLE pass_usage (
  pass_id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  first_taken_at INTEGER NOT NULL,
  last_used_at INTEGER NOT NULL
) WITHOUT ROWID;

-- The gauge reads this: min(live_to, expires_at, last_used_at + 90 days), never before the start. A span the
-- tidy-up job has not closed yet therefore cannot inflate a day after its real end.
CREATE VIEW pass_live_spans_effective AS
SELECT s.*,
  MAX(s.live_from, MIN(COALESCE(s.live_to, 9000000000000000), COALESCE(s.expires_at, 9000000000000000), s.last_used_at + 7776000000)) AS effective_to,
  CASE WHEN s.live_to IS NOT NULL AND s.live_to <= COALESCE(s.expires_at, 9000000000000000) AND s.live_to <= s.last_used_at + 7776000000 THEN s.end_reason
    WHEN COALESCE(s.expires_at, 9000000000000000) <= s.last_used_at + 7776000000 THEN 'expiry' ELSE 'idle' END AS effective_reason
FROM pass_live_spans s;

-- Taken signals start a span, any use extends it. A stale open span (expired or idle before this event) closes
-- at its effective end first, so a late event starts a new span instead of reviving it.
CREATE TRIGGER pass_live_spans_event AFTER INSERT ON pass_events
WHEN NEW.mode = 'live' AND NEW.kind IN ('device.registered', 'wallet.saved', 'pass.printed', 'scan.checked_in', 'scan.redeemed', 'scan.checked_out', 'scan.adjusted', 'device.fetched')
BEGIN
  UPDATE pass_live_spans
  SET live_to = MAX(live_from, MIN(COALESCE(expires_at, 9000000000000000), last_used_at + 7776000000)),
    end_reason = CASE WHEN COALESCE(expires_at, 9000000000000000) <= last_used_at + 7776000000 THEN 'expiry' ELSE 'idle' END
  WHERE live_to IS NULL AND pass_id IN (NEW.pass_id, COALESCE((SELECT m.new_pass_id FROM pass_moves m WHERE m.old_pass_id = NEW.pass_id), NEW.pass_id), COALESCE((SELECT m.old_pass_id FROM pass_moves m WHERE m.new_pass_id = NEW.pass_id), NEW.pass_id))
    AND MIN(COALESCE(expires_at, 9000000000000000), last_used_at + 7776000000) <= NEW.at;

  -- The replacement of a move takes over the old pass's open span.
  UPDATE pass_live_spans
  SET pass_id = NEW.pass_id, expires_at = COALESCE((SELECT (CASE WHEN json_valid(v.pass_json) THEN CAST(strftime('%s', json_extract(v.pass_json, '$.expirationDate')) AS INTEGER) * 1000 END) FROM pass_versions v WHERE v.pass_id = NEW.pass_id ORDER BY v.version DESC LIMIT 1), expires_at)
  WHERE live_to IS NULL AND NEW.kind IN ('device.registered', 'wallet.saved', 'pass.printed', 'scan.checked_in', 'scan.redeemed', 'scan.checked_out', 'scan.adjusted')
    AND pass_id = (SELECT m.old_pass_id FROM pass_moves m WHERE m.new_pass_id = NEW.pass_id)
    AND NOT EXISTS (SELECT 1 FROM pass_live_spans o WHERE o.pass_id = NEW.pass_id AND o.live_to IS NULL);

  INSERT INTO pass_live_spans (id, org_id, pass_id, platform, live_from, expires_at, last_used_at)
  SELECT NEW.id, NEW.org_id, NEW.pass_id,
    CASE WHEN NEW.kind = 'device.registered' THEN 'apple'
      WHEN NEW.kind = 'wallet.saved' AND json_extract(NEW.data, '$.provider') IN ('google', 'samsung')
        THEN json_extract(NEW.data, '$.provider')
      WHEN NEW.kind = 'wallet.saved' THEN 'google'
      ELSE 'web' END,
    NEW.at, (SELECT (CASE WHEN json_valid(v.pass_json) THEN CAST(strftime('%s', json_extract(v.pass_json, '$.expirationDate')) AS INTEGER) * 1000 END) FROM pass_versions v WHERE v.pass_id = NEW.pass_id ORDER BY v.version DESC LIMIT 1), NEW.at
  WHERE NEW.kind IN ('device.registered', 'wallet.saved', 'pass.printed', 'scan.checked_in', 'scan.redeemed', 'scan.checked_out', 'scan.adjusted')
    AND NOT EXISTS (SELECT 1 FROM pass_live_spans o WHERE o.live_to IS NULL AND o.pass_id IN (NEW.pass_id, COALESCE((SELECT m.new_pass_id FROM pass_moves m WHERE m.old_pass_id = NEW.pass_id), NEW.pass_id), COALESCE((SELECT m.old_pass_id FROM pass_moves m WHERE m.new_pass_id = NEW.pass_id), NEW.pass_id)));

  UPDATE pass_live_spans
  SET last_used_at = MAX(last_used_at, NEW.at),
    platform = CASE WHEN platform = 'web' AND NEW.kind = 'device.registered' THEN 'apple' ELSE platform END
  WHERE live_to IS NULL AND pass_id IN (NEW.pass_id, COALESCE((SELECT m.new_pass_id FROM pass_moves m WHERE m.old_pass_id = NEW.pass_id), NEW.pass_id), COALESCE((SELECT m.old_pass_id FROM pass_moves m WHERE m.new_pass_id = NEW.pass_id), NEW.pass_id));

  INSERT INTO pass_usage (pass_id, org_id, first_taken_at, last_used_at)
  SELECT NEW.pass_id, NEW.org_id, NEW.at, NEW.at
  WHERE NEW.kind IN ('device.registered', 'wallet.saved', 'pass.printed', 'scan.checked_in', 'scan.redeemed', 'scan.checked_out', 'scan.adjusted') OR EXISTS (SELECT 1 FROM pass_live_spans s WHERE s.pass_id = NEW.pass_id)
  ON CONFLICT (pass_id) DO UPDATE SET last_used_at = MAX(last_used_at, excluded.last_used_at);
END;

-- The last Apple device unregistering ends an Apple span. Google and Samsung give no such signal.
CREATE TRIGGER pass_live_spans_unregistered AFTER INSERT ON pass_events
WHEN NEW.mode = 'live' AND NEW.kind = 'device.unregistered'
  AND NOT EXISTS (SELECT 1 FROM registrations r WHERE r.pass_id = NEW.pass_id)
BEGIN
  UPDATE pass_live_spans SET live_to = MAX(live_from, NEW.at), end_reason = 'unregistered'
  WHERE live_to IS NULL AND platform = 'apple' AND pass_id = NEW.pass_id;
END;

-- A new version's expirationDate moves the end of the open span (and clears it when the date is removed).
CREATE TRIGGER pass_live_spans_expiry AFTER INSERT ON pass_versions
WHEN json_valid(NEW.pass_json)
BEGIN
  UPDATE pass_live_spans SET expires_at = (CASE WHEN json_valid(NEW.pass_json) THEN CAST(strftime('%s', json_extract(NEW.pass_json, '$.expirationDate')) AS INTEGER) * 1000 END)
  WHERE pass_id = NEW.pass_id AND live_to IS NULL;
END;

CREATE TRIGGER pass_live_spans_void AFTER UPDATE OF status, removed_at, deleted_at ON passes
WHEN NEW.status = 'voided' AND OLD.status IS NOT 'voided'
BEGIN
  -- Carried to the replacement of a move, not ended.
  UPDATE pass_live_spans SET pass_id = (SELECT m.new_pass_id FROM pass_moves m JOIN passes n ON n.id = m.new_pass_id WHERE m.old_pass_id = NEW.id AND m.state IN ('registered', 'voided') AND n.status = 'active' AND n.deleted_at IS NULL AND n.removed_at IS NULL)
  WHERE pass_id = NEW.id AND live_to IS NULL AND (SELECT m.new_pass_id FROM pass_moves m JOIN passes n ON n.id = m.new_pass_id WHERE m.old_pass_id = NEW.id AND m.state IN ('registered', 'voided') AND n.status = 'active' AND n.deleted_at IS NULL AND n.removed_at IS NULL) IS NOT NULL
    AND NOT EXISTS (SELECT 1 FROM pass_live_spans o WHERE o.live_to IS NULL AND o.pass_id = (SELECT m.new_pass_id FROM pass_moves m JOIN passes n ON n.id = m.new_pass_id WHERE m.old_pass_id = NEW.id AND m.state IN ('registered', 'voided') AND n.status = 'active' AND n.deleted_at IS NULL AND n.removed_at IS NULL));
  UPDATE pass_live_spans SET live_to = MAX(live_from, NEW.modified_at), end_reason = 'void'
  WHERE pass_id = NEW.id AND live_to IS NULL;
END;

CREATE TRIGGER pass_live_spans_removed AFTER UPDATE OF status, removed_at, deleted_at ON passes
WHEN NEW.removed_at IS NOT NULL AND OLD.removed_at IS NULL
BEGIN
  -- Carried to the replacement of a move, not ended.
  UPDATE pass_live_spans SET pass_id = (SELECT m.new_pass_id FROM pass_moves m JOIN passes n ON n.id = m.new_pass_id WHERE m.old_pass_id = NEW.id AND m.state IN ('registered', 'voided') AND n.status = 'active' AND n.deleted_at IS NULL AND n.removed_at IS NULL)
  WHERE pass_id = NEW.id AND live_to IS NULL AND (SELECT m.new_pass_id FROM pass_moves m JOIN passes n ON n.id = m.new_pass_id WHERE m.old_pass_id = NEW.id AND m.state IN ('registered', 'voided') AND n.status = 'active' AND n.deleted_at IS NULL AND n.removed_at IS NULL) IS NOT NULL
    AND NOT EXISTS (SELECT 1 FROM pass_live_spans o WHERE o.live_to IS NULL AND o.pass_id = (SELECT m.new_pass_id FROM pass_moves m JOIN passes n ON n.id = m.new_pass_id WHERE m.old_pass_id = NEW.id AND m.state IN ('registered', 'voided') AND n.status = 'active' AND n.deleted_at IS NULL AND n.removed_at IS NULL));
  UPDATE pass_live_spans SET live_to = MAX(live_from, NEW.removed_at), end_reason = 'removal'
  WHERE pass_id = NEW.id AND live_to IS NULL;
END;

CREATE TRIGGER pass_live_spans_deleted AFTER UPDATE OF status, removed_at, deleted_at ON passes
WHEN NEW.deleted_at IS NOT NULL AND OLD.deleted_at IS NULL
BEGIN
  -- Carried to the replacement of a move, not ended.
  UPDATE pass_live_spans SET pass_id = (SELECT m.new_pass_id FROM pass_moves m JOIN passes n ON n.id = m.new_pass_id WHERE m.old_pass_id = NEW.id AND m.state IN ('registered', 'voided') AND n.status = 'active' AND n.deleted_at IS NULL AND n.removed_at IS NULL)
  WHERE pass_id = NEW.id AND live_to IS NULL AND (SELECT m.new_pass_id FROM pass_moves m JOIN passes n ON n.id = m.new_pass_id WHERE m.old_pass_id = NEW.id AND m.state IN ('registered', 'voided') AND n.status = 'active' AND n.deleted_at IS NULL AND n.removed_at IS NULL) IS NOT NULL
    AND NOT EXISTS (SELECT 1 FROM pass_live_spans o WHERE o.live_to IS NULL AND o.pass_id = (SELECT m.new_pass_id FROM pass_moves m JOIN passes n ON n.id = m.new_pass_id WHERE m.old_pass_id = NEW.id AND m.state IN ('registered', 'voided') AND n.status = 'active' AND n.deleted_at IS NULL AND n.removed_at IS NULL));
  UPDATE pass_live_spans SET live_to = MAX(live_from, NEW.deleted_at), end_reason = 'deletion'
  WHERE pass_id = NEW.id AND live_to IS NULL;
END;

-- A hard delete has no timestamp: the span ends at its last use.
CREATE TRIGGER pass_live_spans_hard_delete AFTER DELETE ON passes
BEGIN
  UPDATE pass_live_spans SET live_to = last_used_at, end_reason = 'deletion'
  WHERE pass_id = OLD.id AND live_to IS NULL;
END;

-- Undoing a removal or a void gives the pass its latest span back. The pass still sits in the wallet, so it
-- keeps counting until the usual expiry or idle end.
CREATE TRIGGER pass_live_spans_restored AFTER UPDATE OF removed_at ON passes
WHEN OLD.removed_at IS NOT NULL AND NEW.removed_at IS NULL AND NEW.deleted_at IS NULL AND NEW.status != 'voided'
BEGIN
  UPDATE pass_live_spans SET live_to = NULL, end_reason = NULL
  WHERE id = (SELECT l.id FROM pass_live_spans l WHERE l.pass_id = NEW.id ORDER BY l.live_from DESC, l.rowid DESC LIMIT 1)
    AND end_reason = 'removal'
    AND NOT EXISTS (SELECT 1 FROM pass_live_spans o WHERE o.pass_id = NEW.id AND o.live_to IS NULL);
END;

CREATE TRIGGER pass_live_spans_unvoided AFTER UPDATE OF status ON passes
WHEN OLD.status = 'voided' AND NEW.status != 'voided' AND NEW.removed_at IS NULL AND NEW.deleted_at IS NULL
BEGIN
  UPDATE pass_live_spans SET live_to = NULL, end_reason = NULL
  WHERE id = (SELECT l.id FROM pass_live_spans l WHERE l.pass_id = NEW.id ORDER BY l.live_from DESC, l.rowid DESC LIMIT 1)
    AND end_reason = 'void'
    AND NOT EXISTS (SELECT 1 FROM pass_live_spans o WHERE o.pass_id = NEW.id AND o.live_to IS NULL);
END;
