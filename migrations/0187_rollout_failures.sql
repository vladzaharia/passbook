-- Why a pass stayed behind when its template release was rolled out: one row per pass, written by the
-- reissue workflow when it cannot move the pass, read by the rollout view. A row counts only while
-- `release_id` is the scope's active release and the pass is still behind it.
CREATE TABLE template_rollout_failures (
  pass_id TEXT PRIMARY KEY REFERENCES passes (id) ON DELETE CASCADE,
  release_id TEXT NOT NULL,
  code TEXT NOT NULL,
  message TEXT NOT NULL,
  at INTEGER NOT NULL
) WITHOUT ROWID;
