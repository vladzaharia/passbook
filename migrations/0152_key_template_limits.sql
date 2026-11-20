-- Template and pass-style limits of a key, enforced in grants and reads (docs: design-api-platform section 2.3).
-- A grant row of a limited key carries the key id; every statement on a template-bearing table joins `key_templates`.
-- authority_grants is empty between batches, so the added column needs no backfill.
ALTER TABLE authority_grants ADD COLUMN limit_key TEXT;

-- The templates a limited key may reach, live: its named templates (none named = every template of its org and the
-- shared or baked ones), each also passing the style limit (every style of the template is allowed; no styles never passes).
-- A template that gains a style later stops matching, with no write to the key. Aliases are distinct from the ones
-- statements that join this view use, so a query plan names them apart.
CREATE VIEW key_templates AS
SELECT key.id AS key_id, tpl.id AS id
FROM api_keys key JOIN templates tpl ON tpl.org_id = key.org_id OR (tpl.org_id IS NULL AND (tpl.shared = 1 OR tpl.origin = 'baked'))
WHERE key.restricted = 1
  AND (NOT EXISTS (SELECT 1 FROM api_key_resources res WHERE res.key_id = key.id AND res.kind = 'template')
    OR tpl.id IN (SELECT res.value FROM api_key_resources res WHERE res.key_id = key.id AND res.kind = 'template'))
  AND (NOT EXISTS (SELECT 1 FROM api_key_resources res WHERE res.key_id = key.id AND res.kind = 'pass_style')
    OR (json_array_length(tpl.styles) > 0 AND NOT EXISTS (SELECT 1 FROM json_each(tpl.styles) sty
      WHERE sty.value NOT IN (SELECT res.value FROM api_key_resources res WHERE res.key_id = key.id AND res.kind = 'pass_style'))));
