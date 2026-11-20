-- A desk mark-out or an auto exit at an event place no longer drops the pass from the event's retained totals. The exit
-- moves the presence past the check-in's proof, so the retained gate comes from the exit's own signed
-- proof. Proofs written before this carry no snapshots and retain nothing, as before. The check-in (or
-- undo) the exit followed must still have a valid proof of its own; an undo row only counts with snapshots.
-- Known undercount: a gate shared across events (empty or day scope) that another event's check-in moved on
-- no longer names this event's check-in, so the pass is not kept through its exit.
DROP TRIGGER scan_retained_gates_insert_guard;
CREATE TRIGGER scan_retained_gates_insert_guard BEFORE INSERT ON scan_retained_gates
WHEN EXISTS (SELECT 1 FROM scan_retained_gates WHERE scan_id=NEW.scan_id)
  OR (NOT EXISTS (
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
              AND (presence.scope IS json_extract(proof.presence_snapshot,'$.scope')
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
              AND presence.prev_scan_id IS json_extract(proof.presence_snapshot,'$.prevScanId'))))
        OR (proof.presence_snapshot IS NULL
          AND NEW.state=json_extract(proof.gate_snapshot,'$.state')
          AND NOT EXISTS (SELECT 1 FROM scan_presence presence WHERE presence.pass_id=p.id
            AND presence.scope='event:' || s.event_id)
          AND EXISTS (SELECT 1 FROM scan_gates g
            WHERE g.pass_id=p.id AND g.org_id=s.org_id AND g.mode=s.mode AND g.template_id=s.template_id
              AND g.action_id IS s.action_id AND g.scope='event:' || s.event_id
              AND (g.scope IS json_extract(proof.gate_snapshot,'$.scope')
              AND g.kind IS json_extract(proof.gate_snapshot,'$.kind')
              AND g.state IS json_extract(proof.gate_snapshot,'$.state')
              AND g.count IS json_extract(proof.gate_snapshot,'$.count')
              AND g.first_at IS json_extract(proof.gate_snapshot,'$.firstAt')
              AND g.last_at IS json_extract(proof.gate_snapshot,'$.lastAt')
              AND g.last_scan_id IS json_extract(proof.gate_snapshot,'$.lastScanId')
              AND g.prev_state IS json_extract(proof.gate_snapshot,'$.prevState')
              AND g.prev_last_at IS json_extract(proof.gate_snapshot,'$.prevLastAt')
              AND g.prev_scan_id IS json_extract(proof.gate_snapshot,'$.prevScanId'))))
      )
  ) AND NOT EXISTS (
    SELECT 1 FROM scans s
    JOIN passes p ON p.id=s.pass_id AND p.org_id=s.org_id AND p.mode=s.mode AND p.test_data_quarantined=0
    JOIN scan_retention_proofs proof ON proof.scan_id=s.id AND proof.org_id=s.org_id AND proof.mode=s.mode
      AND proof.excluded=0 AND proof.invalidated=0 AND proof.occupancy_invalidated=0
    JOIN scan_presence presence ON presence.pass_id=p.id AND presence.org_id=s.org_id
      AND presence.scope='event:' || s.event_id AND presence.last_scan_id=s.id
    JOIN scans c ON c.id=json_extract(proof.gate_snapshot,'$.lastScanId') AND c.pass_id=p.id
      AND c.org_id=s.org_id AND c.mode=s.mode AND c.event_id=s.event_id AND c.state='done' AND c.outcome='ok'
      AND c.action_kind IN ('check_in','undo')
    JOIN scan_retention_proofs cp ON cp.scan_id=c.id AND cp.org_id=c.org_id AND cp.mode=c.mode
      AND cp.pass_ref=proof.pass_ref AND cp.excluded=0 AND cp.invalidated=0 AND cp.occupancy_invalidated=0
      AND (c.action_kind='check_in' OR cp.gate_snapshot IS NOT NULL)
    JOIN scan_gates g ON g.pass_id=p.id AND g.org_id=s.org_id AND g.mode=s.mode AND g.template_id=s.template_id
      AND g.action_id=c.action_id AND g.last_scan_id=c.id
    JOIN scan_retention_delete_intents intent ON intent.org_id=s.org_id AND intent.mode=s.mode
      AND intent.pass_ref=proof.pass_ref
    JOIN scans anchor ON anchor.id=intent.scan_id AND anchor.pass_id=p.id
    WHERE s.id=NEW.scan_id AND s.org_id=NEW.org_id AND s.mode=NEW.mode AND s.event_id=NEW.event_id
      AND proof.pass_ref=NEW.pass_ref AND NEW.state='out' AND NEW.presence_state='out'
      AND s.state='done' AND s.outcome='ok' AND s.out_cause IN ('desk','stay','clear','zone') AND s.direction='out'
      AND s.action_kind IS NOT 'undo' AND s.undoes IS NULL AND s.event_id IS NOT NULL
      AND proof.gate_snapshot IS NOT NULL AND proof.presence_snapshot IS NOT NULL
      AND json_extract(proof.gate_snapshot,'$.kind')='check_in'
      AND json_extract(proof.presence_snapshot,'$.state')='out'
      AND (g.scope='event:' || s.event_id OR g.scope='' OR (length(g.scope)=14
        AND g.scope GLOB 'day:[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'))
      AND NOT EXISTS (SELECT 1 FROM scan_quarantine_exclusions q WHERE q.scan_id IN (s.id,c.id))
      AND (g.scope IS json_extract(proof.gate_snapshot,'$.scope')
      AND g.kind IS json_extract(proof.gate_snapshot,'$.kind')
      AND g.state IS json_extract(proof.gate_snapshot,'$.state')
      AND g.count IS json_extract(proof.gate_snapshot,'$.count')
      AND g.first_at IS json_extract(proof.gate_snapshot,'$.firstAt')
      AND g.last_at IS json_extract(proof.gate_snapshot,'$.lastAt')
      AND g.last_scan_id IS json_extract(proof.gate_snapshot,'$.lastScanId')
      AND g.prev_state IS json_extract(proof.gate_snapshot,'$.prevState')
      AND g.prev_last_at IS json_extract(proof.gate_snapshot,'$.prevLastAt')
      AND g.prev_scan_id IS json_extract(proof.gate_snapshot,'$.prevScanId')
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
      AND presence.prev_scan_id IS json_extract(proof.presence_snapshot,'$.prevScanId'))
  ))
BEGIN
  SELECT RAISE(ABORT, 'invalid retained gate source');
END;
-- The pass leaves its event total when marked out: the exit moved the presence past the check-in's proof,
-- so the exit's own proof (the gate it left and the presence it closed) is what is retained.
CREATE TRIGGER scan_retention_capture_exit_gates BEFORE DELETE ON passes
WHEN OLD.test_data_quarantined = 0
BEGIN
  INSERT INTO scan_retained_gates (scan_id, org_id, mode, event_id, pass_ref, state, presence_state)
  SELECT s.id, s.org_id, s.mode, s.event_id, intent.pass_ref, 'out', 'out'
  FROM scans s
  JOIN passes p ON p.id=s.pass_id AND p.org_id=s.org_id AND p.mode=s.mode AND p.test_data_quarantined=0
  JOIN scan_retention_proofs proof ON proof.scan_id=s.id AND proof.org_id=s.org_id AND proof.mode=s.mode
    AND proof.excluded=0 AND proof.invalidated=0 AND proof.occupancy_invalidated=0
  JOIN scan_presence presence ON presence.pass_id=p.id AND presence.org_id=s.org_id
    AND presence.scope='event:' || s.event_id AND presence.last_scan_id=s.id
  JOIN scans c ON c.id=json_extract(proof.gate_snapshot,'$.lastScanId') AND c.pass_id=p.id
    AND c.org_id=s.org_id AND c.mode=s.mode AND c.event_id=s.event_id AND c.state='done' AND c.outcome='ok'
    AND c.action_kind IN ('check_in','undo')
  JOIN scan_retention_proofs cp ON cp.scan_id=c.id AND cp.org_id=c.org_id AND cp.mode=c.mode
    AND cp.pass_ref=proof.pass_ref AND cp.excluded=0 AND cp.invalidated=0 AND cp.occupancy_invalidated=0
    AND (c.action_kind='check_in' OR cp.gate_snapshot IS NOT NULL)
  JOIN scan_gates g ON g.pass_id=p.id AND g.org_id=s.org_id AND g.mode=s.mode AND g.template_id=s.template_id
    AND g.action_id=c.action_id AND g.last_scan_id=c.id
  JOIN scan_retention_delete_intents intent ON intent.org_id=s.org_id AND intent.mode=s.mode
    AND intent.pass_ref=proof.pass_ref
  JOIN scans anchor ON anchor.id=intent.scan_id AND anchor.pass_id=p.id
  WHERE p.id=OLD.id AND s.pass_id=OLD.id AND s.state='done' AND s.outcome='ok' AND s.out_cause IN ('desk','stay','clear','zone') AND s.direction='out'
  AND s.action_kind IS NOT 'undo' AND s.undoes IS NULL AND s.event_id IS NOT NULL
  AND proof.gate_snapshot IS NOT NULL AND proof.presence_snapshot IS NOT NULL
  AND json_extract(proof.gate_snapshot,'$.kind')='check_in'
  AND json_extract(proof.presence_snapshot,'$.state')='out'
  AND (g.scope='event:' || s.event_id OR g.scope='' OR (length(g.scope)=14
    AND g.scope GLOB 'day:[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'))
  AND NOT EXISTS (SELECT 1 FROM scan_quarantine_exclusions q WHERE q.scan_id IN (s.id,c.id))
  AND (g.scope IS json_extract(proof.gate_snapshot,'$.scope')
  AND g.kind IS json_extract(proof.gate_snapshot,'$.kind')
  AND g.state IS json_extract(proof.gate_snapshot,'$.state')
  AND g.count IS json_extract(proof.gate_snapshot,'$.count')
  AND g.first_at IS json_extract(proof.gate_snapshot,'$.firstAt')
  AND g.last_at IS json_extract(proof.gate_snapshot,'$.lastAt')
  AND g.last_scan_id IS json_extract(proof.gate_snapshot,'$.lastScanId')
  AND g.prev_state IS json_extract(proof.gate_snapshot,'$.prevState')
  AND g.prev_last_at IS json_extract(proof.gate_snapshot,'$.prevLastAt')
  AND g.prev_scan_id IS json_extract(proof.gate_snapshot,'$.prevScanId')
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
  AND presence.prev_scan_id IS json_extract(proof.presence_snapshot,'$.prevScanId'))
    AND NOT EXISTS (SELECT 1 FROM scan_retained_gates retained WHERE retained.scan_id=s.id);
END;
