-- Programming blank NTAG 424 DNA tags at a scanner (design: nfc-program). A program row is one tag's trip from
-- blank to keyed. The intended keys (K0..K4, 80 bytes) are sealed into the four standard envelope columns and
-- stored in the commit that releases the script, so a torn write never loses the keys of a tag that holds them.
-- The session (session keys, TI, counters, the script) lives in `sess_*`, encrypted, and exists only while the
-- row is `started` or `scripted`: every other state clears it. Only the intended envelope is a place of cron
-- keys.rewrap (modules/keys/rewrap-tables.ts); a session lasts a minute and is not rewrapped.
-- Deterministic: no time and no random in this file.

-- A keyset takes programmed tags only when its owner turned it on, and only a per-tag keyset can be.
ALTER TABLE nfc_tag_keysets ADD COLUMN programmable INTEGER NOT NULL DEFAULT 0 CHECK (programmable IN (0, 1));
CREATE TRIGGER nfc_tag_keysets_programmable_insert BEFORE INSERT ON nfc_tag_keysets
BEGIN SELECT RAISE(ABORT, 'keyset_programmable') WHERE NEW.programmable = 1 AND NEW.per_tag = 0; END;
CREATE TRIGGER nfc_tag_keysets_programmable_update BEFORE UPDATE ON nfc_tag_keysets
BEGIN SELECT RAISE(ABORT, 'keyset_programmable') WHERE NEW.programmable = 1 AND NEW.per_tag = 0; END;

CREATE TABLE nfc_tag_programs (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES orgs (id) ON DELETE CASCADE,
  mode TEXT NOT NULL CHECK (mode IN ('live', 'test')),
  -- The keyset and key version the tag is keyed for: K1 is that version's meta key. Frozen with the row.
  keyset_id TEXT NOT NULL REFERENCES nfc_tag_keysets (id),
  key_version INTEGER NOT NULL CHECK (key_version BETWEEN 1 AND 255),
  -- The tag's identity as `tagRef` makes it (HMAC of the UID): never the UID.
  tag_ref TEXT NOT NULL CHECK (length(tag_ref) = 64),
  hint TEXT NOT NULL CHECK (length(hint) = 4 AND hint NOT GLOB '*[^0-9A-F]*' AND hint = upper(substr(tag_ref, 1, 4))),
  actor_type TEXT NOT NULL CHECK (actor_type IN ('scanner', 'api_key')),
  actor_key TEXT NOT NULL,
  scanner_id TEXT,
  staff_id TEXT,
  api_key_id TEXT,
  purpose TEXT NOT NULL CHECK (purpose IN ('blank', 'rekey', 'reset')),
  state TEXT NOT NULL CHECK (state IN ('started', 'scripted', 'programmed', 'interrupted', 'failed', 'reset', 'abandoned')),
  -- What the next call must be: auth (the answer to auth part 2), reauth, probe, result. Nothing once the row rests.
  step TEXT NOT NULL CHECK (step IN ('auth', 'reauth', 'probe', 'result', 'done')),
  -- Auth part 2 messages released for this tag, across holds: capped, so a bug cannot count key 0 toward its lockout.
  attempts INTEGER NOT NULL CHECK (attempts BETWEEN 0 AND 20),
  error_code TEXT,
  -- Why a programmed tag was not assigned in the same commit (a bind refusal code); the first answer, kept for a repeat.
  refusal TEXT,
  -- The actor key that first released the intended keys: only it, or a Manager, resumes the row.
  released_by TEXT,
  -- Intended keys K0 || K1 || K2 || K3 || K4 (80 bytes, 96 sealed). Set once, with `scripted`; gone once `programmed` or `reset`.
  kek_version INTEGER,
  iv BLOB,
  wrapped_dek BLOB,
  ciphertext BLOB,
  -- The session, only while `started` or `scripted`.
  sess_kek_version INTEGER,
  sess_iv BLOB,
  sess_wrapped_dek BLOB,
  sess_ciphertext BLOB,
  tag_id TEXT,
  binding_id TEXT,
  enrollment_id TEXT,
  idem_key TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  CHECK ((kek_version IS NULL AND iv IS NULL AND wrapped_dek IS NULL AND ciphertext IS NULL)
    OR (kek_version >= 1 AND length(iv) = 12 AND length(wrapped_dek) = 60 AND length(ciphertext) = 96)),
  CHECK ((sess_kek_version IS NULL AND sess_iv IS NULL AND sess_wrapped_dek IS NULL AND sess_ciphertext IS NULL)
    OR (sess_kek_version >= 1 AND length(sess_iv) = 12 AND length(sess_wrapped_dek) = 60
      AND length(sess_ciphertext) BETWEEN 17 AND 8192)),
  CHECK ((state IN ('started', 'scripted')) = (sess_kek_version IS NOT NULL)),
  CHECK (state <> 'scripted' OR kek_version IS NOT NULL),
  CHECK (kek_version IS NULL OR released_by IS NOT NULL),
  CHECK (state NOT IN ('programmed', 'reset') OR kek_version IS NULL),
  CHECK ((state IN ('programmed', 'reset')) = (step = 'done')),
  CHECK (state <> 'started' OR step IN ('auth', 'reauth')),
  CHECK (state <> 'scripted' OR step IN ('probe', 'result')),
  CHECK (state NOT IN ('interrupted', 'failed', 'abandoned') OR step = 'auth'),
  CHECK (state <> 'programmed' OR tag_id IS NOT NULL),
  CHECK (expires_at > created_at)
);
-- One unresolved row per tag: a tag that may hold intended keys has exactly one row to find, whoever asks. A failed
-- row that never held keys frees the tag.
CREATE UNIQUE INDEX nfc_tag_programs_open ON nfc_tag_programs (org_id, mode, tag_ref)
  WHERE state IN ('started', 'scripted', 'interrupted', 'abandoned') OR (state = 'failed' AND kek_version IS NOT NULL);
CREATE UNIQUE INDEX nfc_tag_programs_idem ON nfc_tag_programs (actor_key, idem_key) WHERE idem_key IS NOT NULL;
CREATE INDEX nfc_tag_programs_org ON nfc_tag_programs (org_id, mode, created_at);
CREATE INDEX nfc_tag_programs_keyset ON nfc_tag_programs (keyset_id);
CREATE INDEX nfc_tag_programs_ref ON nfc_tag_programs (org_id, mode, tag_ref, created_at);
CREATE INDEX nfc_tag_programs_expiry ON nfc_tag_programs (expires_at) WHERE state IN ('started', 'scripted');
CREATE INDEX nfc_tag_programs_ended ON nfc_tag_programs (updated_at) WHERE state IN ('programmed', 'reset', 'failed', 'abandoned');

-- Insert: a started row on a live, programmable, per-tag keyset of the row's tenant, on a key version still active,
-- for a tag the org does not have yet. It holds no intended keys until the script is released.
CREATE TRIGGER nfc_tag_programs_insert BEFORE INSERT ON nfc_tag_programs
BEGIN
  SELECT RAISE(ABORT, 'program_state') WHERE NEW.state <> 'started' OR NEW.step <> 'auth' OR NEW.attempts <> 1
    OR NEW.kek_version IS NOT NULL OR NEW.tag_id IS NOT NULL OR NEW.error_code IS NOT NULL;
  SELECT RAISE(ABORT, 'program_keyset') WHERE NOT EXISTS (
    SELECT 1 FROM nfc_tag_keysets k WHERE k.id = NEW.keyset_id AND k.org_id = NEW.org_id AND k.mode = NEW.mode
      AND k.per_tag = 1 AND k.programmable = 1 AND k.disabled_at IS NULL)
    OR NOT EXISTS (SELECT 1 FROM nfc_tag_keys y WHERE y.keyset_id = NEW.keyset_id AND y.version = NEW.key_version
      AND y.state = 'active');
  SELECT RAISE(ABORT, 'program_known') WHERE EXISTS (
    SELECT 1 FROM nfc_tags t WHERE t.org_id = NEW.org_id AND t.mode = NEW.mode AND t.tag_ref = NEW.tag_ref);
END;

-- Update: who and what never change. A state moves only along the edges below (the statements also compare the
-- old state, so of two racing calls exactly one passes). The intended envelope is set once, with `scripted`
-- (the same statement that releases the script), cleared only as the tag becomes `programmed` or `reset`, and
-- otherwise moves only by a rewrap (a higher KEK version with the same iv and ciphertext). `programmed` is
-- reached from `scripted` for a tag of the row's tenant and ref, and ends the row.
CREATE TRIGGER nfc_tag_programs_update BEFORE UPDATE ON nfc_tag_programs
BEGIN
  SELECT RAISE(ABORT, 'program_fixed') WHERE NEW.id IS NOT OLD.id OR NEW.org_id IS NOT OLD.org_id
    OR NEW.mode IS NOT OLD.mode OR NEW.keyset_id IS NOT OLD.keyset_id OR NEW.key_version IS NOT OLD.key_version
    OR NEW.tag_ref IS NOT OLD.tag_ref OR NEW.hint IS NOT OLD.hint OR NEW.actor_type IS NOT OLD.actor_type
    OR NEW.actor_key IS NOT OLD.actor_key OR NEW.scanner_id IS NOT OLD.scanner_id OR NEW.staff_id IS NOT OLD.staff_id
    OR NEW.api_key_id IS NOT OLD.api_key_id OR NEW.purpose IS NOT OLD.purpose OR NEW.idem_key IS NOT OLD.idem_key
    OR NEW.created_at IS NOT OLD.created_at;
  SELECT RAISE(ABORT, 'program_ended') WHERE OLD.state IN ('programmed', 'reset');
  SELECT RAISE(ABORT, 'program_state') WHERE NEW.state IS NOT OLD.state AND NOT (
    (OLD.state = 'started' AND NEW.state IN ('scripted', 'interrupted', 'failed', 'abandoned', 'reset'))
    OR (OLD.state = 'scripted' AND NEW.state IN ('started', 'programmed', 'interrupted', 'failed', 'abandoned', 'reset'))
    OR (OLD.state = 'interrupted' AND NEW.state IN ('started', 'failed', 'abandoned', 'reset'))
    OR (OLD.state = 'abandoned' AND NEW.state IN ('started', 'reset'))
    OR (OLD.state = 'failed' AND NEW.state IN ('abandoned', 'reset')));
  SELECT RAISE(ABORT, 'program_state') WHERE NEW.state = 'programmed' AND (OLD.step <> 'result' OR NEW.tag_id IS NULL
    OR NOT EXISTS (SELECT 1 FROM nfc_tags t WHERE t.id = NEW.tag_id AND t.org_id = NEW.org_id AND t.mode = NEW.mode
      AND t.tag_ref = NEW.tag_ref));
  SELECT RAISE(ABORT, 'program_state') WHERE NEW.state = 'reset' AND OLD.state <> 'reset' AND OLD.step <> 'result';
  SELECT RAISE(ABORT, 'program_fixed') WHERE OLD.released_by IS NOT NULL AND NEW.released_by IS NOT OLD.released_by;
  SELECT RAISE(ABORT, 'program_attempts') WHERE NEW.attempts < OLD.attempts OR NEW.attempts > OLD.attempts + 1;
  SELECT RAISE(ABORT, 'program_expiry') WHERE NEW.expires_at < OLD.expires_at;
  SELECT RAISE(ABORT, 'program_keys_fixed') WHERE
    (OLD.kek_version IS NULL AND NEW.kek_version IS NOT NULL AND NOT (OLD.state = 'started' AND NEW.state = 'scripted'))
    OR (OLD.kek_version IS NOT NULL AND NEW.kek_version IS NULL AND NEW.state NOT IN ('programmed', 'reset'))
    OR (OLD.kek_version IS NOT NULL AND NEW.kek_version IS NOT NULL
      AND (NEW.iv IS NOT OLD.iv OR NEW.ciphertext IS NOT OLD.ciphertext
        OR NEW.kek_version < OLD.kek_version OR (NEW.kek_version = OLD.kek_version AND NEW.wrapped_dek IS NOT OLD.wrapped_dek)
        OR (NEW.kek_version > OLD.kek_version AND NEW.wrapped_dek IS OLD.wrapped_dek)));
END;

-- Delete: a row that holds intended keys stays until the tag is reset or abandoned and 30 days have passed, and then
-- only under the retention job's grant (the grant carries the clock). The org purge may remove it, and an org that
-- is gone takes its rows with it.
CREATE TRIGGER nfc_tag_programs_no_delete BEFORE DELETE ON nfc_tag_programs
WHEN OLD.kek_version IS NOT NULL AND EXISTS (SELECT 1 FROM orgs o WHERE o.id = OLD.org_id)
  AND NOT EXISTS (SELECT 1 FROM authority_grants g WHERE g.purpose = 'platform.job.org.purge' AND g.target_id = OLD.org_id)
BEGIN
  SELECT RAISE(ABORT, 'program_keys_kept') WHERE NOT (OLD.state IN ('reset', 'abandoned') AND EXISTS (
    SELECT 1 FROM authority_grants g WHERE g.purpose = 'org_mode.job.nfc.programs' AND g.org_id = OLD.org_id
      AND g.mode = OLD.mode AND g.created_at - 2592000000 >= OLD.updated_at));
END;

-- The admin keys of a programmed tag (K0, K3, K4: 48 bytes, 64 sealed), kept so the tag can be rekeyed or reset
-- later. K2 stays in `nfc_tag_sun`; K1 is the keyset version's meta key. Written with the tag, never changed but
-- by a rewrap, gone with the tag.
CREATE TABLE nfc_tag_admin_keys (
  tag_id TEXT PRIMARY KEY REFERENCES nfc_tags (id) ON DELETE CASCADE,
  keyset_id TEXT NOT NULL REFERENCES nfc_tag_keysets (id),
  key_version INTEGER NOT NULL CHECK (key_version BETWEEN 1 AND 255),
  kek_version INTEGER NOT NULL CHECK (kek_version >= 1),
  iv BLOB NOT NULL CHECK (length(iv) = 12),
  wrapped_dek BLOB NOT NULL CHECK (length(wrapped_dek) = 60),
  ciphertext BLOB NOT NULL CHECK (length(ciphertext) = 64),
  created_at INTEGER NOT NULL
);
CREATE INDEX nfc_tag_admin_keys_keyset ON nfc_tag_admin_keys (keyset_id, key_version);

CREATE TRIGGER nfc_tag_admin_keys_insert BEFORE INSERT ON nfc_tag_admin_keys
BEGIN
  SELECT RAISE(ABORT, 'admin_keys_tag') WHERE NOT EXISTS (
    SELECT 1 FROM nfc_tag_sun s WHERE s.tag_id = NEW.tag_id AND s.keyset_id = NEW.keyset_id
      AND s.key_version = NEW.key_version AND s.kek_version IS NOT NULL);
END;
CREATE TRIGGER nfc_tag_admin_keys_update BEFORE UPDATE ON nfc_tag_admin_keys
BEGIN
  SELECT RAISE(ABORT, 'admin_keys_fixed') WHERE NEW.tag_id IS NOT OLD.tag_id OR NEW.keyset_id IS NOT OLD.keyset_id
    OR NEW.key_version IS NOT OLD.key_version OR NEW.created_at IS NOT OLD.created_at
    OR NEW.iv IS NOT OLD.iv OR NEW.ciphertext IS NOT OLD.ciphertext
    OR NOT (NEW.kek_version > OLD.kek_version AND NEW.wrapped_dek IS NOT OLD.wrapped_dek)
       AND (NEW.kek_version IS NOT OLD.kek_version OR NEW.wrapped_dek IS NOT OLD.wrapped_dek);
END;
CREATE TRIGGER nfc_tag_admin_keys_no_delete BEFORE DELETE ON nfc_tag_admin_keys
WHEN EXISTS (SELECT 1 FROM nfc_tags t WHERE t.id = OLD.tag_id)
BEGIN SELECT RAISE(ABORT, 'admin_keys_fixed'); END;

-- A developer org holds no Live row, whoever writes it (0156). Created last, so it fires before the checks above.
CREATE TRIGGER nfc_tag_programs_developer_no_live BEFORE INSERT ON nfc_tag_programs
WHEN NEW.mode = 'live' AND EXISTS (SELECT 1 FROM orgs o WHERE o.id = NEW.org_id AND o.kind = 'developer')
BEGIN SELECT RAISE(ABORT, 'a developer org holds no Live data'); END;
