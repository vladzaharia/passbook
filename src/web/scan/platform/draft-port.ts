import type { ScanSession } from '../../../shared/contracts/scan-session.ts';
import type { ScanApi } from '../api/scan-api.ts';
import type { DraftPort } from '../machine/ports.ts';

/**
 * Only a paired scanner device shows a draft on the customer screens. An admin in setup mode (the
 * operator console beside a scanner's settings) never does, and neither does a customer screen.
 */
export function draftPortOf(session: ScanSession, api: ScanApi): DraftPort | undefined {
  if (session.principal !== 'scanner' || session.scanner?.deviceRole !== 'scan') return undefined;
  return {
    put: (body, o) => api.draftPut(body, o),
    clear: (ref, keep, o) => api.draftClear(ref, keep, o),
  };
}
