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
    via: ['src/worker/platform/authority-statements.ts'],
    hash: 'a12f47971edb',
  },
  'src/worker/modules/scan/repo-act-claim.ts': {
    reason:
      'caller-built pristine claim fence: PristineClaimFence from repo-scans.ts, built in repo-act-attempt-authority.ts',
    exprs: ['pristine.sql'],
    via: [
      'src/worker/modules/scan/repo-scans.ts',
      'src/worker/modules/scan/repo-act-attempt-authority.ts',
    ],
    hash: 'ced0eddc957b',
  },
  'src/worker/modules/scan/repo-counts.ts': {
    reason:
      'count and read-fence predicates from the scan read authority and counts query; release head SQL from templates',
    exprs: ['count.sql', 'fence.sql', 'effectiveReleaseIdSql(scope)'],
    via: [
      'src/worker/platform/authority-read.ts',
      'src/worker/platform/authority-read-once.ts',
      'src/worker/modules/passes/repo-authority.ts',
      'src/worker/modules/scan/authority-checks.ts',
      'src/worker/modules/templates/repo-releases.ts',
      'src/worker/modules/scan/repo-event-match.ts',
      'src/worker/modules/scan/repo-wallet-snapshot.ts',
      'src/worker/modules/scan/repo-scan-passless.ts',
      'src/worker/modules/scan/repo-scan-retention.ts',
      'src/worker/platform/authority-statements.ts',
      'src/worker/modules/scan/outcome-bucket.ts',
    ],
    hash: 'd5ab1e5797ac',
  },
  'src/worker/modules/events/repo.ts': {
    reason:
      'caller-supplied pass-read guard from wallet-providers/repo-holder-events.ts, parenthesized; org_id and the fence are literal in the statement',
    exprs: ['guard.sql'],
    via: ['src/worker/modules/wallet-providers/repo-holder-events.ts'],
    hash: 'f1be1ee511c1',
  },
  'src/worker/modules/passes/repo-remove-compensate.ts': {
    reason: 'removal proof SQL from repo-remove-snapshot.ts',
    exprs: ['proof.sql'],
    hash: '041bd8a55d08',
  },
  'src/worker/modules/passes/repo-connection-state.ts': {
    reason:
      'tightening-only optional fences from connectionPassFences, and the caller-supplied release fence',
    exprs: ['fences', 'fence.sql'],
    via: ['src/worker/modules/templates/repo-release-heads.ts'],
    hash: 'b1d5f4260a65',
  },
  'src/worker/modules/passes/repo-history-assets.ts': {
    reason: 'pass, upload and candidate guards built in repo-history-image.ts',
    exprs: ['passWhere', 'uploadWhere', 'candidateWhere'],
    via: ['src/worker/modules/passes/repo-authority.ts'],
    hash: 'f794a8c86ec3',
  },
  'src/worker/modules/passes/repo-member-photo.ts': {
    reason: 'pass, upload and candidate guards built in repo-history-image.ts',
    exprs: ['passWhere', 'uploadWhere', 'candidateWhere'],
    via: ['src/worker/modules/passes/repo-authority.ts'],
    hash: '926ac2322c1b',
  },
  'src/worker/modules/passes/repo-ops-retention.ts': {
    reason:
      'wallet retirement guard from wallet-providers/repo-sync-retention.ts; id, org_id and mode are literal',
    exprs: ["providerRetirementCompleteSql('passes.id')"],
    via: [
      'src/worker/modules/developer/fence.ts',
      'src/worker/modules/passes/repo-history-image.ts',
      'src/worker/modules/scan/scan-conjunction.ts',
    ],
    hash: 'c10c576778bb',
  },
  'src/worker/modules/webhooks/repo-retention.ts': {
    reason:
      'org scope and eligibility SQL built in this file; the scope type comes from retention/repo-sweep.ts',
    exprs: ['e.sql'],
    hash: '612a9d06ad38',
  },
  'src/worker/modules/retention/repo-sweep.ts': {
    reason: 'org scope, eligibility and legal-hold SQL built in this file',
    exprs: ['e.sql'],
    hash: 'b37360bf2f15',
  },
  'src/worker/modules/retention/repo-receipts.ts': {
    reason: 'receipt gate: a read-only count, vetted by assertSqlText',
    exprs: ['gate.sql'],
    hash: '6fe162fcf38e',
  },
};
