import type { TagRead } from '../../../../shared/contracts/nfc-tags.ts';
import type { Recognised, TagAssurance, TagSystem } from './types.ts';
import { UID_SYSTEM } from './uid.ts';

/** `https://{host}/t/{slug}?p={32 hex}&m={16 hex}` (design 3.1). */
const SUN_URL =
  /^https:\/\/[^/?#]+\/t\/[^/?#]+\?(?=[^#]*\bp=[0-9a-f]{32}(?:&|$))[^#]*\bm=[0-9a-f]{16}(?:&|$)/i;

/** Secure: recognised by its URL so it is never read as a UID; it refuses until the SUN plugin (S3). */
const SUN_SYSTEM: TagSystem = {
  id: 'sun',
  assurance: 'secure',
  ready: false,
  recognise(read) {
    return read.ndef?.type === 'U' && SUN_URL.test(read.ndef.value) ? { system: 'sun' } : null;
  },
  identify: (env, orgId, mode, uid) => UID_SYSTEM.identify(env, orgId, mode, uid),
};

/** Order matters: a SUN URL is read before the UID (TS7). */
export const TAG_SYSTEMS: readonly TagSystem[] = [SUN_SYSTEM, UID_SYSTEM];

export function systemById(id: string): TagSystem | undefined {
  return TAG_SYSTEMS.find((s) => s.id === id);
}

/** The first system that claims the read. */
export function recogniseTag(read: TagRead): Recognised | null {
  for (const system of TAG_SYSTEMS) {
    const found = system.recognise(read);
    if (found) return found;
  }
  return null;
}

/** The assurance of a stored system id; an unknown id is treated as Secure so it never passes as Basic. */
export const assuranceOfSystem = (id: string): TagAssurance =>
  systemById(id)?.assurance ?? 'secure';
