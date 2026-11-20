-- Foreign-key child columns the roll call (0122) and bundle check-in (0123) tables left unindexed.
CREATE INDEX roll_call_marks_pass ON roll_call_marks (pass_id);
CREATE INDEX scan_group_members_org ON scan_group_members (org_id);
