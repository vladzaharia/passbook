-- Workbench v2 (S1): a member token's generation per session. `DELETE /workbench/token` bumps it, which ends every
-- member token the session minted; sign-out ends them through the session row. Sandbox tokens keep
-- developer_sandboxes.try_generation. No org, mode or pass column: the token's org is checked against the membership.
CREATE TABLE workbench_token_epochs (
  session_id_hash TEXT PRIMARY KEY,
  generation INTEGER NOT NULL CHECK (generation >= 0),
  changed_at INTEGER NOT NULL
);
