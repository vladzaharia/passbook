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
// Group D
export const RACE_PASSLESS_READ = '/* race:passless-read */';
export const RACE_PASS_OK = '/* race:pass-ok */';
export const RACE_PREVIEW_CURRENT = '/* race:preview-current */';
export const RACE_PREVIEW_AUDIT = '/* race:preview-audit */';
export const RACE_PREDICATE_AUTHORIZED = '/* race:predicate-authorized */';
export const RACE_CARD_HISTORY = '/* race:card-history */';
export const RACE_LINEAGE = '/* race:lineage */';
export const RACE_PASS_FENCE = '/* race:pass-fence */';
export const RACE_SUMMARY_TOTALS = '/* race:summary-totals */';
export const RACE_RETENTION_PROOF = '/* race:retention-proof */';
export const RACE_BACKFILL_MARKER = '/* race:backfill-marker */';
export const RACE_BACKFILL_CANDIDATES = '/* race:backfill-candidates */';
export const RACE_BACKFILL_WRITE = '/* race:backfill-write */';
export const RACE_BACKFILL_DONE_WRITE = '/* race:backfill-done-write */';
export const RACE_APPROVAL_READ = '/* race:approval-read */';
export const RACE_BRANDING_READ = '/* race:branding-read */';
export const RACE_TEMPLATE_VERSION_READ = '/* race:template-version-read */';
// Group E
export const RACE_TOMBSTONE_CLEAR = '/* race:tombstone-clear */';
export const RACE_REPLAY_READ = '/* race:replay-read */';
export const RACE_EPOCH_EVENT = '/* race:epoch-event */';
export const RACE_TEMPLATE_VERSION_INSERT = '/* race:template-version-insert */';
export const RACE_TEMPLATE_CANDIDATE_INSERT = '/* race:template-candidate-insert */';
export const RACE_TEMPLATE_APPROVAL_INSERT = '/* race:template-approval-insert */';
export const RACE_TEMPLATE_RELEASE_INSERT = '/* race:template-release-insert */';
export const RACE_TEMPLATE_ASSIGN = '/* race:template-assign */';
export const RACE_TEMPLATE_STATUS = '/* race:template-status */';
export const RACE_PASS_PUBLISH = '/* race:pass-publish */';
