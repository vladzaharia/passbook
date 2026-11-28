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
