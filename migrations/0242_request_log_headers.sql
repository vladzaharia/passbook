-- Allowlisted, non-secret request and response header values of a Test call, as JSON {"req":{...},"res":{...}}.
-- Null on rows written before this column and on calls with none. The row's retention and deletion apply.
ALTER TABLE request_log ADD COLUMN headers TEXT;
