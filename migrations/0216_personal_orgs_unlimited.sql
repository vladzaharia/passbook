-- Personal orgs are on Unlimited (the plan id `legacy`) and never change plan. Every existing one that is on
-- another plan moves the way a preset edit moves an org, at a fixed time: the preset, and a bumped features
-- revision (so a Features tab opened before this 409s). `preset_revision` is 0, below any preset revision, so
-- the next apply of Unlimited re-evaluates these orgs in full instead of treating them as aligned. Their
-- standing overrides go with the move: Unlimited has nothing to override and nobody on the platform edits a
-- personal org's features. An org already on Unlimited is left as it is. The move only adds (Standard to
-- Unlimited), so no channel needs converging. The audit rows and the override delete come first, while the
-- old preset can still be read.
INSERT INTO audit_log (at, org_id, actor_type, actor_id, action, target_type, target_id, detail)
  SELECT 1795651200000, e.org_id, 'system', NULL, 'org.entitlements_update', 'org', e.org_id,
    json_object('preset', json_object('from', e.preset, 'to', 'legacy'), 'personal', json('true'), 'migration', '0216')
  FROM org_entitlements e JOIN orgs o ON o.id = e.org_id
  WHERE o.personal_user_id IS NOT NULL AND e.preset <> 'legacy';

DELETE FROM org_entitlement_overrides
WHERE org_id IN (
  SELECT e.org_id FROM org_entitlements e JOIN orgs o ON o.id = e.org_id
  WHERE o.personal_user_id IS NOT NULL AND e.preset <> 'legacy');

UPDATE org_entitlements SET
  preset = 'legacy',
  preset_revision = 0,
  revision = revision + 1,
  updated_at = 1795651200000,
  updated_by = NULL
WHERE preset <> 'legacy'
  AND org_id IN (SELECT id FROM orgs WHERE personal_user_id IS NOT NULL);
