import { verifyUidSignature } from './ntag424/p224.ts';
import { SIM_ORIGINALITY_KEY } from './ntag424/sim/tag.ts';

/**
 * Stands in for `verifyOriginality` in tests: NXP's key signs real tags and the simulator signs with its own
 * (whose private half is a test constant). `vi.mock('./ntag424/originality.ts', () => import(...))` swaps it.
 */
export const verifyOriginality = (uid: Uint8Array, signature: Uint8Array): boolean =>
  verifyUidSignature(SIM_ORIGINALITY_KEY, uid, signature);
