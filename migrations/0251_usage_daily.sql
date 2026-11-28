-- Usage counters (AD4). The domain tables are the ledger; these tables hold the monthly period of each org,
-- the local-day bounds that period gives, and one counter row per org, meter and local day.

-- One row per org and month. The zone is snapshotted when the period is created, so a zone change takes
-- effect from the next month. `utc_fallback` flags a period whose zone could not be used. `covered_to` is
-- how far `usage_day_bounds` reaches. `recount_closed_at` is set once the period after this one has closed:
-- until then retention keeps the rows a recount needs.
CREATE TABLE usage_periods (
  org_id TEXT NOT NULL,
  start_ms INTEGER NOT NULL CHECK (typeof(start_ms) = 'integer'),
  end_ms INTEGER NOT NULL CHECK (typeof(end_ms) = 'integer' AND end_ms > start_ms),
  month TEXT NOT NULL CHECK (month GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]'),
  time_zone TEXT NOT NULL,
  utc_fallback INTEGER NOT NULL DEFAULT 0 CHECK (utc_fallback IN (0, 1)),
  covered_to INTEGER NOT NULL DEFAULT 0,
  recount_closed_at INTEGER,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (org_id, start_ms)
) WITHOUT ROWID;
CREATE UNIQUE INDEX usage_periods_month ON usage_periods (org_id, month);

-- The instants one local day spans, [start_ms, end_ms), filled ahead by the minute hook.
CREATE TABLE usage_day_bounds (
  org_id TEXT NOT NULL,
  local_day TEXT NOT NULL CHECK (local_day GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  start_ms INTEGER NOT NULL,
  end_ms INTEGER NOT NULL CHECK (end_ms > start_ms),
  PRIMARY KEY (org_id, local_day)
) WITHOUT ROWID;
CREATE UNIQUE INDEX usage_day_bounds_start ON usage_day_bounds (org_id, start_ms);

-- `utc_fallback` is set on a day counted before its bounds existed: the day is then the UTC date.
CREATE TABLE usage_daily (
  org_id TEXT NOT NULL,
  meter TEXT NOT NULL,
  local_day TEXT NOT NULL CHECK (local_day GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  quantity INTEGER NOT NULL DEFAULT 0 CHECK (quantity >= 0),
  utc_fallback INTEGER NOT NULL DEFAULT 0 CHECK (utc_fallback IN (0, 1)),
  PRIMARY KEY (org_id, meter, local_day)
) WITHOUT ROWID;

-- A Live pass row that is not the replacement of an identity move counts as issued. Holder moves and
-- credential changes update a pass in place, so they never reach this trigger.
CREATE TRIGGER usage_passes_issued AFTER INSERT ON passes
WHEN NEW.mode = 'live' AND NOT EXISTS (SELECT 1 FROM pass_moves m WHERE m.new_pass_id = NEW.id)
BEGIN
  INSERT INTO usage_daily (org_id, meter, local_day, quantity, utc_fallback)
  SELECT NEW.org_id, 'passes_issued',
    COALESCE(d.local_day, strftime('%Y-%m-%d', NEW.created_at / 1000, 'unixepoch')), 1, d.local_day IS NULL
  FROM (SELECT 1) LEFT JOIN usage_day_bounds d
    ON d.org_id = NEW.org_id AND d.start_ms <= NEW.created_at AND d.end_ms > NEW.created_at
  WHERE true
  ON CONFLICT (org_id, meter, local_day) DO UPDATE
    SET quantity = quantity + 1, utc_fallback = MAX(utc_fallback, excluded.utc_fallback);
END;

-- An email row that reaches `sent` counts once, in the mode of its pass (no pass: Live). Cancelled, failed
-- and partial rows never count.
CREATE TRIGGER usage_emails_sent AFTER UPDATE OF state ON outbox
WHEN NEW.kind = 'email' AND NEW.state = 'sent' AND OLD.state != 'sent'
  AND COALESCE((SELECT p.mode FROM passes p WHERE p.id = NEW.pass_id), 'live') = 'live'
BEGIN
  INSERT INTO usage_daily (org_id, meter, local_day, quantity, utc_fallback)
  SELECT NEW.org_id, 'emails',
    COALESCE(d.local_day, strftime('%Y-%m-%d', COALESCE(NEW.finished_at, NEW.created_at) / 1000, 'unixepoch')), 1,
    d.local_day IS NULL
  FROM (SELECT 1) LEFT JOIN usage_day_bounds d
    ON d.org_id = NEW.org_id AND d.start_ms <= COALESCE(NEW.finished_at, NEW.created_at)
      AND d.end_ms > COALESCE(NEW.finished_at, NEW.created_at)
  WHERE true
  ON CONFLICT (org_id, meter, local_day) DO UPDATE
    SET quantity = quantity + 1, utc_fallback = MAX(utc_fallback, excluded.utc_fallback);
END;
