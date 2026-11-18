-- A connection has at most one open sync run (not a pass refresh: those carry a pass_id). Older duplicates (left open by lost instances) close first.
UPDATE connection_runs
SET outcome = 'error', error_code = 'RUN_LOST', finished_at = started_at, duration_ms = 0
WHERE outcome = 'running' AND trigger IN ('schedule', 'admin') AND pass_id IS NULL
  AND EXISTS (
    SELECT 1 FROM connection_runs n
    WHERE n.connection_id = connection_runs.connection_id
      AND n.outcome = 'running' AND n.trigger IN ('schedule', 'admin') AND n.pass_id IS NULL
      AND (n.started_at > connection_runs.started_at
        OR (n.started_at = connection_runs.started_at AND n.id > connection_runs.id))
  );

CREATE UNIQUE INDEX connection_runs_open_sync ON connection_runs (connection_id)
WHERE outcome = 'running' AND trigger IN ('schedule', 'admin') AND pass_id IS NULL;

-- The last continuation of a chained sync run; the scheduler checks that instance when a run looks stuck.
ALTER TABLE workflow_runs ADD COLUMN tip_seq INTEGER NOT NULL DEFAULT 0;
