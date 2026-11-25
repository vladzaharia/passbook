-- Visitor management left the platform (owner decision 2026-11-24): the visitors table and every
-- row in it go, irreversibly. Nothing else references the table. Children first: the trigger and
-- the index, then the table.
DROP TRIGGER IF EXISTS visitors_developer_no_live;
DROP INDEX IF EXISTS visitors_window;
DROP TABLE IF EXISTS visitors;
