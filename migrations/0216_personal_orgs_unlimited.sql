-- Personal orgs are on Unlimited (the plan id `legacy`) and never change plan. Every existing one moves the way a
-- preset edit moves an org: the preset, the aligned preset revision and a bumped features revision (so a Features
-- tab opened before this 409s), all at a fixed time. Its standing overrides go: Unlimited has nothing to override
-- and nobody on the platform edits a personal org's features. The move only adds (Standard to Unlimited), so no
-- channel needs converging. The audit rows are written first, while the old preset can still be read.
INSERT INTO audit_log (at, org_id, actor_type, actor_id, action, target_type, target_id, detail)
  SELECT 1795651200000, e.org_id, 'system', NULL, 'org.entitlements_update', 'org', e.org_id,
    json_object('preset', json_object('from', e.preset, 'to', 'legacy'), 'personal', json('true'), 'migration', '0216')
  FROM org_entitlements e JOIN orgs o ON o.id = e.org_id
  WHERE o.personal_user_id IS NOT NULL AND e.preset <> 'legacy';

UPDATE org_entitlements SET
  preset = 'legacy',
  preset_revision = (SELECT m.revision FROM entitlement_preset_meta m WHERE m.preset = 'legacy'),
  revision = revision + 1,
  updated_at = 1795651200000,
  updated_by = NULL
WHERE preset <> 'legacy'
  AND org_id IN (SELECT id FROM orgs WHERE personal_user_id IS NOT NULL);

DELETE FROM org_entitlement_overrides
WHERE org_id IN (SELECT id FROM orgs WHERE personal_user_id IS NOT NULL);
