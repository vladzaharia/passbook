import type { z } from 'zod';
import {
  CHANNELS,
  type Channel,
  type ResetTemplatePassesResponseSchema,
} from '../../../shared/contracts/channels.ts';
import type { Mode } from '../../../shared/contracts/common.ts';
import { RateLimitedError } from '../../platform/errors.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import type { TenantPassWrite } from '../passes/http.ts';
import { getPass } from '../passes/repo-read-pass.ts';
import type { Actor } from '../passes/service.ts';
import type * as repo from './repo.ts';
import { overrideCounts, overridePage, overridePassCount } from './repo-reset.ts';
import { putPassChannels } from './service-write.ts';

type Response = z.infer<typeof ResetTemplatePassesResponseSchema>;

/** Passes one call resets: a request stays well inside the Worker's time. */
export const RESET_PAGE = 50;

/**
 * Passes of a template that carry their own channel choice go back to following it. Only the
 * channels with overrides are touched. One call resets a page; the caller repeats while `remaining`
 * is above 0. A pass at its hourly override limit is held back, not failed.
 */
export async function resetTemplatePasses(
  ctx: ServiceContext,
  actor: Actor,
  authority: TenantPassWrite,
  template: repo.TemplateRef,
  mode: Mode,
  body: { channels?: Channel[] | undefined; dryRun: boolean },
): Promise<Response> {
  const channels = body.channels ?? [...CHANNELS];
  const db = ctx.env.DB;
  const before = await overrideCounts(db, template.orgId, mode, template.id);
  const counts = Object.fromEntries(
    CHANNELS.map((c) => [c, channels.includes(c) ? (before[c] ?? 0) : 0]),
  ) as Record<Channel, number>;
  const total = (m: Record<Channel, number>) => CHANNELS.reduce((n, c) => n + (m[c] ?? 0), 0);
  const passes = await overridePassCount(db, template.orgId, mode, template.id, channels);
  if (body.dryRun || passes === 0)
    return { overrides: counts, passes, done: 0, skipped: 0, remaining: total(counts) };
  let done = 0;
  let skipped = 0;
  const page = await overridePage(db, template.orgId, mode, template.id, channels, RESET_PAGE);
  for (const item of page) {
    const pass = await getPass(db, item.passId, template.orgId);
    if (!pass) continue;
    try {
      await putPassChannels(ctx, actor, authority, pass, {
        channels: Object.fromEntries(item.channels.map((c) => [c, null])),
        notify: false,
        replaceCodes: false,
      });
      done += 1;
    } catch (error) {
      if (!(error instanceof RateLimitedError)) throw error;
      skipped += 1;
    }
  }
  const left = await overrideCounts(db, template.orgId, mode, template.id);
  const remaining = channels.reduce((n, c) => n + (left[c] ?? 0), 0);
  return { overrides: counts, passes, done, skipped, remaining };
}
