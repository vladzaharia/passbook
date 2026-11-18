-- An invitee's sign-in link is valid only while its invitation is pending (auth/repo-magic.ts).
ALTER TABLE magic_links ADD COLUMN invitation_id TEXT REFERENCES org_invitations(id);
CREATE INDEX magic_links_invitation ON magic_links (invitation_id);
