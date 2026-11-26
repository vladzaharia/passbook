import type { PlatformIdentity } from './platform-queries.ts';

export interface ReadyCheck {
  id: string;
  label: string;
  ok: boolean;
}

/** The server's readiness facts as a checklist; a check the row is not held to (null) is left out. */
export function readiness(row: PlatformIdentity): ReadyCheck[] {
  const r = row.readiness;
  const checks: [string, string, boolean | null][] = [
    ['issuing', 'Issuing', r.issuing],
    ['certificate', 'Certificate', r.certificate],
    ['push', 'Push healthy', r.pushHealthy],
    ['probe', 'Push checked in 24 h', r.pushProbeFresh],
    ['device', 'Device test', r.deviceTest],
  ];
  return checks.flatMap(([id, label, ok]) => (ok === null ? [] : [{ id, label, ok }]));
}

/** Only a passes identity that is not already the default is offered. */
export const canMakeDefault = (row: PlatformIdentity): boolean =>
  !row.isDefault && row.readiness.eligible && row.status !== 'retired' && row.status !== 'failed';
