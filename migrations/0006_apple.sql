-- The push token belongs to a registration, not to the shared (device, identity) row, so a pass of
-- one org cannot redirect the pushes of the same device's passes from another org.
ALTER TABLE registrations ADD COLUMN push_token TEXT;
UPDATE registrations SET push_token = (
  SELECT d.push_token FROM devices d
  WHERE d.device_id = registrations.device_id AND d.identity_id = registrations.identity_id
);
