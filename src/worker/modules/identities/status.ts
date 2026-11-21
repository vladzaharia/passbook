import type { IdentityStatus } from '../../../shared/contracts/identities.ts';
import type { IdentityRow } from './repo.ts';
import type { RunState } from './repo-runs.ts';

const DAY_MS = 86_400_000;
export const EXPIRING_DAYS = 30;
const OPEN: readonly RunState[] = ['queued', 'running', 'waiting'];

/** `identity:<id>` and `org:<id>` to the state of the newest run (see `latestRunStates`). */
export type RunStates = ReadonlyMap<string, RunState>;

/** What an admin reads of an identity: the certificate's date and the newest run decide. */
export function identityStatus(
  row: Pick<IdentityRow, 'id' | 'org_id' | 'issuing' | 'cert_pem' | 'not_after' | 'provenance'>,
  runs: RunStates,
  now: number,
): IdentityStatus {
  const own = runs.get(`identity:${row.id}`);
  const provision = row.org_id ? runs.get(`org:${row.org_id}`) : undefined;
  if (row.cert_pem === null && row.provenance === 'managed')
    return provision === 'failed' || provision === 'cancelled' ? 'failed' : 'provisioning';
  if (row.issuing === 0) return 'retired';
  if (row.not_after !== null && row.not_after < now) return 'expired';
  if (own === 'failed') return 'failed';
  if (own && OPEN.includes(own)) return 'renewing';
  if (row.not_after !== null && row.not_after - now <= EXPIRING_DAYS * DAY_MS) return 'expiring';
  return 'active';
}
