-- Pass bundles: 1-10 passes of one org and mode behind one capability link (/b/:token).

CREATE TABLE bundles (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES orgs (id) ON DELETE CASCADE,
  mode TEXT NOT NULL DEFAULT 'live' CHECK (mode IN ('live', 'test')),
  name TEXT NOT NULL,
  -- Stored retrievably, like passes.download_token: links are re-sent.
  token TEXT NOT NULL UNIQUE,
  token_rotated_at INTEGER,
  holder_email TEXT,
  created_by_type TEXT,
  created_by_id TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX bundles_org ON bundles (org_id, mode, id DESC);
CREATE INDEX bundles_mode ON bundles (mode, id DESC);

CREATE TABLE bundle_passes (
  bundle_id TEXT NOT NULL REFERENCES bundles (id) ON DELETE CASCADE,
  pass_id TEXT NOT NULL REFERENCES passes (id) ON DELETE CASCADE,
  position INTEGER NOT NULL,
  PRIMARY KEY (bundle_id, pass_id)
);
CREATE INDEX bundle_passes_pass ON bundle_passes (pass_id);
