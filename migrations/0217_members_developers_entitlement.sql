-- `members.developers`: how many developers (live sponsorships plus pending invitations) an org vouches for.
-- Literal rows per preset, held equal to the registry in src/shared/contracts/entitlements.ts.
INSERT OR IGNORE INTO entitlement_presets (preset, key, value) VALUES
  ('trial', 'members.developers', '1'),
  ('starter', 'members.developers', '2'),
  ('standard', 'members.developers', '5'),
  ('premium', 'members.developers', '25'),
  ('legacy', 'members.developers', 'null'),
  ('developer', 'members.developers', '0');
