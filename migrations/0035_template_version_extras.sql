-- Preview-only assets are versioned separately from pass bundle assets. Baked sync seals
-- each complete set, including the empty set, before creating a system release.
CREATE TABLE template_version_extras (
  template_id TEXT NOT NULL,
  version TEXT NOT NULL,
  name TEXT NOT NULL CHECK (length(name) > 0),
  size INTEGER NOT NULL CHECK (size >= 0),
  sha1 TEXT NOT NULL CHECK (length(sha1) = 40 AND sha1 NOT GLOB '*[^0-9a-f]*'),
  sha256 TEXT NOT NULL CHECK (length(sha256) = 64 AND sha256 NOT GLOB '*[^0-9a-f]*'),
  r2_key TEXT NOT NULL CHECK (length(r2_key) > 0),
  PRIMARY KEY (template_id, version, name),
  FOREIGN KEY (template_id, version) REFERENCES template_versions(template_id, version)
);

CREATE TABLE template_version_extra_sets (
  template_id TEXT NOT NULL,
  version TEXT NOT NULL,
  extras_hash TEXT NOT NULL CHECK (length(extras_hash) = 64 AND extras_hash NOT GLOB '*[^0-9a-f]*'),
  PRIMARY KEY (template_id, version),
  FOREIGN KEY (template_id, version) REFERENCES template_versions(template_id, version)
);

CREATE TRIGGER template_version_extras_insert BEFORE INSERT ON template_version_extras
WHEN NOT EXISTS (SELECT 1 FROM templates t WHERE t.id = NEW.template_id AND t.origin = 'baked')
  OR EXISTS (SELECT 1 FROM template_version_extra_sets s
    WHERE s.template_id = NEW.template_id AND s.version = NEW.version)
BEGIN SELECT RAISE(ABORT, 'invalid template version extra'); END;
CREATE TRIGGER template_version_extras_immutable BEFORE UPDATE ON template_version_extras
BEGIN SELECT RAISE(ABORT, 'template version extras are immutable'); END;
CREATE TRIGGER template_version_extras_no_delete BEFORE DELETE ON template_version_extras
BEGIN SELECT RAISE(ABORT, 'template version extras are immutable'); END;
CREATE TRIGGER template_version_extra_sets_insert BEFORE INSERT ON template_version_extra_sets
WHEN NOT EXISTS (SELECT 1 FROM templates t WHERE t.id = NEW.template_id AND t.origin = 'baked')
BEGIN SELECT RAISE(ABORT, 'invalid template version extra set'); END;
CREATE TRIGGER template_version_extra_sets_immutable BEFORE UPDATE ON template_version_extra_sets
BEGIN SELECT RAISE(ABORT, 'template version extra sets are immutable'); END;
CREATE TRIGGER template_version_extra_sets_no_delete BEFORE DELETE ON template_version_extra_sets
BEGIN SELECT RAISE(ABORT, 'template version extra sets are immutable'); END;
