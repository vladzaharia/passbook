-- A limited child key under a limited parent. 0155 checks a child's resource rows as they are inserted, so a
-- child that names no template (or no style) while its parent names some was never compared: no rows means
-- "no limit" in key_templates, which made the child wider than its parent. The view now also requires the
-- parent's limits whenever the key has a parent, so a child reaches only what both reach. A child's parent
-- is never a child (0155), so one level is enough. The aliases `par`, `pres` and `psty` stay apart from the ones
-- the statements that join this view use.
DROP VIEW key_templates;
CREATE VIEW key_templates AS
SELECT key.id AS key_id, tpl.id AS id
FROM api_keys key JOIN templates tpl ON tpl.org_id = key.org_id OR (tpl.org_id IS NULL AND (tpl.shared = 1 OR tpl.origin = 'baked'))
WHERE key.restricted = 1
  AND (NOT EXISTS (SELECT 1 FROM api_key_resources res WHERE res.key_id = key.id AND res.kind = 'template')
    OR tpl.id IN (SELECT res.value FROM api_key_resources res WHERE res.key_id = key.id AND res.kind = 'template'))
  AND (NOT EXISTS (SELECT 1 FROM api_key_resources res WHERE res.key_id = key.id AND res.kind = 'pass_style')
    OR (json_array_length(tpl.styles) > 0 AND NOT EXISTS (SELECT 1 FROM json_each(tpl.styles) sty
      WHERE sty.type <> 'text' OR sty.value NOT IN (SELECT res.value FROM api_key_resources res WHERE res.key_id = key.id AND res.kind = 'pass_style'))))
  AND (key.parent_key_id IS NULL OR EXISTS (SELECT 1 FROM api_keys par WHERE par.id = key.parent_key_id AND par.restricted = 0)
    OR (EXISTS (SELECT 1 FROM api_keys par WHERE par.id = key.parent_key_id AND par.restricted = 1)
      AND (NOT EXISTS (SELECT 1 FROM api_key_resources pres WHERE pres.key_id = key.parent_key_id AND pres.kind = 'template')
        OR tpl.id IN (SELECT pres.value FROM api_key_resources pres WHERE pres.key_id = key.parent_key_id AND pres.kind = 'template'))
      AND (NOT EXISTS (SELECT 1 FROM api_key_resources pres WHERE pres.key_id = key.parent_key_id AND pres.kind = 'pass_style')
        OR (json_array_length(tpl.styles) > 0 AND NOT EXISTS (SELECT 1 FROM json_each(tpl.styles) psty
          WHERE psty.type <> 'text' OR psty.value NOT IN (SELECT pres.value FROM api_key_resources pres WHERE pres.key_id = key.parent_key_id AND pres.kind = 'pass_style'))))));
