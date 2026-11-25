-- A person may delete their sandbox and make a new one. The record stays until its org is closed (the delete closes
-- it first, in the same batch), so a live sandbox is still never dropped by accident.
DROP TRIGGER developer_sandboxes_no_delete;
CREATE TRIGGER developer_sandboxes_no_delete BEFORE DELETE ON developer_sandboxes
WHEN NOT EXISTS (SELECT 1 FROM orgs o WHERE o.id = OLD.org_id AND o.status = 'deleted')
BEGIN SELECT RAISE(ABORT, 'a developer sandbox is kept until its org is closed'); END;
