-- A channel-apply run opened by an entitlement change (design-multi-tenancy.md section 2.4) records the
-- channels the plan blocked before the change, as a JSON array. NULL: a template save, whose before and
-- after share the plan as it is. The run's passes are compared from that state to the plan now.
ALTER TABLE channel_apply_runs ADD COLUMN from_blocked TEXT CHECK (from_blocked IS NULL OR json_valid(from_blocked));
