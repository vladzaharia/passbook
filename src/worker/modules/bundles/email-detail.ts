import { distinguishingLine } from '../../../shared/pass-view/distinguish.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { parseStoredPassJson } from '../passes/detail.ts';
import { passJsonAtVersion } from '../public/repo.ts';

/** "Tier: Plus" per pass, so two passes with one title read apart in the email; null when none. */
export async function passDetails(
  ctx: ServiceContext,
  passes: readonly { id: string; version: number; displayTitle: string | null }[],
): Promise<(string | null)[]> {
  return Promise.all(
    passes.map(async (pass) => {
      const raw = await passJsonAtVersion(ctx.env.DB, pass.id, pass.version);
      return raw
        ? distinguishingLine(parseStoredPassJson(raw), pass.displayTitle ?? undefined)
        : null;
    }),
  );
}
