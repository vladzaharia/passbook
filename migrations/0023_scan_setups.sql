CREATE TABLE scanner_setups (
  scanner_id TEXT PRIMARY KEY REFERENCES scanners(id) ON DELETE CASCADE,
  org_id TEXT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  mode TEXT NOT NULL CHECK(mode IN ('live','test')),
  admin_session INTEGER NOT NULL DEFAULT 0 CHECK(admin_session IN (0,1)),
  admin_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  watch TEXT CHECK(watch IS NULL OR json_valid(watch))
);
CREATE INDEX scanner_setups_org ON scanner_setups(org_id);
CREATE UNIQUE INDEX scanner_setups_owner ON scanner_setups(org_id,mode,admin_user_id) WHERE admin_user_id IS NOT NULL;
CREATE INDEX scanner_setups_user ON scanner_setups(admin_user_id);
CREATE TRIGGER scanner_setups_mode AFTER UPDATE OF mode ON scanners BEGIN
  UPDATE scanner_setups SET mode=NEW.mode WHERE scanner_id=NEW.id;
END;
CREATE TRIGGER scanner_setups_revoked AFTER UPDATE OF revoked_at ON scanners WHEN NEW.revoked_at IS NOT NULL BEGIN
  UPDATE scanner_setups SET admin_user_id=NULL WHERE scanner_id=NEW.id;
END;
