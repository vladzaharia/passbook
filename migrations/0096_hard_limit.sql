-- Hard limit on zones and events: when on, Full is final for every role.
ALTER TABLE scan_zones ADD COLUMN hard_limit INTEGER NOT NULL DEFAULT 0 CHECK (hard_limit IN (0, 1));
ALTER TABLE scan_events ADD COLUMN hard_limit INTEGER NOT NULL DEFAULT 0 CHECK (hard_limit IN (0, 1));
