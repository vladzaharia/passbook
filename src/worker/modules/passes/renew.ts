import {
  parseTermDate,
  renewedStart,
  termConfigOf,
} from '../../../passkit/behaviors/term/index.ts';
import { ConflictError } from '../../platform/errors.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { recordAudit } from '../audit/service.ts';
import { getOrgSettings } from '../settings/service.ts';
import { resolveTemplate } from './builder.ts';
import { detailOf } from './detail.ts';
import type { TenantPassWrite } from './http.ts';
import { getPassForWrite } from './pass-access.ts';
import { publishPass } from './publish.ts';
import { getPass } from './repo-read-pass.ts';
import type { ScopeArg } from './scope.ts';
import type { Actor } from './service.ts';

const cause = (actor: Actor) => (actor.type === 'api_key' ? 'api' : 'admin');
const iso = (ms: number) => new Date(ms).toISOString();

/**
 * Renews a pass's term. Renewed on or before the end, the next term runs on from the current end
 * and keeps the original day of the month; renewed after it, the term starts now and takes now's
 * day (`renewedStart`). Reads the start fresh on every publish attempt.
 */
export async function renewPass(
  ctx: ServiceContext,
  actor: Actor,
  passId: string,
  options: { scope: ScopeArg; authority?: TenantPassWrite },
) {
  const pass = await getPassForWrite(ctx.env.DB, passId, options.scope);
  const template = await resolveTemplate(ctx, pass.orgId, pass.templateId, pass.templateVersion);
  const config = termConfigOf(template.manifest);
  if (!config) throw new ConflictError('This pass has no term.', 'TERM_NONE');
  const tz = config.timeZone ?? (await getOrgSettings(ctx, pass.orgId))['org.timeZone'];
  const now = ctx.clock.now();
  const moved = { from: '', to: '' };
  const result = await publishPass(ctx, {
    passId,
    orgScope: options.scope,
    cause: cause(actor),
    actor,
    ...(options.authority ? { authority: options.authority } : {}),
    mutate: (current) => {
      if (current.templateVersion !== template.version)
        throw new ConflictError('The pass changed. Reload and retry.', 'PASS_CONFLICT');
      if (current.fieldSources[config.start] === 'connection')
        throw new ConflictError('A connection sets the start.', 'TERM_MANAGED');
      const raw = current.personalization[config.start];
      if (typeof raw !== 'string' || raw === '')
        throw new ConflictError('The term has not started.', 'TERM_NOT_STARTED');
      const anchorRaw = config.anchor ? current.personalization[config.anchor] : undefined;
      const next = renewedStart(
        parseTermDate(raw, config.start, tz),
        { ...config, timeZone: tz },
        now,
        typeof anchorRaw === 'string' && anchorRaw !== ''
          ? parseTermDate(anchorRaw, config.anchor ?? '', tz)
          : undefined,
      );
      moved.from = raw;
      moved.to = iso(next.start);
      return {
        personalization: {
          ...current.personalization,
          [config.start]: iso(next.start),
          ...(config.anchor ? { [config.anchor]: iso(next.anchor) } : {}),
        },
        fieldSources: {
          ...current.fieldSources,
          [config.start]: 'manual',
          ...(config.anchor ? { [config.anchor]: 'manual' } : {}),
        },
      };
    },
  });
  await recordAudit(ctx, {
    orgId: result.pass.orgId,
    actorType: actor.type,
    actorId: actor.id,
    action: 'pass.term.renew',
    targetType: 'pass',
    targetId: passId,
    detail: { ...moved, published: result.changed },
  });
  return detailOf(
    ctx,
    (await getPass(ctx.env.DB, passId, options.scope)) ?? result.pass,
    options.authority,
  );
}
