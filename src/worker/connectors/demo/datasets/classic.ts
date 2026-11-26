import type { UpstreamRecord } from '../../types.ts';

const TIERS = ['Bronze', 'Silver', 'Gold', 'Platinum'];

/** Same hash as v1: classic records must stay byte-identical. */
function hash(text: string): number {
  let h = 2166136261;
  for (const ch of text) h = Math.imul(h ^ ch.charCodeAt(0), 16777619) >>> 0;
  return h;
}

export function classicRef(index: number): string {
  return `m-${String(index).padStart(3, '0')}`;
}

export const CLASSIC_FIELDS = {
  memberName: { type: 'string' },
  memberId: { type: 'string' },
  status: { type: 'string' },
  tier: { type: 'string' },
  points: { type: 'number' },
  guests: { type: 'number' },
  email: { type: 'string' },
} as const;

export function buildClassic(
  c: { seed: string; revision: number; holderDomain: string },
  ref: string,
): { record: UpstreamRecord; holderEmail: string } {
  const h = hash(`${c.seed}:${ref}`);
  return {
    record: {
      memberName: `Member ${ref.toUpperCase()}`,
      memberId: ref,
      status: h % 7 === 0 ? 'inactive' : 'active',
      tier: TIERS[h % TIERS.length] ?? 'Bronze',
      points: (h % 1000) + c.revision * 10,
      // Guests left (0 to 9) also moves with the revision: a visible input a resync changes.
      guests: (h + c.revision) % 10,
      email: `${ref}@${c.holderDomain}`,
    },
    holderEmail: `${ref}@${c.holderDomain}`,
  };
}
