import type { OpaqueEntry } from './authority-scope-opaque.ts';

/**
 * Pinned raw writes with an interpolation the fingerprint cannot expand (tools/authority-scope-opaque.ts).
 * `exprs` are the reviewed texts; `hash` covers the file and `deps`, the files whose SQL they build.
 * `node tools/authority-scope.ts --opaque` prints the current hashes.
 */
export const OPAQUE_ALLOWLIST: Record<string, OpaqueEntry> = {
  'src/worker/modules/scan/repo-scans.ts': {
    reason:
      'caller-built, parenthesized scan predicates (scan-predicate.ts); each write is pinned by its own id, state and at, and binds only the id',
    exprs: ['AMBIGUOUS_SCAN', 'extra.sql', 'original.sql', 'guard.sql'],
    deps: [
      'src/worker/modules/scan/scan-predicate.ts',
      'src/worker/modules/scan/scan-conjunction.ts',
    ],
    hash: 'bfe7b7feb00a',
  },
  'src/worker/modules/scan/repo-act-claim.ts': {
    reason: 'caller-built scan predicate (scan-predicate.ts)',
    exprs: ['pristine.sql'],
    deps: ['src/worker/modules/scan/scan-predicate.ts'],
    hash: '02783e2c9108',
  },
  'src/worker/modules/scan/repo-counts.ts': {
    reason:
      'count and read-fence predicates from the scan read authority and counts query; release head SQL from templates',
    exprs: ['count.sql', 'fence.sql', 'effectiveReleaseIdSql(scope)'],
    deps: [
      'src/worker/modules/templates/repo-release-heads.ts',
      'src/worker/modules/scan/repo-feed-scope.ts',
      'src/worker/modules/scan/repo-read-authority.ts',
      'src/worker/modules/scan/repo-counts-query.ts',
    ],
    hash: '1d7ff7871aa0',
  },
  'src/worker/modules/events/repo.ts': {
    reason:
      'caller-supplied pass-read guard from wallet-providers/repo-holder-events.ts, parenthesized; org_id and the fence are literal in the statement',
    exprs: ['guard.sql'],
    deps: ['src/worker/modules/wallet-providers/repo-holder-events.ts'],
    hash: 'dba79525715f',
  },
  'src/worker/modules/passes/repo-remove-compensate.ts': {
    reason: 'removal proof SQL from repo-remove-snapshot.ts',
    exprs: ['proof.sql'],
    deps: ['src/worker/modules/passes/repo-remove-snapshot.ts'],
    hash: '041bd8a55d08',
  },
  'src/worker/modules/passes/repo-connection-state.ts': {
    reason:
      'tightening-only optional fences from connectionPassFences, and the caller-supplied release fence',
    exprs: ['fences', 'fence.sql'],
    deps: [
      'src/worker/modules/passes/repo-connection-context.ts',
      'src/worker/modules/passes/repo-release.ts',
      'src/worker/modules/templates/repo-release-heads.ts',
    ],
    hash: '045cab578c73',
  },
  'src/worker/modules/passes/repo-history-assets.ts': {
    reason: 'pass, upload and candidate guards built in repo-history-image.ts',
    exprs: ['passWhere', 'uploadWhere', 'candidateWhere'],
    deps: ['src/worker/modules/passes/repo-history-image.ts'],
    hash: 'b94bdec33e6a',
  },
  'src/worker/modules/passes/repo-member-photo.ts': {
    reason: 'pass, upload and candidate guards built in repo-history-image.ts',
    exprs: ['passWhere', 'uploadWhere', 'candidateWhere'],
    deps: [
      'src/worker/modules/passes/repo-history-image.ts',
      'src/worker/modules/passes/repo-history-assets.ts',
    ],
    hash: '4b0090d55c07',
  },
  'src/worker/modules/passes/repo-ops-retention.ts': {
    reason:
      'wallet retirement guard from wallet-providers/repo-sync-retention.ts; id, org_id and mode are literal',
    exprs: ["providerRetirementCompleteSql('passes.id')"],
    deps: ['src/worker/modules/wallet-providers/repo-sync-retention.ts'],
    hash: 'd406ce5318a5',
  },
  'src/worker/modules/webhooks/repo-retention.ts': {
    reason:
      'org scope and eligibility SQL built in this file; the scope type comes from retention/repo-sweep.ts',
    exprs: ['e.sql'],
    deps: ['src/worker/modules/retention/repo-sweep.ts'],
    hash: '71ddd3d45231',
  },
  'src/worker/modules/retention/repo-sweep.ts': {
    reason: 'org scope, eligibility and legal-hold SQL built in this file',
    exprs: ['e.sql'],
    hash: '5beb472d6c70',
  },
  'src/worker/modules/retention/repo-receipts.ts': {
    reason: 'receipt gate: a read-only count, vetted by assertSqlText',
    exprs: ['gate.sql'],
    deps: ['src/worker/platform/authority-sqltext.ts'],
    hash: '6fe162fcf38e',
  },
};
