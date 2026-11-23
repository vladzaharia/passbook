import type { OpaqueEntry } from './authority-scope-opaque.ts';

/**
 * Pinned raw writes with an interpolation the fingerprint cannot expand (tools/authority-scope-opaque.ts).
 * `exprs` are the reviewed texts; `hash` covers the file, the files it imports, and `via` (fragment builders it does not import).
 * `node tools/authority-scope.ts --opaque` prints the current hashes.
 */
export const OPAQUE_ALLOWLIST: Record<string, OpaqueEntry> = {
  'src/worker/modules/scan/repo-scans.ts': {
    reason:
      'caller-built, parenthesized scan predicates (scan-predicate.ts); each write is pinned by its own id, state and at, and binds only the id',
    exprs: ['AMBIGUOUS_SCAN', 'extra.sql', 'original.sql', 'guard.sql'],
    hash: '382b7a3b9f64',
  },
  'src/worker/modules/scan/repo-act-claim.ts': {
    reason: 'caller-built scan predicate (scan-predicate.ts)',
    exprs: ['pristine.sql'],
    via: ['src/worker/modules/scan/scan-predicate.ts'],
    hash: '7c1c113797b0',
  },
  'src/worker/modules/scan/repo-counts.ts': {
    reason:
      'count and read-fence predicates from the scan read authority and counts query; release head SQL from templates',
    exprs: ['count.sql', 'fence.sql', 'effectiveReleaseIdSql(scope)'],
    hash: '67092fb5e017',
  },
  'src/worker/modules/events/repo.ts': {
    reason:
      'caller-supplied pass-read guard from wallet-providers/repo-holder-events.ts, parenthesized; org_id and the fence are literal in the statement',
    exprs: ['guard.sql'],
    via: ['src/worker/modules/wallet-providers/repo-holder-events.ts'],
    hash: '683b3eeaab94',
  },
  'src/worker/modules/passes/repo-remove-compensate.ts': {
    reason: 'removal proof SQL from repo-remove-snapshot.ts',
    exprs: ['proof.sql'],
    hash: 'b552e87d3ffc',
  },
  'src/worker/modules/passes/repo-connection-state.ts': {
    reason:
      'tightening-only optional fences from connectionPassFences, and the caller-supplied release fence',
    exprs: ['fences', 'fence.sql'],
    via: ['src/worker/modules/templates/repo-release-heads.ts'],
    hash: 'ce69d341c67e',
  },
  'src/worker/modules/passes/repo-history-assets.ts': {
    reason: 'pass, upload and candidate guards built in repo-history-image.ts',
    exprs: ['passWhere', 'uploadWhere', 'candidateWhere'],
    hash: '644628bc97bd',
  },
  'src/worker/modules/passes/repo-member-photo.ts': {
    reason: 'pass, upload and candidate guards built in repo-history-image.ts',
    exprs: ['passWhere', 'uploadWhere', 'candidateWhere'],
    hash: '2a84abe2db05',
  },
  'src/worker/modules/passes/repo-ops-retention.ts': {
    reason:
      'wallet retirement guard from wallet-providers/repo-sync-retention.ts; id, org_id and mode are literal',
    exprs: ["providerRetirementCompleteSql('passes.id')"],
    hash: '56313135471f',
  },
  'src/worker/modules/webhooks/repo-retention.ts': {
    reason:
      'org scope and eligibility SQL built in this file; the scope type comes from retention/repo-sweep.ts',
    exprs: ['e.sql'],
    hash: 'fca11714e120',
  },
  'src/worker/modules/retention/repo-sweep.ts': {
    reason: 'org scope, eligibility and legal-hold SQL built in this file',
    exprs: ['e.sql'],
    hash: '5d95e50a9a05',
  },
  'src/worker/modules/retention/repo-receipts.ts': {
    reason: 'receipt gate: a read-only count, vetted by assertSqlText',
    exprs: ['gate.sql'],
    hash: 'a2e81470adbc',
  },
};
