-- Reservations retain the hashed capture intent, never the capability tokens or URLs.
CREATE TABLE sandbox_forwards (
  id TEXT PRIMARY KEY,
  capture_id TEXT NOT NULL REFERENCES captured_emails (id) ON UPDATE CASCADE ON DELETE CASCADE,
  org_id TEXT REFERENCES orgs (id) ON UPDATE CASCADE ON DELETE SET NULL,
  bundle_id TEXT REFERENCES bundles (id) ON UPDATE CASCADE ON DELETE SET NULL,
  actor_id TEXT REFERENCES users (id) ON UPDATE CASCADE ON DELETE SET NULL,
  email TEXT REFERENCES user_emails (email) ON UPDATE CASCADE ON DELETE SET NULL,
  intent TEXT NOT NULL,
  pass_ids TEXT NOT NULL CHECK (
    json_valid(pass_ids) AND json_type(pass_ids) = 'array' AND json_array_length(pass_ids) > 0
  ),
  state TEXT NOT NULL CHECK (state IN ('sending', 'sent', 'failed', 'unknown', 'expired')),
  created_at INTEGER NOT NULL,
  finished_at INTEGER,
  -- A reservation that outlives its lease (or stays unknown for a day) becomes 'expired', which
  -- releases the data locks below (they test state IN ('sending', 'unknown')). Org suspension and
  -- user disable are kill switches and are never blocked by a reservation.
  lease_until INTEGER,
  CHECK (state != 'sending' OR lease_until IS NOT NULL),
  CHECK (state NOT IN ('sending', 'unknown') OR (
    org_id IS NOT NULL AND actor_id IS NOT NULL AND email IS NOT NULL
  ))
);

-- One live reservation per capture; a repeat send is allowed once it is sent, failed or expired.
CREATE UNIQUE INDEX sandbox_forwards_capture_once ON sandbox_forwards (capture_id)
  WHERE state IN ('sending', 'unknown');
CREATE INDEX sandbox_forwards_capture ON sandbox_forwards (capture_id, state);
CREATE INDEX sandbox_forwards_org ON sandbox_forwards (org_id, state);
CREATE INDEX sandbox_forwards_bundle ON sandbox_forwards (bundle_id, state);
CREATE INDEX sandbox_forwards_actor ON sandbox_forwards (actor_id, email, state);
CREATE INDEX sandbox_forwards_email ON sandbox_forwards (email);

CREATE TABLE sandbox_forward_passes (
  forward_id TEXT NOT NULL REFERENCES sandbox_forwards (id) ON DELETE CASCADE,
  pass_id TEXT NOT NULL REFERENCES passes (id) ON UPDATE CASCADE ON DELETE CASCADE,
  PRIMARY KEY (forward_id, pass_id)
);
CREATE INDEX sandbox_forward_passes_pass ON sandbox_forward_passes (pass_id, forward_id);

-- REPLACE must not erase an existing lock or a successful attempt.
CREATE TRIGGER sandbox_forwards_insert_guard
BEFORE INSERT ON sandbox_forwards
WHEN EXISTS (
  SELECT 1 FROM sandbox_forwards f
  WHERE f.id = NEW.id OR (f.capture_id = NEW.capture_id AND f.state IN ('sending', 'unknown'))
)
BEGIN
  SELECT RAISE(IGNORE);
END;

CREATE TRIGGER sandbox_forwards_add_passes
AFTER INSERT ON sandbox_forwards
BEGIN
  SELECT RAISE(ABORT, 'invalid forwarding reservation')
    WHERE EXISTS (SELECT 1 FROM json_each(NEW.pass_ids) WHERE type != 'text')
      OR (SELECT count(*) FROM json_each(NEW.pass_ids))
        != (SELECT count(DISTINCT value) FROM json_each(NEW.pass_ids));
  INSERT INTO sandbox_forward_passes (forward_id, pass_id)
    SELECT NEW.id, value FROM json_each(NEW.pass_ids);
END;

-- Active and uncertain attempts cannot lose or change any part of their lock.
CREATE TRIGGER sandbox_forwards_update_guard
BEFORE UPDATE ON sandbox_forwards
WHEN OLD.id IS NOT NEW.id
  OR (OLD.capture_id IS NOT NEW.capture_id AND (
    OLD.state IN ('sending', 'unknown')
    OR EXISTS (SELECT 1 FROM captured_emails c WHERE c.id = OLD.capture_id)
  ))
  OR (OLD.email IS NOT NEW.email AND (
    OLD.state IN ('sending', 'unknown')
    OR EXISTS (SELECT 1 FROM user_emails e WHERE e.email = OLD.email)
  ))
  OR OLD.intent IS NOT NEW.intent
  OR OLD.pass_ids IS NOT NEW.pass_ids
  OR OLD.created_at IS NOT NEW.created_at
  OR (OLD.state IN ('sending', 'unknown') AND (
    OLD.org_id IS NOT NEW.org_id OR OLD.bundle_id IS NOT NEW.bundle_id
    OR OLD.actor_id IS NOT NEW.actor_id
  ))
  OR OLD.lease_until IS NOT NEW.lease_until
  OR (OLD.state IS NOT NEW.state AND NOT (
    (OLD.state = 'sending' AND NEW.state IN ('sent', 'failed', 'unknown', 'expired'))
    OR (OLD.state = 'unknown' AND NEW.state = 'expired')
  ))
BEGIN
  SELECT RAISE(ABORT, 'forwarding reservation is locked');
END;

CREATE TRIGGER sandbox_forwards_delete_guard
BEFORE DELETE ON sandbox_forwards
WHEN OLD.state IN ('sending', 'unknown')
BEGIN
  SELECT RAISE(ABORT, 'forwarding reservation is locked');
END;

CREATE TRIGGER sandbox_forward_passes_insert_guard
BEFORE INSERT ON sandbox_forward_passes
WHEN NOT EXISTS (
  SELECT 1 FROM sandbox_forwards f, json_each(f.pass_ids) j
  WHERE f.id = NEW.forward_id AND j.type = 'text' AND j.value = NEW.pass_id
)
BEGIN
  SELECT RAISE(ABORT, 'invalid forwarding reservation');
END;

CREATE TRIGGER sandbox_forward_passes_update_guard
BEFORE UPDATE ON sandbox_forward_passes
WHEN (OLD.forward_id IS NOT NEW.forward_id OR OLD.pass_id IS NOT NEW.pass_id)
  AND EXISTS (
    SELECT 1 FROM sandbox_forwards f
    WHERE f.id IN (OLD.forward_id, NEW.forward_id) AND f.state IN ('sending', 'unknown')
  )
BEGIN
  SELECT RAISE(ABORT, 'forwarding reservation is locked');
END;

CREATE TRIGGER sandbox_forward_passes_delete_guard
BEFORE DELETE ON sandbox_forward_passes
WHEN EXISTS (
  SELECT 1 FROM sandbox_forwards f
  WHERE f.id = OLD.forward_id AND f.state IN ('sending', 'unknown')
)
BEGIN
  SELECT RAISE(ABORT, 'forwarding reservation is locked');
END;

CREATE TRIGGER sandbox_forward_pass_update_guard
BEFORE UPDATE OF id, org_id, mode, holder_email, owner_user_id, link_generation,
  status, removed_at, deleted_at, test_data_quarantined ON passes
WHEN (OLD.id IS NOT NEW.id OR OLD.org_id IS NOT NEW.org_id OR OLD.mode IS NOT NEW.mode
  OR OLD.holder_email IS NOT NEW.holder_email OR OLD.owner_user_id IS NOT NEW.owner_user_id
  OR OLD.link_generation IS NOT NEW.link_generation
  OR OLD.status IS NOT NEW.status OR OLD.removed_at IS NOT NEW.removed_at
  OR OLD.deleted_at IS NOT NEW.deleted_at
  OR OLD.test_data_quarantined IS NOT NEW.test_data_quarantined)
  AND EXISTS (
    SELECT 1 FROM sandbox_forward_passes fp JOIN sandbox_forwards f ON f.id = fp.forward_id
    WHERE fp.pass_id = OLD.id AND f.state IN ('sending', 'unknown')
  )
BEGIN
  SELECT RAISE(ABORT, 'forwarding reservation is locked');
END;

CREATE TRIGGER sandbox_forward_pass_delete_guard
BEFORE DELETE ON passes
WHEN EXISTS (
  SELECT 1 FROM sandbox_forward_passes fp JOIN sandbox_forwards f ON f.id = fp.forward_id
  WHERE fp.pass_id = OLD.id AND f.state IN ('sending', 'unknown')
)
BEGIN
  SELECT RAISE(ABORT, 'forwarding reservation is locked');
END;

CREATE TRIGGER sandbox_forward_bundle_update_guard
BEFORE UPDATE OF id, org_id, mode, name, token, holder_email ON bundles
WHEN (OLD.id IS NOT NEW.id OR OLD.org_id IS NOT NEW.org_id OR OLD.mode IS NOT NEW.mode
  OR OLD.name IS NOT NEW.name OR OLD.token IS NOT NEW.token
  OR OLD.holder_email IS NOT NEW.holder_email)
  AND EXISTS (
    SELECT 1 FROM sandbox_forwards f
    WHERE f.bundle_id = OLD.id AND f.state IN ('sending', 'unknown')
  )
BEGIN
  SELECT RAISE(ABORT, 'forwarding reservation is locked');
END;

CREATE TRIGGER sandbox_forward_bundle_delete_guard
BEFORE DELETE ON bundles
WHEN EXISTS (
  SELECT 1 FROM sandbox_forwards f
  WHERE f.bundle_id = OLD.id AND f.state IN ('sending', 'unknown')
)
BEGIN
  SELECT RAISE(ABORT, 'forwarding reservation is locked');
END;

CREATE TRIGGER sandbox_forward_bundle_pass_insert_guard
BEFORE INSERT ON bundle_passes
WHEN EXISTS (
  SELECT 1 FROM sandbox_forwards f
  WHERE f.bundle_id = NEW.bundle_id AND f.state IN ('sending', 'unknown')
) OR EXISTS (
  SELECT 1 FROM sandbox_forward_passes fp JOIN sandbox_forwards f ON f.id = fp.forward_id
  WHERE fp.pass_id = NEW.pass_id AND f.state IN ('sending', 'unknown')
)
BEGIN
  SELECT RAISE(ABORT, 'forwarding reservation is locked');
END;

CREATE TRIGGER sandbox_forward_bundle_pass_update_guard
BEFORE UPDATE ON bundle_passes
WHEN (OLD.bundle_id IS NOT NEW.bundle_id OR OLD.pass_id IS NOT NEW.pass_id
  OR OLD.position IS NOT NEW.position)
  AND (EXISTS (
    SELECT 1 FROM sandbox_forwards f
    WHERE f.bundle_id IN (OLD.bundle_id, NEW.bundle_id) AND f.state IN ('sending', 'unknown')
  ) OR EXISTS (
    SELECT 1 FROM sandbox_forward_passes fp JOIN sandbox_forwards f ON f.id = fp.forward_id
    WHERE fp.pass_id IN (OLD.pass_id, NEW.pass_id) AND f.state IN ('sending', 'unknown')
  ))
BEGIN
  SELECT RAISE(ABORT, 'forwarding reservation is locked');
END;

CREATE TRIGGER sandbox_forward_bundle_pass_delete_guard
BEFORE DELETE ON bundle_passes
WHEN EXISTS (
  SELECT 1 FROM sandbox_forwards f
  WHERE f.bundle_id = OLD.bundle_id AND f.state IN ('sending', 'unknown')
) OR EXISTS (
  SELECT 1 FROM sandbox_forward_passes fp JOIN sandbox_forwards f ON f.id = fp.forward_id
  WHERE fp.pass_id = OLD.pass_id AND f.state IN ('sending', 'unknown')
)
BEGIN
  SELECT RAISE(ABORT, 'forwarding reservation is locked');
END;

CREATE TRIGGER sandbox_forward_capture_update_guard
BEFORE UPDATE ON captured_emails
WHEN (OLD.id IS NOT NEW.id OR OLD.org_id IS NOT NEW.org_id
  OR OLD.pass_id IS NOT NEW.pass_id OR OLD.bundle_id IS NOT NEW.bundle_id
  OR OLD.outbox_id IS NOT NEW.outbox_id OR OLD.recipient IS NOT NEW.recipient
  OR OLD.subject IS NOT NEW.subject OR OLD.html IS NOT NEW.html OR OLD.text IS NOT NEW.text
  OR OLD.attached IS NOT NEW.attached OR OLD.created_at IS NOT NEW.created_at
  OR OLD.intent IS NOT NEW.intent)
  AND EXISTS (
    SELECT 1 FROM sandbox_forwards f
    WHERE f.capture_id = OLD.id AND f.state IN ('sending', 'unknown')
  )
BEGIN
  SELECT RAISE(ABORT, 'forwarding reservation is locked');
END;

CREATE TRIGGER sandbox_forward_capture_delete_guard
BEFORE DELETE ON captured_emails
WHEN EXISTS (
  SELECT 1 FROM sandbox_forwards f
  WHERE f.capture_id = OLD.id AND f.state IN ('sending', 'unknown')
)
BEGIN
  SELECT RAISE(ABORT, 'forwarding reservation is locked');
END;

CREATE TRIGGER sandbox_forward_email_update_guard
BEFORE UPDATE ON user_emails
WHEN (OLD.email IS NOT NEW.email OR OLD.user_id IS NOT NEW.user_id
  OR OLD.verified_via IS NOT NEW.verified_via OR OLD.verified_at IS NOT NEW.verified_at)
  AND EXISTS (
    SELECT 1 FROM sandbox_forwards f
    WHERE f.actor_id = OLD.user_id AND f.email = OLD.email AND f.state IN ('sending', 'unknown')
  )
BEGIN
  SELECT RAISE(ABORT, 'forwarding reservation is locked');
END;

CREATE TRIGGER sandbox_forward_email_delete_guard
BEFORE DELETE ON user_emails
WHEN EXISTS (
  SELECT 1 FROM sandbox_forwards f
  WHERE f.actor_id = OLD.user_id AND f.email = OLD.email AND f.state IN ('sending', 'unknown')
)
BEGIN
  SELECT RAISE(ABORT, 'forwarding reservation is locked');
END;

CREATE TRIGGER sandbox_forward_user_update_guard
BEFORE UPDATE OF id ON users
WHEN OLD.id IS NOT NEW.id
  AND EXISTS (
    SELECT 1 FROM sandbox_forwards f
    WHERE f.actor_id = OLD.id AND f.state IN ('sending', 'unknown')
  )
BEGIN
  SELECT RAISE(ABORT, 'forwarding reservation is locked');
END;

CREATE TRIGGER sandbox_forward_user_delete_guard
BEFORE DELETE ON users
WHEN EXISTS (
  SELECT 1 FROM sandbox_forwards f
  WHERE f.actor_id = OLD.id AND f.state IN ('sending', 'unknown')
)
BEGIN
  SELECT RAISE(ABORT, 'forwarding reservation is locked');
END;

CREATE TRIGGER sandbox_forward_org_update_guard
BEFORE UPDATE OF id ON orgs
WHEN OLD.id IS NOT NEW.id
  AND EXISTS (
    SELECT 1 FROM sandbox_forwards f
    WHERE f.org_id = OLD.id AND f.state IN ('sending', 'unknown')
  )
BEGIN
  SELECT RAISE(ABORT, 'forwarding reservation is locked');
END;

CREATE TRIGGER sandbox_forward_org_delete_guard
BEFORE DELETE ON orgs
WHEN EXISTS (
  SELECT 1 FROM sandbox_forwards f
  WHERE f.org_id = OLD.id AND f.state IN ('sending', 'unknown')
)
BEGIN
  SELECT RAISE(ABORT, 'forwarding reservation is locked');
END;
