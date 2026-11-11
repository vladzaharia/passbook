-- Superseded branding objects wait out a grace period so a pass build that began before the
-- commit can still read them. Deliberately no FK: the sweep must outlive the org row.
CREATE TABLE branding_gc_queue (
  org_id TEXT NOT NULL,
  r2_key TEXT NOT NULL,
  superseded_at INTEGER NOT NULL,
  PRIMARY KEY (org_id, r2_key)
) WITHOUT ROWID;
CREATE INDEX branding_gc_queue_due ON branding_gc_queue(superseded_at);
