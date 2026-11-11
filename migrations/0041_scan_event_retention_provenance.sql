-- An opaque, authenticated event-time index. Pass identities and event payloads stay in
-- their original tables; neither is copied here. The scan owns the retained evidence.
CREATE INDEX pass_events_scan_retention_link ON pass_events ((CASE WHEN json_valid(data) THEN json_extract(data,'$.scanId') END));
CREATE INDEX scan_gates_last_scan ON scan_gates (last_scan_id);
CREATE INDEX scan_gates_prev_scan ON scan_gates (prev_scan_id) WHERE prev_scan_id IS NOT NULL;
CREATE INDEX scan_presence_last_scan ON scan_presence (last_scan_id);
CREATE INDEX scan_presence_prev_scan ON scan_presence (prev_scan_id) WHERE prev_scan_id IS NOT NULL;
CREATE INDEX scans_override_target ON scans (override_of) WHERE override_of IS NOT NULL;
CREATE INDEX scans_undone_target ON scans (undone_by) WHERE undone_by IS NOT NULL;

CREATE TABLE scan_retention_proofs (
  scan_id TEXT PRIMARY KEY REFERENCES scans (id) ON DELETE CASCADE,
  org_id TEXT NOT NULL,
  mode TEXT NOT NULL CHECK (mode IN ('live', 'test')),
  ledger_event_id TEXT NOT NULL UNIQUE,
  pass_ref TEXT NOT NULL CHECK (length(pass_ref) = 64 AND pass_ref NOT GLOB '*[^0-9a-f]*'),
  event_digest TEXT NOT NULL CHECK (length(event_digest) = 64 AND event_digest NOT GLOB '*[^0-9a-f]*'),
  scan_digest TEXT NOT NULL CHECK (length(scan_digest) = 64 AND scan_digest NOT GLOB '*[^0-9a-f]*'),
  gate_snapshot TEXT CHECK (gate_snapshot IS NULL OR json_valid(gate_snapshot)),
  presence_snapshot TEXT CHECK (presence_snapshot IS NULL OR json_valid(presence_snapshot)),
  mac TEXT NOT NULL CHECK (length(mac) = 64 AND mac NOT GLOB '*[^0-9a-f]*'),
  excluded INTEGER NOT NULL DEFAULT 0 CHECK (excluded IN (0, 1)),
  invalidated INTEGER NOT NULL DEFAULT 0 CHECK (invalidated IN (0, 1)),
  occupancy_invalidated INTEGER NOT NULL DEFAULT 0 CHECK (occupancy_invalidated IN (0, 1))
);
CREATE INDEX scan_retention_scope ON scan_retention_proofs (org_id, mode, excluded, invalidated, scan_id);

-- SQLite allocates this sequence inside the same write transaction that closes
-- the scan. It orders committed transitions, not client clocks or UUIDs.
CREATE TABLE scan_retention_event_transitions (
  sequence INTEGER PRIMARY KEY AUTOINCREMENT,
  scan_id TEXT NOT NULL UNIQUE REFERENCES scans (id) ON DELETE CASCADE,
  org_id TEXT NOT NULL,
  mode TEXT NOT NULL CHECK (mode IN ('live', 'test')),
  event_id TEXT NOT NULL,
  pass_ref TEXT CHECK (pass_ref IS NULL OR (length(pass_ref)=64 AND pass_ref NOT GLOB '*[^0-9a-f]*'))
);
CREATE INDEX scan_retention_transition_scope
  ON scan_retention_event_transitions (org_id, mode, event_id, pass_ref, sequence);
CREATE TRIGGER scan_retention_transition_insert_guard BEFORE INSERT ON scan_retention_event_transitions
WHEN NEW.pass_ref IS NOT NULL
  OR EXISTS (SELECT 1 FROM scan_retention_event_transitions WHERE scan_id=NEW.scan_id OR sequence=NEW.sequence)
  OR NOT EXISTS (SELECT 1 FROM scans s WHERE s.id=NEW.scan_id AND s.org_id=NEW.org_id AND s.mode=NEW.mode
    AND s.event_id=NEW.event_id AND s.pass_id IS NOT NULL AND s.state='done' AND s.outcome='ok'
    AND s.action_kind IN ('check_in','undo'))
BEGIN
  SELECT RAISE(ABORT, 'invalid scan transition');
END;
CREATE TRIGGER scan_retention_transition_immutable BEFORE UPDATE ON scan_retention_event_transitions
WHEN NEW.sequence IS NOT OLD.sequence OR NEW.scan_id IS NOT OLD.scan_id OR NEW.org_id IS NOT OLD.org_id
  OR NEW.mode IS NOT OLD.mode OR NEW.event_id IS NOT OLD.event_id
  OR (NEW.pass_ref IS NOT OLD.pass_ref AND (OLD.pass_ref IS NOT NULL OR NEW.pass_ref IS NULL OR NOT EXISTS
    (SELECT 1 FROM scan_retention_proofs proof WHERE proof.scan_id=OLD.scan_id
      AND proof.org_id=OLD.org_id AND proof.mode=OLD.mode AND proof.pass_ref=NEW.pass_ref)))
BEGIN
  SELECT RAISE(ABORT, 'immutable scan transition');
END;
CREATE TRIGGER scan_retention_transition_no_direct_delete BEFORE DELETE ON scan_retention_event_transitions
WHEN EXISTS (SELECT 1 FROM scans WHERE id=OLD.scan_id)
BEGIN
  SELECT RAISE(ABORT, 'scan transition belongs to scan');
END;
CREATE TRIGGER scan_retention_transition_finalize AFTER UPDATE ON scans
WHEN NEW.pass_id IS NOT NULL AND NEW.event_id IS NOT NULL AND NEW.state='done' AND NEW.outcome='ok'
  AND NEW.action_kind IN ('check_in','undo')
  AND NOT EXISTS (SELECT 1 FROM scan_retention_event_transitions WHERE scan_id=NEW.id)
BEGIN
  INSERT INTO scan_retention_event_transitions (scan_id,org_id,mode,event_id)
    VALUES (NEW.id,NEW.org_id,NEW.mode,NEW.event_id);
END;
CREATE TRIGGER scan_retention_transition_insert AFTER INSERT ON scans
WHEN NEW.pass_id IS NOT NULL AND NEW.event_id IS NOT NULL AND NEW.state='done' AND NEW.outcome='ok'
  AND NEW.action_kind IN ('check_in','undo')
BEGIN
  INSERT INTO scan_retention_event_transitions (scan_id,org_id,mode,event_id)
    VALUES (NEW.id,NEW.org_id,NEW.mode,NEW.event_id);
END;
CREATE TRIGGER scan_retention_transition_bind AFTER INSERT ON scan_retention_proofs
BEGIN
  UPDATE scan_retention_event_transitions SET pass_ref=NEW.pass_ref
    WHERE scan_id=NEW.scan_id AND org_id=NEW.org_id AND mode=NEW.mode AND pass_ref IS NULL;
END;

-- A later removed or unsigned transition must never make an older occupancy
-- authoritative again. Its independently signed generic receipt remains intact.
CREATE TRIGGER scan_retention_unsigned_transition_changed AFTER UPDATE ON scans
WHEN OLD.state='done' AND OLD.pass_id IS NOT NULL
  AND (OLD.pass_id IS NOT NEW.pass_id OR OLD.org_id IS NOT NEW.org_id OR OLD.mode IS NOT NEW.mode
    OR OLD.event_id IS NOT NEW.event_id OR OLD.state IS NOT NEW.state
    OR OLD.outcome IS NOT NEW.outcome OR OLD.action_kind IS NOT NEW.action_kind)
  AND NOT (NEW.pass_id IS NULL AND NOT EXISTS (SELECT 1 FROM passes WHERE id=OLD.pass_id))
BEGIN
  UPDATE scan_retention_proofs SET occupancy_invalidated=1 WHERE occupancy_invalidated=0 AND scan_id IN (
    SELECT prior.scan_id FROM scan_retention_event_transitions later
    JOIN scan_retention_event_transitions prior ON prior.org_id=later.org_id AND prior.mode=later.mode
      AND prior.event_id=later.event_id AND prior.sequence<later.sequence
    JOIN scans prior_scan ON prior_scan.id=prior.scan_id AND prior_scan.pass_id=OLD.pass_id
    WHERE later.scan_id=OLD.id AND later.pass_ref IS NULL
  );
END;
CREATE TRIGGER scan_retention_transition_removed BEFORE DELETE ON scans
BEGIN
  UPDATE scan_retention_proofs SET occupancy_invalidated=1 WHERE occupancy_invalidated=0 AND scan_id IN (
    SELECT prior.scan_id FROM scan_retention_event_transitions later
    JOIN scan_retention_event_transitions prior ON prior.org_id=later.org_id AND prior.mode=later.mode
      AND prior.event_id=later.event_id AND prior.sequence<later.sequence
    JOIN scans prior_scan ON prior_scan.id=prior.scan_id
    WHERE later.scan_id=OLD.id AND (
      (later.pass_ref IS NOT NULL AND prior.pass_ref=later.pass_ref)
      OR (later.pass_ref IS NULL AND OLD.pass_id IS NOT NULL AND prior_scan.pass_id=OLD.pass_id))
  );
END;


-- Short-lived transaction intent keyed through a scan, never through a raw pass id.
CREATE TABLE scan_retention_delete_intents (
  scan_id TEXT PRIMARY KEY REFERENCES scans (id) ON DELETE CASCADE,
  org_id TEXT NOT NULL,
  mode TEXT NOT NULL CHECK (mode IN ('live', 'test')),
  pass_ref TEXT NOT NULL CHECK (length(pass_ref) = 64 AND pass_ref NOT GLOB '*[^0-9a-f]*')
);
CREATE INDEX scan_retention_delete_intent_ref ON scan_retention_delete_intents (org_id, mode, pass_ref);

-- Only event totals need the final gate and effective presence state after deletion.
-- Their identity is an opaque, tenant-scoped HMAC, not the deleted pass identifier.
CREATE TABLE scan_retained_gates (
  scan_id TEXT PRIMARY KEY REFERENCES scans (id) ON DELETE CASCADE,
  org_id TEXT NOT NULL,
  mode TEXT NOT NULL CHECK (mode IN ('live', 'test')),
  event_id TEXT NOT NULL,
  pass_ref TEXT NOT NULL CHECK (length(pass_ref) = 64 AND pass_ref NOT GLOB '*[^0-9a-f]*'),
  state TEXT NOT NULL CHECK (state IN ('in', 'out')),
  presence_state TEXT NOT NULL CHECK (presence_state IN ('in', 'out'))
);
CREATE INDEX scan_retained_gates_event ON scan_retained_gates (org_id, mode, event_id, pass_ref);
CREATE TRIGGER scan_retained_gates_insert_guard BEFORE INSERT ON scan_retained_gates
WHEN EXISTS (SELECT 1 FROM scan_retained_gates WHERE scan_id=NEW.scan_id)
  OR NOT EXISTS (
    SELECT 1 FROM scans s
    JOIN passes p ON p.id=s.pass_id AND p.org_id=s.org_id AND p.mode=s.mode AND p.test_data_quarantined=0
    JOIN scan_retention_proofs proof ON proof.scan_id=s.id AND proof.org_id=s.org_id AND proof.mode=s.mode
      AND proof.pass_ref=NEW.pass_ref AND proof.excluded=0 AND proof.invalidated=0 AND proof.occupancy_invalidated=0
    JOIN scan_retention_delete_intents intent ON intent.org_id=s.org_id AND intent.mode=s.mode
      AND intent.pass_ref=proof.pass_ref
    JOIN scans anchor ON anchor.id=intent.scan_id AND anchor.pass_id=p.id
    JOIN scan_retention_event_transitions committed ON committed.scan_id=s.id AND committed.org_id=s.org_id
      AND committed.mode=s.mode AND committed.event_id=s.event_id AND committed.pass_ref=proof.pass_ref
    WHERE s.id=NEW.scan_id AND s.org_id=NEW.org_id AND s.mode=NEW.mode AND s.event_id=NEW.event_id
      AND s.state='done' AND s.outcome='ok' AND s.action_kind IN ('check_in','undo')
      AND NEW.state=NEW.presence_state AND proof.gate_snapshot IS NOT NULL
      AND json_extract(proof.gate_snapshot,'$.kind')='check_in'
      AND json_extract(proof.gate_snapshot,'$.lastScanId')=s.id
      AND NOT EXISTS (SELECT 1 FROM scan_retention_event_transitions later
        LEFT JOIN scans later_scan ON later_scan.id=later.scan_id
        WHERE later.org_id=committed.org_id AND later.mode=committed.mode
          AND later.event_id=committed.event_id AND later.sequence>committed.sequence
          AND (later.pass_ref=proof.pass_ref OR (later.pass_ref IS NULL AND later_scan.pass_id=p.id))
          AND later_scan.action_kind IS NOT 'undo' AND later_scan.undone_by IS NULL)
      AND (
        (proof.presence_snapshot IS NOT NULL
          AND NEW.state=json_extract(proof.presence_snapshot,'$.state')
          AND EXISTS (SELECT 1 FROM scan_presence presence
            WHERE presence.pass_id=p.id AND presence.org_id=s.org_id AND presence.scope='event:' || s.event_id
              AND presence.scope IS json_extract(proof.presence_snapshot,'$.scope')
              AND presence.state IS json_extract(proof.presence_snapshot,'$.state')
              AND presence.tracking IS json_extract(proof.presence_snapshot,'$.tracking')
              AND presence.entered_at IS json_extract(proof.presence_snapshot,'$.enteredAt')
              AND presence.first_at IS json_extract(proof.presence_snapshot,'$.firstAt')
              AND presence.last_entry_at IS json_extract(proof.presence_snapshot,'$.lastEntryAt')
              AND presence.last_scan_id IS json_extract(proof.presence_snapshot,'$.lastScanId')
              AND presence.prev_state IS json_extract(proof.presence_snapshot,'$.prevState')
              AND presence.prev_tracking IS json_extract(proof.presence_snapshot,'$.prevTracking')
              AND presence.prev_entered_at IS json_extract(proof.presence_snapshot,'$.prevEnteredAt')
              AND presence.prev_first_at IS json_extract(proof.presence_snapshot,'$.prevFirstAt')
              AND presence.prev_last_entry_at IS json_extract(proof.presence_snapshot,'$.prevLastEntryAt')
              AND presence.prev_scan_id IS json_extract(proof.presence_snapshot,'$.prevScanId')))
        OR (proof.presence_snapshot IS NULL
          AND NEW.state=json_extract(proof.gate_snapshot,'$.state')
          AND NOT EXISTS (SELECT 1 FROM scan_presence presence WHERE presence.pass_id=p.id
            AND presence.scope='event:' || s.event_id)
          AND EXISTS (SELECT 1 FROM scan_gates g
            WHERE g.pass_id=p.id AND g.org_id=s.org_id AND g.mode=s.mode AND g.template_id=s.template_id
              AND g.action_id IS s.action_id AND g.scope='event:' || s.event_id
              AND g.scope IS json_extract(proof.gate_snapshot,'$.scope')
              AND g.kind IS json_extract(proof.gate_snapshot,'$.kind')
              AND g.state IS json_extract(proof.gate_snapshot,'$.state')
              AND g.count IS json_extract(proof.gate_snapshot,'$.count')
              AND g.first_at IS json_extract(proof.gate_snapshot,'$.firstAt')
              AND g.last_at IS json_extract(proof.gate_snapshot,'$.lastAt')
              AND g.last_scan_id IS json_extract(proof.gate_snapshot,'$.lastScanId')
              AND g.prev_state IS json_extract(proof.gate_snapshot,'$.prevState')
              AND g.prev_last_at IS json_extract(proof.gate_snapshot,'$.prevLastAt')
              AND g.prev_scan_id IS json_extract(proof.gate_snapshot,'$.prevScanId')))
      )
  )
BEGIN
  SELECT RAISE(ABORT, 'invalid retained gate source');
END;
CREATE TRIGGER scan_retained_gates_immutable BEFORE UPDATE ON scan_retained_gates
BEGIN
  SELECT RAISE(ABORT, 'immutable retained gate');
END;
CREATE TRIGGER scan_retained_gates_no_direct_delete BEFORE DELETE ON scan_retained_gates
WHEN EXISTS (SELECT 1 FROM scans WHERE id = OLD.scan_id)
BEGIN
  SELECT RAISE(ABORT, 'retained gate belongs to scan');
END;

-- Legacy rows can be quarantined too, even though they have no signed proof.
CREATE TABLE scan_quarantine_exclusions (
  scan_id TEXT PRIMARY KEY REFERENCES scans (id) ON DELETE CASCADE
);
INSERT INTO scan_quarantine_exclusions (scan_id)
SELECT s.id FROM scans s JOIN passes p ON p.id = s.pass_id WHERE p.test_data_quarantined = 1;

CREATE TRIGGER scan_quarantine_no_direct_delete BEFORE DELETE ON scan_quarantine_exclusions
WHEN EXISTS (SELECT 1 FROM scans WHERE id = OLD.scan_id)
BEGIN
  SELECT RAISE(ABORT, 'scan quarantine exclusion belongs to scan');
END;

-- A proof can only be installed against its one currently present, nonquarantined
-- source event. The worker also verifies its MAC and the complete event envelope.
CREATE TRIGGER scan_retention_insert_guard BEFORE INSERT ON scan_retention_proofs
BEGIN
  SELECT CASE WHEN EXISTS (SELECT 1 FROM scan_retention_proofs WHERE scan_id = NEW.scan_id)
    OR EXISTS (SELECT 1 FROM scan_retention_proofs WHERE ledger_event_id = NEW.ledger_event_id)
    OR NEW.excluded <> 0 OR NEW.invalidated <> 0 OR NEW.occupancy_invalidated <> 0
    OR EXISTS (SELECT 1 FROM scan_quarantine_exclusions WHERE scan_id = NEW.scan_id)
    OR NOT EXISTS (
      SELECT 1 FROM scans s
      JOIN passes p ON p.id = s.pass_id AND p.org_id = s.org_id AND p.mode = s.mode
      JOIN pass_events e ON e.id = NEW.ledger_event_id AND e.pass_id = p.id
        AND e.org_id = s.org_id AND e.mode = s.mode
      WHERE s.id = NEW.scan_id AND s.org_id = NEW.org_id AND s.mode = NEW.mode
        AND s.state = 'done' AND p.test_data_quarantined = 0
        AND (CASE WHEN json_valid(e.data) THEN json_extract(e.data,'$.scanId') END) = s.id
        AND (SELECT count(*) FROM pass_events x WHERE x.pass_id=e.pass_id AND x.org_id=e.org_id
          AND x.mode=e.mode AND (CASE WHEN json_valid(x.data) THEN json_extract(x.data,'$.scanId') END) = s.id) = 1
    ) THEN RAISE(ABORT, 'invalid scan retention source') END;
END;

-- All exclusion/invalidation latches are irreversible and have distinct semantics.
CREATE TRIGGER scan_retention_immutable BEFORE UPDATE ON scan_retention_proofs
WHEN NEW.scan_id IS NOT OLD.scan_id OR NEW.org_id IS NOT OLD.org_id OR NEW.mode IS NOT OLD.mode
  OR NEW.ledger_event_id IS NOT OLD.ledger_event_id OR NEW.pass_ref IS NOT OLD.pass_ref
  OR NEW.event_digest IS NOT OLD.event_digest OR NEW.scan_digest IS NOT OLD.scan_digest
  OR NEW.gate_snapshot IS NOT OLD.gate_snapshot OR NEW.presence_snapshot IS NOT OLD.presence_snapshot
  OR NEW.mac IS NOT OLD.mac OR NEW.excluded < OLD.excluded OR NEW.invalidated < OLD.invalidated
  OR NEW.occupancy_invalidated < OLD.occupancy_invalidated
BEGIN
  SELECT RAISE(ABORT, 'immutable scan retention proof');
END;

-- Explicit removal/replacement could otherwise reset the quarantine latch. The
-- scan's own cascade is allowed, since the parent row is already gone then.
CREATE TRIGGER scan_retention_no_direct_delete BEFORE DELETE ON scan_retention_proofs
WHEN EXISTS (SELECT 1 FROM scans WHERE id = OLD.scan_id)
BEGIN
  SELECT RAISE(ABORT, 'scan retention proof belongs to scan');
END;

-- Scan rows remain mutable for normal lifecycle and legacy maintenance, but any
-- change to signed scope/facts permanently invalidates their retained index.
-- The FK's pass_id SET NULL is safe only when the parent really has been deleted.
CREATE TRIGGER scan_retention_scan_changed AFTER UPDATE ON scans
WHEN OLD.org_id IS NOT NEW.org_id OR OLD.mode IS NOT NEW.mode
  OR OLD.template_id IS NOT NEW.template_id OR OLD.scanner_id IS NOT NEW.scanner_id
  OR OLD.event_id IS NOT NEW.event_id OR OLD.actor_type IS NOT NEW.actor_type
  OR OLD.actor_id IS NOT NEW.actor_id OR OLD.actor_key IS NOT NEW.actor_key
  OR OLD.staff_id IS NOT NEW.staff_id OR OLD.approved_by IS NOT NEW.approved_by
  OR OLD.idempotency_key IS NOT NEW.idempotency_key OR OLD.request_hash IS NOT NEW.request_hash
  OR OLD.method IS NOT NEW.method OR OLD.state IS NOT NEW.state OR OLD.outcome IS NOT NEW.outcome
  OR OLD.reason IS NOT NEW.reason OR OLD.action_id IS NOT NEW.action_id
  OR OLD.action_kind IS NOT NEW.action_kind OR OLD.direction IS NOT NEW.direction
  OR OLD.override_of IS NOT NEW.override_of OR OLD.pass_version IS NOT NEW.pass_version
  OR OLD.undoes IS NOT NEW.undoes OR OLD.at IS NOT NEW.at
  OR OLD.presence_scope IS NOT NEW.presence_scope
  OR (OLD.pass_id IS NOT NEW.pass_id AND NOT (
    OLD.pass_id IS NOT NULL AND NEW.pass_id IS NULL
    AND NOT EXISTS (SELECT 1 FROM passes WHERE id = OLD.pass_id)
  ))
BEGIN
  UPDATE scan_retention_proofs SET invalidated = 1 WHERE scan_id = OLD.id AND invalidated = 0;
END;

-- A later rewritten or duplicate event must not leave a trusted index behind.
CREATE TRIGGER scan_retention_event_changed AFTER UPDATE ON pass_events
BEGIN
  UPDATE scan_retention_proofs SET invalidated = 1 WHERE invalidated = 0 AND (
    ledger_event_id = OLD.id OR EXISTS (SELECT 1 FROM scans s WHERE s.id=scan_retention_proofs.scan_id AND (
      (s.pass_id=OLD.pass_id AND s.org_id=OLD.org_id AND s.mode=OLD.mode AND s.id=(CASE WHEN json_valid(OLD.data) THEN json_extract(OLD.data,'$.scanId') END))
      OR (s.pass_id=NEW.pass_id AND s.org_id=NEW.org_id AND s.mode=NEW.mode AND s.id=(CASE WHEN json_valid(NEW.data) THEN json_extract(NEW.data,'$.scanId') END))
    ))
  );
END;
CREATE TRIGGER scan_retention_event_duplicate AFTER INSERT ON pass_events
BEGIN
  UPDATE scan_retention_proofs SET invalidated = 1
    WHERE invalidated = 0 AND scan_id = (CASE WHEN json_valid(NEW.data) THEN json_extract(NEW.data,'$.scanId') END)
      AND EXISTS (SELECT 1 FROM scans s WHERE s.id=scan_retention_proofs.scan_id
        AND s.pass_id=NEW.pass_id AND s.org_id=NEW.org_id AND s.mode=NEW.mode);
END;

-- A later cross-tenant or cross-mode pass mutation cannot turn old evidence
-- into a same-scope orphan after the pass itself has disappeared.
CREATE TRIGGER scan_retention_pass_scope_changed AFTER UPDATE OF org_id, mode ON passes
WHEN OLD.org_id IS NOT NEW.org_id OR OLD.mode IS NOT NEW.mode
BEGIN
  UPDATE scan_retention_proofs SET invalidated = 1 WHERE invalidated = 0 AND scan_id IN
    (SELECT id FROM scans WHERE pass_id = NEW.id);
END;

CREATE TRIGGER scan_retention_quarantine AFTER UPDATE OF test_data_quarantined ON passes
WHEN NEW.test_data_quarantined = 1
BEGIN
  INSERT OR IGNORE INTO scan_quarantine_exclusions (scan_id) SELECT id FROM scans WHERE pass_id = NEW.id;
  UPDATE scan_retention_proofs SET excluded = 1 WHERE excluded = 0 AND scan_id IN
    (SELECT id FROM scans WHERE pass_id = NEW.id);
END;

-- This runs only for an actual DELETE, including direct SQL deletes, before FK
-- actions erase scans.pass_id. A failed conditional deletion cannot fire it.
CREATE TRIGGER scan_retention_pass_delete BEFORE DELETE ON passes
WHEN OLD.test_data_quarantined = 1
BEGIN
  INSERT OR IGNORE INTO scan_quarantine_exclusions (scan_id) SELECT id FROM scans WHERE pass_id = OLD.id;
  UPDATE scan_retention_proofs SET excluded = 1 WHERE excluded = 0 AND scan_id IN
    (SELECT id FROM scans WHERE pass_id = OLD.id);
END;

-- A winning deletion can preserve only immutable, authenticated event-time
-- evidence. Event presence is independent of the action gate: another event may
-- subsequently reuse an empty/day gate without erasing this event's admission.
-- An undo row has no retention proof, and the check-in it undid no longer holds occupancy: neither
-- blocks capturing the pass's remaining proofs (the restored gate matches the earlier snapshot).
CREATE TRIGGER scan_retention_capture_gates BEFORE DELETE ON passes
WHEN OLD.test_data_quarantined = 0
BEGIN
  INSERT INTO scan_retained_gates (scan_id, org_id, mode, event_id, pass_ref, state, presence_state)
  SELECT s.id, s.org_id, s.mode, s.event_id, intent.pass_ref,
    COALESCE(presence.state, g.state), COALESCE(presence.state, g.state)
  FROM scan_retention_delete_intents intent
  JOIN scans anchor ON anchor.id = intent.scan_id AND anchor.pass_id = OLD.id
    AND anchor.org_id = OLD.org_id AND anchor.mode = OLD.mode
  JOIN scan_gates g ON g.pass_id = OLD.id AND g.org_id = OLD.org_id AND g.mode = OLD.mode
  JOIN scans s ON s.id = g.last_scan_id AND s.pass_id = OLD.id AND s.org_id = g.org_id
    AND s.mode = g.mode AND s.template_id = g.template_id AND s.action_id = g.action_id
  JOIN scan_retention_proofs proof ON proof.scan_id = s.id AND proof.org_id = s.org_id
    AND proof.mode = s.mode AND proof.pass_ref = intent.pass_ref
    AND proof.excluded = 0 AND proof.invalidated = 0 AND proof.occupancy_invalidated = 0
  JOIN scan_retention_event_transitions committed ON committed.scan_id=s.id
    AND committed.org_id=s.org_id AND committed.mode=s.mode AND committed.event_id=s.event_id
    AND committed.pass_ref=proof.pass_ref
  LEFT JOIN scan_presence presence ON presence.pass_id = g.pass_id AND presence.scope = 'event:' || s.event_id
  WHERE intent.org_id = OLD.org_id AND intent.mode = OLD.mode
    AND NOT EXISTS (SELECT 1 FROM scan_quarantine_exclusions q WHERE q.scan_id = s.id)
    AND s.event_id IS NOT NULL AND (
      g.scope = 'event:' || s.event_id OR (proof.presence_snapshot IS NOT NULL AND (
        g.scope = '' OR (length(g.scope) = 14
          AND g.scope GLOB 'day:[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'))))
    AND g.kind = 'check_in' AND g.state IN ('in', 'out') AND proof.gate_snapshot IS NOT NULL
    AND NOT EXISTS (SELECT 1 FROM scan_retention_event_transitions later
      LEFT JOIN scans later_scan ON later_scan.id=later.scan_id
      WHERE later.org_id=committed.org_id AND later.mode=committed.mode
        AND later.event_id=committed.event_id AND later.sequence>committed.sequence
        AND (later.pass_ref=proof.pass_ref OR (later.pass_ref IS NULL AND later_scan.pass_id=OLD.id))
        AND later_scan.action_kind IS NOT 'undo' AND later_scan.undone_by IS NULL)
    AND g.scope IS json_extract(proof.gate_snapshot, '$.scope')
    AND g.kind IS json_extract(proof.gate_snapshot, '$.kind')
    AND g.state IS json_extract(proof.gate_snapshot, '$.state')
    AND g.count IS json_extract(proof.gate_snapshot, '$.count')
    AND g.first_at IS json_extract(proof.gate_snapshot, '$.firstAt')
    AND g.last_at IS json_extract(proof.gate_snapshot, '$.lastAt')
    AND g.last_scan_id IS json_extract(proof.gate_snapshot, '$.lastScanId')
    AND g.prev_state IS json_extract(proof.gate_snapshot, '$.prevState')
    AND g.prev_last_at IS json_extract(proof.gate_snapshot, '$.prevLastAt')
    AND g.prev_scan_id IS json_extract(proof.gate_snapshot, '$.prevScanId')
    AND ((proof.presence_snapshot IS NULL AND presence.pass_id IS NULL)
      OR (proof.presence_snapshot IS NOT NULL AND presence.pass_id IS NOT NULL
        AND presence.org_id = g.org_id
        AND presence.scope IS json_extract(proof.presence_snapshot, '$.scope')
        AND presence.state IS json_extract(proof.presence_snapshot, '$.state')
        AND presence.tracking IS json_extract(proof.presence_snapshot, '$.tracking')
        AND presence.entered_at IS json_extract(proof.presence_snapshot, '$.enteredAt')
        AND presence.first_at IS json_extract(proof.presence_snapshot, '$.firstAt')
        AND presence.last_entry_at IS json_extract(proof.presence_snapshot, '$.lastEntryAt')
        AND presence.last_scan_id IS json_extract(proof.presence_snapshot, '$.lastScanId')
        AND presence.prev_state IS json_extract(proof.presence_snapshot, '$.prevState')
        AND presence.prev_tracking IS json_extract(proof.presence_snapshot, '$.prevTracking')
        AND presence.prev_entered_at IS json_extract(proof.presence_snapshot, '$.prevEnteredAt')
        AND presence.prev_first_at IS json_extract(proof.presence_snapshot, '$.prevFirstAt')
        AND presence.prev_last_entry_at IS json_extract(proof.presence_snapshot, '$.prevLastEntryAt')
        AND presence.prev_scan_id IS json_extract(proof.presence_snapshot, '$.prevScanId')));

  -- If a shared gate has since moved to another event, match the current
  -- event-scoped presence to its own latest signed admission/undo instead.
  INSERT INTO scan_retained_gates (scan_id, org_id, mode, event_id, pass_ref, state, presence_state)
  SELECT s.id, s.org_id, s.mode, s.event_id, intent.pass_ref, presence.state, presence.state
  FROM scan_retention_delete_intents intent
  JOIN scans anchor ON anchor.id=intent.scan_id AND anchor.pass_id=OLD.id
    AND anchor.org_id=OLD.org_id AND anchor.mode=OLD.mode
  JOIN scan_presence presence ON presence.pass_id=OLD.id AND presence.org_id=OLD.org_id
  JOIN scans s ON s.pass_id=OLD.id AND s.org_id=OLD.org_id AND s.mode=OLD.mode
    AND s.event_id IS NOT NULL AND presence.scope='event:' || s.event_id
    AND s.state='done' AND s.outcome='ok' AND s.action_kind IN ('check_in','undo')
  JOIN scan_retention_proofs proof ON proof.scan_id=s.id AND proof.org_id=s.org_id
    AND proof.mode=s.mode AND proof.pass_ref=intent.pass_ref
    AND proof.excluded=0 AND proof.invalidated=0 AND proof.occupancy_invalidated=0
  JOIN scan_retention_event_transitions committed ON committed.scan_id=s.id
    AND committed.org_id=s.org_id AND committed.mode=s.mode AND committed.event_id=s.event_id
    AND committed.pass_ref=proof.pass_ref
  WHERE intent.org_id=OLD.org_id AND intent.mode=OLD.mode
    AND NOT EXISTS (SELECT 1 FROM scan_quarantine_exclusions q WHERE q.scan_id=s.id)
    AND NOT EXISTS (SELECT 1 FROM scan_retained_gates retained WHERE retained.scan_id=s.id)
    AND NOT EXISTS (SELECT 1 FROM scan_retention_event_transitions later
      LEFT JOIN scans later_scan ON later_scan.id=later.scan_id
      WHERE later.org_id=committed.org_id AND later.mode=committed.mode
        AND later.event_id=committed.event_id AND later.sequence>committed.sequence
        AND (later.pass_ref=proof.pass_ref OR (later.pass_ref IS NULL AND later_scan.pass_id=OLD.id))
        AND later_scan.action_kind IS NOT 'undo' AND later_scan.undone_by IS NULL)
    AND proof.gate_snapshot IS NOT NULL AND proof.presence_snapshot IS NOT NULL
    AND json_extract(proof.gate_snapshot,'$.kind')='check_in'
    AND json_extract(proof.gate_snapshot,'$.lastScanId')=s.id
    AND presence.scope IS json_extract(proof.presence_snapshot,'$.scope')
    AND presence.state IS json_extract(proof.presence_snapshot,'$.state')
    AND presence.tracking IS json_extract(proof.presence_snapshot,'$.tracking')
    AND presence.entered_at IS json_extract(proof.presence_snapshot,'$.enteredAt')
    AND presence.first_at IS json_extract(proof.presence_snapshot,'$.firstAt')
    AND presence.last_entry_at IS json_extract(proof.presence_snapshot,'$.lastEntryAt')
    AND presence.last_scan_id IS json_extract(proof.presence_snapshot,'$.lastScanId')
    AND presence.prev_state IS json_extract(proof.presence_snapshot,'$.prevState')
    AND presence.prev_tracking IS json_extract(proof.presence_snapshot,'$.prevTracking')
    AND presence.prev_entered_at IS json_extract(proof.presence_snapshot,'$.prevEnteredAt')
    AND presence.prev_first_at IS json_extract(proof.presence_snapshot,'$.prevFirstAt')
    AND presence.prev_last_entry_at IS json_extract(proof.presence_snapshot,'$.prevLastEntryAt')
    AND presence.prev_scan_id IS json_extract(proof.presence_snapshot,'$.prevScanId');
END;

-- A genuine no-pass decision has a separate actor/event-scope proof and never
-- acquires an opaque pass reference or a foreign key to the event configuration.
CREATE TABLE scan_passless_proofs (
  scan_id TEXT PRIMARY KEY REFERENCES scans(id) ON DELETE CASCADE,
  org_id TEXT NOT NULL,
  mode TEXT NOT NULL CHECK(mode IN ('live','test')),
  scope_json TEXT NOT NULL CHECK(json_valid(scope_json)),
  mac TEXT NOT NULL CHECK(length(mac)=64 AND mac NOT GLOB '*[^0-9a-f]*'),
  invalidated INTEGER NOT NULL DEFAULT 0 CHECK(invalidated IN (0,1))
);
CREATE INDEX scan_passless_scope ON scan_passless_proofs(org_id,mode,invalidated,scan_id);
CREATE TRIGGER scan_passless_insert_guard BEFORE INSERT ON scan_passless_proofs BEGIN
  SELECT CASE WHEN EXISTS(SELECT 1 FROM scan_passless_proofs WHERE scan_id=NEW.scan_id) OR NEW.invalidated<>0 OR NOT EXISTS (
    SELECT 1 FROM scans s WHERE s.id=NEW.scan_id AND s.org_id=NEW.org_id AND s.mode=NEW.mode
      AND s.state='done' AND s.outcome='refused' AND s.reason IN ('not_found','ambiguous')
      AND s.pass_id IS NULL AND s.template_id IS NULL AND s.pass_version IS NULL
      AND s.action_id IS NULL AND s.action_kind IS NULL AND s.direction IS NULL
      AND s.amount IS NULL AND s.before_value IS NULL AND s.after_value IS NULL
      AND s.override_of IS NULL AND s.approved_by IS NULL AND s.group_id IS NULL
      AND s.offline=0 AND s.notified=0 AND s.undoes IS NULL AND s.undone_by IS NULL
      AND s.undone_at IS NULL AND s.presence_scope IS NULL
      AND ((s.event_id IS NULL AND json_type(NEW.scope_json,'$.eventRevision')='null')
        OR (s.event_id IS NOT NULL AND json_type(NEW.scope_json,'$.eventRevision')='integer'
          AND EXISTS(SELECT 1 FROM scan_events e WHERE e.id=s.event_id AND e.org_id=s.org_id
            AND e.mode=s.mode AND e.archived_at IS NULL
            AND e.updated_at=json_extract(NEW.scope_json,'$.eventRevision'))))
      AND ((s.scanner_id IS NULL AND json_type(NEW.scope_json,'$.scannerRevision')='null')
        OR (s.scanner_id IS NOT NULL AND json_type(NEW.scope_json,'$.scannerRevision')='integer'
          AND EXISTS(SELECT 1 FROM scanners sc WHERE sc.id=s.scanner_id AND sc.org_id=s.org_id
            AND sc.mode=s.mode AND sc.updated_at=json_extract(NEW.scope_json,'$.scannerRevision'))))
      AND ((s.staff_id IS NULL AND json_type(NEW.scope_json,'$.staffRevision')='null')
        OR (s.staff_id IS NOT NULL AND json_type(NEW.scope_json,'$.staffRevision')='integer'
          AND EXISTS(SELECT 1 FROM scan_staff st WHERE st.id=s.staff_id AND st.org_id=s.org_id
            AND st.updated_at=json_extract(NEW.scope_json,'$.staffRevision'))))
      AND NOT EXISTS(SELECT 1 FROM scan_retention_proofs r WHERE r.scan_id=s.id)
      AND NOT EXISTS(SELECT 1 FROM scan_retention_delete_intents i WHERE i.scan_id=s.id)
      AND NOT EXISTS(SELECT 1 FROM scan_retained_gates g WHERE g.scan_id=s.id)
      AND NOT EXISTS(SELECT 1 FROM scan_quarantine_exclusions q WHERE q.scan_id=s.id)
      AND NOT EXISTS(SELECT 1 FROM pass_events l WHERE (CASE WHEN json_valid(l.data) THEN json_extract(l.data,'$.scanId') END)=s.id)
      AND NOT EXISTS(SELECT 1 FROM scan_gates g WHERE g.last_scan_id=s.id OR g.prev_scan_id=s.id)
      AND NOT EXISTS(SELECT 1 FROM scan_presence p WHERE p.last_scan_id=s.id OR p.prev_scan_id=s.id)
      AND NOT EXISTS(SELECT 1 FROM scans x WHERE x.override_of=s.id OR x.undoes=s.id OR x.undone_by=s.id)
      AND json_extract(NEW.scope_json,'$.v')=1 AND json_type(NEW.scope_json,'$.noPassSelected')='true'
      AND json_extract(NEW.scope_json,'$.scanId')=s.id AND json_extract(NEW.scope_json,'$.orgId')=s.org_id
      AND json_extract(NEW.scope_json,'$.mode')=s.mode AND json_extract(NEW.scope_json,'$.eventId') IS s.event_id
      AND json_extract(NEW.scope_json,'$.scannerId') IS s.scanner_id AND json_extract(NEW.scope_json,'$.staffId') IS s.staff_id
      AND json_extract(NEW.scope_json,'$.actorType')=s.actor_type AND json_extract(NEW.scope_json,'$.actorId')=s.actor_id
      AND json_extract(NEW.scope_json,'$.actorKey')=s.actor_key AND json_extract(NEW.scope_json,'$.method')=s.method
      AND json_extract(NEW.scope_json,'$.at')=s.at AND json_extract(NEW.scope_json,'$.outcome')=s.outcome
      AND json_extract(NEW.scope_json,'$.reason')=s.reason
      AND json_type(NEW.scope_json,'$.credentialKeysetCommitment')='text'
      AND length(json_extract(NEW.scope_json,'$.credentialKeysetCommitment'))=64
      AND json_extract(NEW.scope_json,'$.credentialKeysetCommitment') NOT GLOB '*[^0-9a-f]*'
      AND ((s.actor_type='scanner' AND json_type(NEW.scope_json,'$.tenantRef')='null')
        OR (s.actor_type='user' AND json_type(NEW.scope_json,'$.tenantRef')='text'
          AND length(json_extract(NEW.scope_json,'$.tenantRef'))=64
          AND json_extract(NEW.scope_json,'$.tenantRef') NOT GLOB '*[^0-9a-f]*'))
      AND ((json_type(NEW.scope_json,'$.sessionId')='null'
          AND json_type(NEW.scope_json,'$.sessionRevision')='null')
        OR (json_type(NEW.scope_json,'$.sessionId')='text'
          AND json_type(NEW.scope_json,'$.sessionRevision')='integer'
          AND EXISTS(SELECT 1 FROM scanning_devices d JOIN scanning_sessions w
            ON w.id=d.session_id AND w.org_id=d.org_id AND w.mode=d.mode
            WHERE d.scanner_id=s.scanner_id AND d.session_id=json_extract(NEW.scope_json,'$.sessionId')
              AND d.org_id=s.org_id AND d.mode=s.mode AND w.status='active'
              AND w.updated_at=json_extract(NEW.scope_json,'$.sessionRevision'))))
  ) THEN RAISE(ABORT,'invalid passless proof source') END;
END;
CREATE TRIGGER scan_passless_immutable BEFORE UPDATE ON scan_passless_proofs WHEN NEW.scan_id IS NOT OLD.scan_id OR NEW.org_id IS NOT OLD.org_id OR NEW.mode IS NOT OLD.mode OR NEW.scope_json IS NOT OLD.scope_json OR NEW.mac IS NOT OLD.mac OR NEW.invalidated<OLD.invalidated BEGIN SELECT RAISE(ABORT,'immutable passless proof'); END;
CREATE TRIGGER scan_passless_no_direct_delete BEFORE DELETE ON scan_passless_proofs WHEN EXISTS(SELECT 1 FROM scans WHERE id=OLD.scan_id) BEGIN SELECT RAISE(ABORT,'passless proof belongs to scan'); END;
CREATE TRIGGER scan_passless_scan_changed AFTER UPDATE ON scans BEGIN UPDATE scan_passless_proofs SET invalidated=1 WHERE scan_id=OLD.id AND invalidated=0; UPDATE scan_passless_proofs SET invalidated=1 WHERE invalidated=0 AND scan_id IN (NEW.override_of,NEW.undoes,NEW.undone_by); END;
CREATE TRIGGER scan_passless_scan_reference AFTER INSERT ON scans BEGIN UPDATE scan_passless_proofs SET invalidated=1 WHERE invalidated=0 AND scan_id IN (NEW.override_of,NEW.undoes,NEW.undone_by); END;
CREATE TRIGGER scan_passless_event_insert AFTER INSERT ON pass_events BEGIN UPDATE scan_passless_proofs SET invalidated=1 WHERE invalidated=0 AND scan_id=(CASE WHEN json_valid(NEW.data) THEN json_extract(NEW.data,'$.scanId') END); END;
CREATE TRIGGER scan_passless_event_update AFTER UPDATE ON pass_events BEGIN UPDATE scan_passless_proofs SET invalidated=1 WHERE invalidated=0 AND scan_id IN ((CASE WHEN json_valid(OLD.data) THEN json_extract(OLD.data,'$.scanId') END),(CASE WHEN json_valid(NEW.data) THEN json_extract(NEW.data,'$.scanId') END)); END;
CREATE TRIGGER scan_passless_gate_insert AFTER INSERT ON scan_gates BEGIN UPDATE scan_passless_proofs SET invalidated=1 WHERE invalidated=0 AND scan_id IN (NEW.last_scan_id,NEW.prev_scan_id); END;
CREATE TRIGGER scan_passless_gate_update AFTER UPDATE ON scan_gates BEGIN UPDATE scan_passless_proofs SET invalidated=1 WHERE invalidated=0 AND scan_id IN (OLD.last_scan_id,OLD.prev_scan_id,NEW.last_scan_id,NEW.prev_scan_id); END;
CREATE TRIGGER scan_passless_presence_insert AFTER INSERT ON scan_presence BEGIN UPDATE scan_passless_proofs SET invalidated=1 WHERE invalidated=0 AND scan_id IN (NEW.last_scan_id,NEW.prev_scan_id); END;
CREATE TRIGGER scan_passless_presence_update AFTER UPDATE ON scan_presence BEGIN UPDATE scan_passless_proofs SET invalidated=1 WHERE invalidated=0 AND scan_id IN (OLD.last_scan_id,OLD.prev_scan_id,NEW.last_scan_id,NEW.prev_scan_id); END;
CREATE TRIGGER scan_passless_intent_insert AFTER INSERT ON scan_retention_delete_intents BEGIN UPDATE scan_passless_proofs SET invalidated=1 WHERE invalidated=0 AND scan_id=NEW.scan_id; END;
CREATE TRIGGER scan_passless_retained_gate_insert AFTER INSERT ON scan_retained_gates BEGIN UPDATE scan_passless_proofs SET invalidated=1 WHERE invalidated=0 AND scan_id=NEW.scan_id; END;
