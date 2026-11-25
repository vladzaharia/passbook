import { ZERO16 } from '../bytes.ts';
import type { ProgramPlan } from './relay-server.ts';
import { SIM_ORIGINALITY_KEY } from './tag.ts';

/** Keys that differ in every slot and from the factory zeros. */
export const testKeys = (): Uint8Array[] =>
  Array.from({ length: 5 }, (_, i) => new Uint8Array(16).fill(0x11 * (i + 1)));

export const testPlan = (slug = 'k0000001', host = 'passbook.mobile'): ProgramPlan => ({
  keys: testKeys(),
  version: 3,
  host,
  slug,
  originalityKey: SIM_ORIGINALITY_KEY,
});

/** RndB, TI and padding from a counter: the same run gives the same bytes. */
export function countingRandom(): (n: number) => Uint8Array {
  let c = 0;
  return (n) => Uint8Array.from({ length: n }, () => (c = (c * 31 + 7) & 0xff));
}

export { ZERO16 };
