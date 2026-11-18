-- A rewrap (cron keys.rewrap) moves an envelope to a newer KEK. It changes kek_version and wrapped_dek and
-- nothing else: iv and ciphertext (with its AES-GCM tag) stay. It is not a credential change, so it must
-- neither bump signing-identity revisions nor trip the append-only guards below.
--
-- Why SQL can accept it by shape: the content is AES-256-GCM under the DEK, with iv, ciphertext and tag fixed.
-- A wrapped_dek that still unwraps (it is authenticated with the same AAD) yields some DEK, and the fixed
-- ciphertext authenticates under only the DEK that made it: finding a second key for one (iv, ciphertext,
-- tag) is infeasible, and the known multi-key attacks need a ciphertext chosen for several keys. So a
-- shape-conforming update cannot change a secret. The worst it can do is write a wrapped_dek that does not
-- unwrap, which anyone able to write these rows can already do. kek_version must rise, so the carve-out
-- cannot move a row back to a retired or compromised KEK.
--
-- Everything else in the three triggers is unchanged (0034, 0037, 0042).
DROP TRIGGER signing_identity_revision_credential_update;
CREATE TRIGGER signing_identity_revision_credential_update AFTER UPDATE OF
  org_id, kind, kek_version, iv, wrapped_dek, ciphertext, fingerprint
ON credentials
WHEN (OLD.org_id IS NOT NEW.org_id OR OLD.kind IS NOT NEW.kind
  OR OLD.kek_version IS NOT NEW.kek_version OR OLD.iv IS NOT NEW.iv
  OR OLD.wrapped_dek IS NOT NEW.wrapped_dek OR OLD.ciphertext IS NOT NEW.ciphertext
  OR OLD.fingerprint IS NOT NEW.fingerprint)
  AND NOT (NEW.kek_version > OLD.kek_version AND NEW.wrapped_dek IS NOT OLD.wrapped_dek
    AND NEW.iv IS OLD.iv AND NEW.ciphertext IS OLD.ciphertext AND NEW.org_id IS OLD.org_id
    AND NEW.kind IS OLD.kind AND NEW.fingerprint IS OLD.fingerprint)
  AND EXISTS (SELECT 1 FROM signing_identities WHERE credential_id = NEW.id)
BEGIN
  UPDATE signing_identity_revision_sequence SET revision = revision + 1 WHERE id = 1;
  UPDATE signing_identities SET revision = (SELECT revision FROM signing_identity_revision_sequence WHERE id = 1)
    WHERE credential_id = NEW.id;
END;

DROP TRIGGER wallet_provider_credentials_no_update;
CREATE TRIGGER wallet_provider_credentials_no_update BEFORE UPDATE ON wallet_provider_credentials
WHEN NOT (NEW.kek_version > OLD.kek_version AND NEW.wrapped_dek IS NOT OLD.wrapped_dek
  AND NEW.iv IS OLD.iv AND NEW.ciphertext IS OLD.ciphertext AND NEW.id IS OLD.id
  AND NEW.account_id IS OLD.account_id AND NEW.org_id IS OLD.org_id AND NEW.mode IS OLD.mode
  AND NEW.provider IS OLD.provider AND NEW.created_at IS OLD.created_at)
BEGIN SELECT RAISE(ABORT, 'immutable wallet provider credential'); END;

DROP TRIGGER pass_credential_transfer_payload_no_update;
CREATE TRIGGER pass_credential_transfer_payload_no_update BEFORE UPDATE ON pass_credential_transfer_payloads
WHEN NOT (NEW.kek_version > OLD.kek_version AND NEW.wrapped_dek IS NOT OLD.wrapped_dek
  AND NEW.iv IS OLD.iv AND NEW.ciphertext IS OLD.ciphertext AND NEW.transfer_id IS OLD.transfer_id)
BEGIN SELECT RAISE(ABORT, 'credential transfer payload is immutable'); END;
