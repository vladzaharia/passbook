import type { StampsManifest } from '../types.ts';
import { COMPOSITOR_VERSION } from './compose.ts';

const hex = (buf: ArrayBuffer) =>
  [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');

/**
 * What the drawn strips depend on: the engine, the goal, the tilt, and the SHA-1 of each art file
 * and base strip (`sha1Of` maps a package file name to it). Two versions with the same key draw
 * the same bytes, so a save carries the earlier strips instead of drawing them again.
 */
export async function stampKey(
  block: StampsManifest,
  sha1Of: (name: string) => string | undefined,
): Promise<string> {
  const file = (name: unknown) => (typeof name === 'string' ? (sha1Of(name) ?? null) : null);
  const art: Partial<StampsManifest['art']> = block.art ?? {};
  const parts = [
    COMPOSITOR_VERSION,
    block.goal,
    block.tilt !== false,
    file(art.filled),
    file(art.empty),
    file(art.reward),
    file(art.rewardEarned),
    file('strip@2x.png'),
    file('strip@3x.png'),
  ];
  const bytes = new TextEncoder().encode(JSON.stringify(parts));
  return hex(await crypto.subtle.digest('SHA-256', bytes));
}
