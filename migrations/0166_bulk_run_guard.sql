-- One active key-started bulk rebuild per org, mode and target: the guard is set on start and cleared when the run ends.
ALTER TABLE workflow_runs ADD COLUMN run_guard TEXT;
CREATE UNIQUE INDEX workflow_runs_run_guard ON workflow_runs (run_guard) WHERE run_guard IS NOT NULL;
