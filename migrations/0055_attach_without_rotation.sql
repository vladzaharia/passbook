-- A verified holder attaches to a pass whose credential cannot change (a static barcode) without a
-- transfer: the owner goes from none to a user, and nothing else moves. The owner removing the pass
-- clears the owner after writing the attach block for that user, which deletion of the user never does.
-- Any other owner, holder or credential change still needs a transfer.
DROP TRIGGER pass_credential_transfer_required;
CREATE TRIGGER pass_credential_transfer_required
BEFORE UPDATE OF holder_email, owner_user_id, serial, auth_token, scan_code, identity_id, org_id, mode ON passes
WHEN NOT EXISTS (SELECT 1 FROM pass_credential_transfers t WHERE t.pass_id = OLD.id AND t.state = 'pending')
  AND (NEW.holder_email IS NOT OLD.holder_email
    OR (NEW.owner_user_id IS NOT OLD.owner_user_id
      AND NOT (OLD.owner_user_id IS NULL AND NEW.owner_user_id IS NOT NULL)
      AND NOT (OLD.owner_user_id IS NOT NULL AND NEW.owner_user_id IS NULL
        AND EXISTS (SELECT 1 FROM pass_attach_blocks b WHERE b.pass_id = OLD.id AND b.user_id = OLD.owner_user_id)))
    OR NEW.serial IS NOT OLD.serial OR NEW.auth_token IS NOT OLD.auth_token
    OR NEW.identity_id IS NOT OLD.identity_id OR NEW.org_id IS NOT OLD.org_id OR NEW.mode IS NOT OLD.mode
    OR (OLD.scan_code IS NOT NULL AND NEW.scan_code IS NOT OLD.scan_code))
BEGIN SELECT RAISE(ABORT, 'credential transfer required'); END;

-- A connector transfer re-signs a pass under its own issued release when the template is archived or
-- the head is another build; only a release that is not the pass's own must still be an active head.
DROP TRIGGER pass_credential_transfer_insert_guard;
CREATE TRIGGER pass_credential_transfer_insert_guard
BEFORE INSERT ON pass_credential_transfers
WHEN NEW.state != 'pending' OR NEW.completed_at IS NOT NULL
  OR EXISTS (SELECT 1 FROM pass_credential_transfers t
    WHERE t.id = NEW.id OR (t.pass_id = NEW.pass_id
      AND (t.state = 'pending' OR t.target_generation = NEW.target_generation)))
  OR NOT EXISTS (
    SELECT 1 FROM passes p WHERE p.id = NEW.pass_id AND p.org_id = NEW.org_id AND p.mode = NEW.mode
      AND p.test_data_quarantined = 0
      AND EXISTS (SELECT 1 FROM orgs org WHERE org.id = p.org_id AND org.status = 'active')
      AND p.credential_generation = NEW.source_generation AND p.row_version = NEW.source_row_version
      AND p.lifecycle_generation = NEW.source_lifecycle_generation
      AND p.link_generation + 1 = NEW.source_link_generation
  )
  OR (NEW.source_connection_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM passes p
    JOIN connections c ON c.id = p.connection_id AND c.org_id = p.org_id
    JOIN templates template ON template.id = p.template_id
    JOIN template_releases rel ON rel.id = NEW.source_admitted_release_id
    WHERE p.id = NEW.pass_id AND p.org_id = NEW.org_id AND p.mode = 'live'
      AND p.connection_id = NEW.source_connection_id AND p.external_ref IS NEW.source_connection_ref
      AND c.enabled = 1 AND c.generation = NEW.source_connection_generation AND c.mode = NEW.source_connection_mode
      AND template.status != 'deleted'
      AND rel.template_id = p.template_id AND rel.mode = p.mode AND rel.provider = 'apple'
      AND rel.generation = NEW.source_admitted_release_generation
      AND rel.version = NEW.source_admitted_release_version
      AND (rel.org_id = p.org_id OR (rel.org_id IS NULL
        AND template.org_id IS NULL AND template.origin = 'baked'))
      AND (rel.id = p.release_id OR (template.status = 'active'
        AND NOT EXISTS (SELECT 1 FROM template_releases newer WHERE newer.template_id = rel.template_id
          AND newer.org_id IS rel.org_id AND newer.mode = rel.mode AND newer.provider = rel.provider
          AND newer.generation > rel.generation)))
  ))
BEGIN SELECT RAISE(ABORT, 'invalid credential transfer snapshot'); END;
