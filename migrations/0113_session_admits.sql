-- A session admits pass types and events in any mix: {"templateIds":[...],"eventIds":[...]}.
-- An event session's {"eventId":...} becomes that form; a template list is already one. The
-- config epoch trigger moves each rewritten session's epoch, so its devices re-read the scope.
UPDATE scanning_sessions
SET accepts = json_object('templateIds', json('[]'), 'eventIds', json_array(json_extract(accepts, '$.eventId')))
WHERE accepts IS NOT NULL AND json_valid(accepts) AND json_type(accepts, '$.eventId') = 'text';
