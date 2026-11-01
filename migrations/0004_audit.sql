-- action is matched by prefix with LIKE, which needs a NOCASE index.
CREATE INDEX audit_actor ON audit_log (actor_id, id DESC);
CREATE INDEX audit_action ON audit_log (action COLLATE NOCASE, id DESC);
