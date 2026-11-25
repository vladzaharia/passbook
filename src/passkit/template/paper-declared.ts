/** What the template itself says about its times and check-in, for the ticket's start, end and one-use line. */
import type { Personalization, TemplateManifest } from '../types.ts';
import { ISO } from './paper-kinds.ts';

type Manifest = Pick<TemplateManifest, 'behaviors' | 'scan'>;
const plain = (v: unknown): string | undefined =>
  typeof v === 'string' || typeof v === 'number' ? String(v).trim() || undefined : undefined;

export function checkInOnce(manifest: Manifest): boolean {
  const actions = (manifest.scan as { actions?: { kind?: string; repeat?: string }[] } | undefined)
    ?.actions;
  return actions?.find((a) => a.kind === 'check_in')?.repeat === 'once';
}

const START_INPUTS = ['startsAt', 'departsAt', 'checkIn', 'validFrom'];
const END_INPUTS = ['endsAt', 'checkOut'];

/**
 * The start and end the author's inputs name. Arrival is left out (it is in another zone) and so
 * is `validUntil`, which paper prints as the validity. A `relevance-window` behavior's own start
 * input covers other names.
 */
export function declaredTimes(manifest: Manifest, personalization: Personalization) {
  const window = manifest.behaviors?.find((b) => b.use === 'relevance-window')?.config as
    | { start?: unknown }
    | undefined;
  const read = (names: (string | unknown)[]) => {
    for (const n of names) {
      const v = typeof n === 'string' ? plain(personalization[n]) : undefined;
      if (v && ISO.test(v)) return v;
    }
    return undefined;
  };
  return { start: read([...START_INPUTS, window?.start]), end: read(END_INPUTS) };
}
