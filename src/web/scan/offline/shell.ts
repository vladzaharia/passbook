/**
 * The shell worker's registration and the session copy a cold start offline reads. Both exist only
 * for a door whose session uses an offline mode, and both go with the scanner on unpair or revoke.
 */
import { type ScanSession, ScanSessionSchema } from '../../../shared/contracts/scan-session.ts';
import { offlineModeOf } from '../../../shared/scan-offline.ts';
import { openScanDb } from './db.ts';
import { createIdbKeyValue, type KeyValue } from './wipe.ts';

const KEY = 'session';

async function meta(): Promise<KeyValue<unknown> | null> {
  try {
    return createIdbKeyValue(await openScanDb(), 'meta');
  } catch {
    // Storage blocked: there is no copy to keep or read, and the door falls back to Stop.
    return null;
  }
}

/** Keep the session without its CSRF token, or drop the copy when the session no longer uses offline. */
export async function keepSession(session: ScanSession): Promise<void> {
  const kv = await meta();
  if (!kv || !session.scanner) return;
  if (offlineModeOf(session.scanner.settings) === 'stop') await kv.remove(KEY);
  // No staff names are kept: a door that signs staff in has no offline start (`keptSession`).
  else await kv.set(KEY, { ...session, csrfToken: null, staff: null, staffList: null });
}

/** The kept session, only if it still parses and still asks for an offline mode. */
export async function keptSession(): Promise<ScanSession | null> {
  const parsed = ScanSessionSchema.safeParse(await (await meta())?.get(KEY));
  return parsed.success &&
    parsed.data.scanner &&
    !parsed.data.scanner.settings.staffSignIn &&
    offlineModeOf(parsed.data.scanner.settings) !== 'stop'
    ? parsed.data
    : null;
}
