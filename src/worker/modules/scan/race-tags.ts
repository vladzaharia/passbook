/** SQL comment tags that race tests match on, so a rewrite of a statement cannot silently disarm them. */
export const RACE_KEYSET = '/* race:keyset */';
export const RACE_EVENT_ROWS = '/* race:event-rows */';
export const RACE_EXPORT_COUNT = '/* race:export-count */';
export const RACE_GATE_WRITE = '/* race:gate-write */';
export { RACE_GRANT_INSERT, RACE_KEYSET_INSERT } from '../../platform/race-tag.ts';
export const RACE_MISS_COUNTER = '/* race:miss-counter */';
export const RACE_CANDIDATE_READ = '/* race:candidate-read */';
export const RACE_SEARCH_PAGE = '/* race:search-page */';
