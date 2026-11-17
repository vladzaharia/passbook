-- Blueprints are platform designs to start from; passes are issued from templates only.
ALTER TABLE templates ADD COLUMN blueprint INTEGER NOT NULL DEFAULT 0 CHECK (blueprint IN (0, 1));
-- The blueprint a template was made from.
ALTER TABLE templates ADD COLUMN source_blueprint TEXT REFERENCES templates (id) ON DELETE SET NULL;
-- The shipped starters were the blueprints before the flag existed; the next baked sync keeps it.
UPDATE templates SET blueprint = 1 WHERE origin = 'baked' AND org_id IS NULL AND id LIKE 'baked:starter-%';
CREATE INDEX templates_blueprint ON templates (blueprint) WHERE blueprint = 1;
CREATE INDEX templates_source_blueprint_fk ON templates (source_blueprint)
  WHERE source_blueprint IS NOT NULL;
