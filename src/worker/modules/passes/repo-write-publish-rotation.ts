import type { Grant } from '../../platform/authority.ts';
import { exists } from '../../platform/authority-cond.ts';

/** The mark a new scan code writes: the keyed hash of the code rotated out, and who rotated it. */
export interface ScanCodeRotation {
  oldCodeHash: string;
  rotatedAt: number;
  actorType: string;
  actorId: string | null;
}

/**
 * Adds the mark before the pass update (its trigger looks for it). It lands only while the pass is
 * still at `expectedVersion`, so a lost compare-and-swap leaves no mark behind.
 */
export function addRotationMark(
  g: Grant,
  passId: string,
  expectedVersion: number,
  r: ScanCodeRotation,
): void {
  g.insertSelect(
    'scan_code_rotations',
    ['pass_id', 'old_code_hash', 'new_version', 'rotated_at', 'actor_type', 'actor_id'],
    [passId, r.oldCodeHash, expectedVersion + 1, r.rotatedAt, r.actorType, r.actorId],
    { when: [exists('passes', { id: passId, version: expectedVersion })] },
  );
}
