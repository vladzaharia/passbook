ALTER TABLE template_versions ADD COLUMN build_key TEXT;
CREATE INDEX template_versions_build_key ON template_versions (template_id, build_key);