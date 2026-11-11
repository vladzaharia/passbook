-- Retain retired identities even when an unreferenced draft or its template is removed.
CREATE TABLE template_version_tombstones (
  template_id TEXT NOT NULL,
  version TEXT NOT NULL,
  PRIMARY KEY (template_id, version)
);

CREATE TRIGGER template_version_tombstones_immutable
BEFORE UPDATE ON template_version_tombstones
BEGIN
  SELECT RAISE(ABORT, 'template version tombstones are immutable');
END;

CREATE TRIGGER template_version_tombstones_no_delete
BEFORE DELETE ON template_version_tombstones
BEGIN
  SELECT RAISE(ABORT, 'template version tombstones are immutable');
END;

CREATE TRIGGER template_versions_retire_identity
AFTER DELETE ON template_versions
BEGIN
  INSERT OR IGNORE INTO template_version_tombstones (template_id, version)
  VALUES (OLD.template_id, OLD.version);
END;

-- A conflicting INSERT OR REPLACE must not delete and recreate an existing version.
CREATE TRIGGER template_versions_insert_immutable
BEFORE INSERT ON template_versions
WHEN EXISTS (
  SELECT 1 FROM template_versions
  WHERE template_id = NEW.template_id AND version = NEW.version
) OR EXISTS (
  SELECT 1 FROM template_version_tombstones
  WHERE template_id = NEW.template_id AND version = NEW.version
)
BEGIN
  SELECT RAISE(ABORT, 'template versions are immutable');
END;
