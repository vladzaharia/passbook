-- A "Send test" attempt records which sample event it sent; NULL (older rows) reads as webhook.test.
ALTER TABLE webhook_attempts ADD COLUMN sample_type TEXT;
