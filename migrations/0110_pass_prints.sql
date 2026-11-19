-- Printed tickets (paper channel). One active print per pass; a reprint voids the earlier one. The code is
-- never stored: print_code_hash is a keyed HMAC, roster_hash the offline roster's unkeyed 128-bit hash
-- (the code has 128 bits of entropy, so the short hash does not reveal it).
CREATE TABLE pass_prints (
  id TEXT PRIMARY KEY,
  pass_id TEXT NOT NULL REFERENCES passes (id) ON DELETE CASCADE,
  org_id TEXT NOT NULL,
  mode TEXT NOT NULL CHECK (mode IN ('live', 'test')),
  print_code_hash TEXT NOT NULL UNIQUE CHECK (length(print_code_hash) = 64 AND print_code_hash NOT GLOB '*[^0-9a-f]*'),
  roster_hash TEXT NOT NULL CHECK (length(roster_hash) = 32 AND roster_hash NOT GLOB '*[^0-9a-f]*'),
  generation INTEGER NOT NULL CHECK (typeof(generation) = 'integer' AND generation >= 1),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'voided', 'used')),
  created_by TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  voided_at INTEGER,
  void_cause TEXT,
  CHECK ((status = 'voided') = (voided_at IS NOT NULL)),
  UNIQUE (pass_id, generation)
);
CREATE UNIQUE INDEX pass_prints_active ON pass_prints (pass_id) WHERE status = 'active';
CREATE INDEX pass_prints_roster ON pass_prints (org_id, mode, status);

CREATE TRIGGER pass_prints_tenant BEFORE INSERT ON pass_prints
WHEN NOT EXISTS (SELECT 1 FROM passes p WHERE p.id = NEW.pass_id AND p.org_id = NEW.org_id AND p.mode = NEW.mode)
BEGIN SELECT RAISE(ABORT, 'pass_print_tenant'); END;
CREATE TRIGGER pass_prints_key BEFORE UPDATE ON pass_prints
WHEN NEW.id IS NOT OLD.id OR NEW.pass_id IS NOT OLD.pass_id OR NEW.org_id IS NOT OLD.org_id
  OR NEW.mode IS NOT OLD.mode OR NEW.print_code_hash IS NOT OLD.print_code_hash
  OR NEW.roster_hash IS NOT OLD.roster_hash OR NEW.generation IS NOT OLD.generation
  OR NEW.created_by IS NOT OLD.created_by OR NEW.created_at IS NOT OLD.created_at
  OR (OLD.status != 'active' AND (NEW.status IS NOT OLD.status OR NEW.voided_at IS NOT OLD.voided_at
    OR NEW.void_cause IS NOT OLD.void_cause))
BEGIN SELECT RAISE(ABORT, 'pass_print_key'); END;

-- Every void, whoever causes it, lands in the journal (and so the webhook feed) without the code.
CREATE TRIGGER pass_prints_voided AFTER UPDATE OF status ON pass_prints
WHEN OLD.status = 'active' AND NEW.status = 'voided'
BEGIN
  INSERT INTO pass_events (id, org_id, pass_id, mode, kind, data, at)
  VALUES (lower(hex(randomblob(16))), NEW.org_id, NEW.pass_id, NEW.mode, 'pass.print_voided',
    json_object('printId', NEW.id, 'cause', NEW.void_cause), NEW.voided_at);
END;

-- Pass void, holder change, credential transfer and a manual New code end the pass's active print.
-- Channel rotation does not: it carries no scan_code_rotations mark.
CREATE TRIGGER pass_prints_pass_voided AFTER UPDATE OF status ON passes
WHEN NEW.status = 'voided' AND OLD.status IS NOT 'voided'
BEGIN
  UPDATE pass_prints SET status = 'voided', voided_at = NEW.modified_at, void_cause = 'pass_voided'
  WHERE pass_id = NEW.id AND status = 'active';
END;
CREATE TRIGGER pass_prints_credential AFTER UPDATE OF holder_email, credential_generation ON passes
WHEN NEW.holder_email IS NOT OLD.holder_email OR NEW.credential_generation IS NOT OLD.credential_generation
BEGIN
  UPDATE pass_prints SET status = 'voided', voided_at = NEW.modified_at,
    void_cause = CASE WHEN NEW.holder_email IS NOT OLD.holder_email THEN 'holder_change' ELSE 'transfer' END
  WHERE pass_id = NEW.id AND status = 'active';
END;
CREATE TRIGGER pass_prints_new_code AFTER INSERT ON scan_code_rotations
BEGIN
  UPDATE pass_prints SET status = 'voided', voided_at = NEW.rotated_at, void_cause = 'new_code'
  WHERE pass_id = NEW.pass_id AND status = 'active';
END;
