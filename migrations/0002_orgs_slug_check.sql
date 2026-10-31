-- orgs.slug: the 0001 CHECK (GLOB '[a-z0-9]*') only constrains the first character, so slugs like
-- 'a B/../x' were accepted. Triggers enforce [a-z0-9][a-z0-9-]* without rebuilding the table.

CREATE TRIGGER orgs_slug_valid_insert BEFORE INSERT ON orgs
WHEN NEW.slug GLOB '*[^a-z0-9-]*' OR NEW.slug GLOB '-*'
BEGIN
  SELECT RAISE(ABORT, 'orgs.slug must match [a-z0-9][a-z0-9-]*');
END;

CREATE TRIGGER orgs_slug_valid_update BEFORE UPDATE OF slug ON orgs
WHEN NEW.slug GLOB '*[^a-z0-9-]*' OR NEW.slug GLOB '-*'
BEGIN
  SELECT RAISE(ABORT, 'orgs.slug must match [a-z0-9][a-z0-9-]*');
END;
