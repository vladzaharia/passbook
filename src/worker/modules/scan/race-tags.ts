/** SQL comment tags that race tests match on, so a rewrite of a statement cannot silently disarm them. */
export const RACE_KEYSET = '/* race:keyset */';
export const RACE_EVENT_ROWS = '/* race:event-rows */';
export const RACE_EXPORT_COUNT = '/* race:export-count */';
export const RACE_GATE_WRITE = '/* race:gate-write */';
export { RACE_GRANT_INSERT, RACE_KEYSET_INSERT } from '../../platform/race-tag.ts';
export const RACE_MISS_COUNTER = '/* race:miss-counter */';
export const RACE_CANDIDATE_READ = '/* race:candidate-read */';
export const RACE_SEARCH_PAGE = '/* race:search-page */';

// Group A
export const RACE_HISTORY_PAGE = '/* race:history-page */';
export const RACE_STAFF_STARTS = '/* race:staff-starts */';
/** A RegExp matching a tag, for the interceptors that take one. */
export const tagRe = (tag: string) => new RegExp(tag.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&'));
// Group B
export const RACE_PRESENCE_WRITE = '/* race:presence-write */';
export const RACE_SCAN_CLAIM = '/* race:scan-claim */';
export const RACE_SCAN_UNDO = '/* race:scan-undo */';
export const RACE_GATE_SNAPSHOT = '/* race:gate-snapshot */';
// Group C
export const RACE_ORG_NAME = '/* race:org-name */';
export const RACE_STAFF_BIND = '/* race:staff-bind */';
export const RACE_STAFF_UNBIND = '/* race:staff-unbind */';
export const RACE_STAFF_PIN_ROTATE = '/* race:staff-pin-rotate */';
export const RACE_EVENT_PATCH = '/* race:event-patch */';
export const RACE_EVENT_ASSIGN = '/* race:event-assign */';
export const RACE_EVENT_BY_ID = '/* race:event-by-id */';
export const RACE_EVENT_TARGET = '/* race:event-target */';
export const RACE_EVENT_CACHE_FILL = '/* race:event-cache-fill */';
export const RACE_EVENT_CACHE_READ = '/* race:event-cache-read */';
export const RACE_SESSION_PATCH = '/* race:session-patch */';
export const RACE_SESSION_ROW = '/* race:session-row */';
export const RACE_EPOCH_STAFF = '/* race:epoch-staff */';
export const RACE_EPOCH_SESSION = '/* race:epoch-session */';
export const RACE_DEVICE_CAPABILITIES = '/* race:device-capabilities */';
export const RACE_DEVICE_DAY_CLEAR = '/* race:device-day-clear */';
export const RACE_PAIR_CODE = '/* race:pair-code */';
export const RACE_PAIR_CREDENTIAL = '/* race:pair-credential */';
export const RACE_GATES_OF_PASS = '/* race:gates-of-pass */';
export const RACE_TAG_BIND = '/* race:tag-bind */';
export { RACE_COUNTER_BUMP, RACE_PASS_INSERT } from '../../platform/race-tag.ts';
