import type { PlatformIdentity } from './platform-queries.ts';

export const PROBE_FRESH_MS = 86_400_000;

export interface ReadyCheck {
  id: string;
  label: string;
  ok: boolean;
}

/** The identity signs and its certificate has not run out. */
const certificateOk = (row: PlatformIdentity, now: number) =>
  row.certSha256 !== null && (row.notAfter === null || row.notAfter > now);

/** The legacy identity needs only its certificate; the others also need push and a device test. */
export function readiness(row: PlatformIdentity, now: number): ReadyCheck[] {
  const certificate = { id: 'certificate', label: 'Certificate', ok: certificateOk(row, now) };
  if (row.slot === null) return [certificate];
  return [
    { id: 'issuing', label: 'Issuing', ok: row.issuing },
    certificate,
    { id: 'push', label: 'Push healthy', ok: row.apnsHealth === 'healthy' },
    {
      id: 'probe',
      label: 'Push checked in 24 h',
      ok: row.apnsCheckedAt !== null && row.apnsCheckedAt >= now - PROBE_FRESH_MS,
    },
    // A device registered one of its passes; the server also requires it to be a platform admin's personal org.
    { id: 'device', label: 'Device test', ok: row.registrationCount > 0 },
  ];
}

/** Only a passes identity that is not already the default is offered. */
export const canMakeDefault = (row: PlatformIdentity): boolean =>
  !row.isDefault && row.purpose === 'passes' && row.status !== 'retired' && row.status !== 'failed';
