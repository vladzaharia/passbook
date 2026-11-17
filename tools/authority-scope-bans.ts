// Bans on the retired scan fence machinery (docs/design/authority-epochs.md section 5). Checked on every
// production file under src/worker by authority-scope.ts.
import type { Finding } from './authority-scope.ts';

/** Modules deleted with the snapshot fences; importing a path that ends in one of these is a finding. */
const DELETED_MODULES = [
  'sql-balance',
  'sql-tokens',
  'repo-secret-binds',
  'repo-actor-authority',
  'repo-actor-scanner-authority',
  'repo-actor-event-authority',
  'repo-actor-csrf-authority',
  'actor-csrf',
  'actor-csrf-proof',
  'repo-output-authority',
  'repo-output-predicates',
  'repo-output-predicate-stages',
  'repo-pass-predicates',
  'repo-pass-authority',
  'repo-pass-authority-prepared',
  'repo-session-read-predicate',
  'repo-session-read-event',
  'repo-session-authority',
  'repo-session-history-scope',
  'repo-scope-release-predicates',
  'repo-action-authority',
  'repo-act',
  'repo-act-claim-lifecycle',
];

const DELETED_IMPORT = new RegExp(`from\\s+'[^']*/(?:${DELETED_MODULES.join('|')})(?:\\.ts)?'`);

/** Only the keyset module itself and wallet-providers build on the raw keyset predicate. */
export const KEYSET_SQL_OWNERS = new Set([
  'src/worker/modules/passes/repo-credential-keyset.ts',
  'src/worker/modules/passes/repo-ops-retention.ts',
  'src/worker/modules/scan/repo-credential-tombstones.ts',
]);

export function scanBans(rel: string, text: string): Finding[] {
  const found: Finding[] = [];
  const ban = (detail: string) => found.push({ rule: 'banned', file: rel, detail });
  if (/scan-ephemeral/.test(text))
    ban('`scan-ephemeral` bind labels named placeholders for the deleted balancer');
  if (/json_extract\(\s*'\[\]'/.test(text))
    ban("`json_extract('[]'` was a packed-fence slot; bind the value");
  if (/\bcredentialRefKeysetSql\b/.test(text) && !KEYSET_SQL_OWNERS.has(rel))
    ban(
      'credentialRefKeysetSql is built on in passes/repo-credential-keyset.ts and wallet-providers/ only',
    );
  if (DELETED_IMPORT.test(text)) ban('imports a deleted fence module');
  if (/\bbalanceSql\w*\b/.test(text)) ban('stmt() no longer balances SQL; keep statements shallow');
  return found;
}
