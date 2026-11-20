import type { TagRead } from '../../../../shared/contracts/nfc-tags.ts';
import { SUN_SYSTEM } from './sun.ts';
import type { Recognised, TagAssurance, TagEnv, TagSystem } from './types.ts';
import { UID_SYSTEM } from './uid.ts';

/** Order matters: a SUN URL is read before the UID (TS7). */
export const TAG_SYSTEMS: readonly TagSystem[] = [SUN_SYSTEM, UID_SYSTEM];

export function systemById(id: string): TagSystem | undefined {
  return TAG_SYSTEMS.find((s) => s.id === id);
}

/** The first system that claims the read. */
export function recogniseTag(read: TagRead, env: TagEnv): Recognised | null {
  for (const system of TAG_SYSTEMS) {
    const found = system.recognise(read, env);
    if (found) return found;
  }
  return null;
}

/** The assurance of a stored system id; an unknown id is treated as Secure so it never passes as Basic. */
export const assuranceOfSystem = (id: string): TagAssurance =>
  systemById(id)?.assurance ?? 'secure';
