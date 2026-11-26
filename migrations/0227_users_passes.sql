-- A person's passes across organizations, newest first (users/repo-user-passes.ts): one bounded
-- index walk for the owner and one per verified address, each in id order.
CREATE INDEX passes_owner_live ON passes (owner_user_id, id)
  WHERE owner_user_id IS NOT NULL AND deleted_at IS NULL AND mode = 'live';
CREATE INDEX passes_waiting_live ON passes (holder_email, id)
  WHERE owner_user_id IS NULL AND holder_email IS NOT NULL AND deleted_at IS NULL AND mode = 'live';
