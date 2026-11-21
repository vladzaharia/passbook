import { keyedDigest } from '../../platform/crypto.ts';
import { safeEqual } from '../../platform/ids.ts';

/** The MAC label of a TEST preview link. Never reuse it for another purpose. */
export const PREVIEW_LINK_LABEL = 'developer-preview.v1';
export const PREVIEW_LINK_TTL_MS = 30 * 24 * 3_600_000;
const HOUR_MS = 3_600_000;
const SHAPE = /^([A-Za-z0-9_-]{8,64})\.([0-9a-z]{1,6})\.([0-9a-z]{1,8})\.([0-9a-f]{32})$/;

/** What a link names: the pass and the link generation it was made under. */
export interface PreviewTarget {
  passId: string;
  linkGeneration: number;
}

const input = (t: PreviewTarget, gen: string, hour: string) => `${t.passId}.${gen}.${hour}`;

/**
 * `<pass id>.<link generation>.<issued hour>.<MAC>`, all base 36 where numeric. The MAC seals the three
 * under the key for `developer-preview.v1`, so a link cannot be made for another pass, kept alive past its
 * hour, or guessed from a pass id; a rotated pass link bumps the generation and retires every older preview
 * link. It holds nothing of the pass's own link token, so a preview link opens no other page. The hour is
 * the clock to expiry; issuing is truncated to the hour so a pass read twice in an hour shows one link.
 */
export async function mintPreviewLink(
  env: object,
  target: PreviewTarget,
  nowMs: number,
): Promise<string> {
  const gen = target.linkGeneration.toString(36);
  const hour = Math.floor(nowMs / HOUR_MS).toString(36);
  return `${target.passId}.${gen}.${hour}.${await keyedDigest(env, PREVIEW_LINK_LABEL, input(target, gen, hour))}`;
}

export type PreviewLink =
  | ({ state: 'ok' } & PreviewTarget)
  | { state: 'expired' }
  | { state: 'invalid' };

/** The MAC first, so an altered hour is `invalid`; only a genuine link can be `expired`. */
export async function checkPreviewLink(
  env: object,
  link: string,
  nowMs: number,
): Promise<PreviewLink> {
  const [, passId, gen, hour, mac] = SHAPE.exec(link) ?? [];
  if (!passId || !gen || !hour || !mac) return { state: 'invalid' };
  const target = { passId, linkGeneration: Number.parseInt(gen, 36) };
  const expected = await keyedDigest(env, PREVIEW_LINK_LABEL, input(target, gen, hour));
  if (!(await safeEqual(mac, expected))) return { state: 'invalid' };
  const issued = Number.parseInt(hour, 36) * HOUR_MS;
  return nowMs >= issued + PREVIEW_LINK_TTL_MS ? { state: 'expired' } : { state: 'ok', ...target };
}
