import type { ResolvedTemplate } from '../../../passkit/template/registry.ts';
import type { PassJson, Personalization } from '../../../passkit/types.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { isNotFound, resolveTemplate } from './builder.ts';
import { boundarySource } from './repo-boundaries.ts';
import { timedPassJson } from './timed-pass.ts';

/** A pass's latest artifact pass.json, its input, and its template when its events can move. */
export interface TimedSource {
  built: PassJson;
  personalization: Personalization;
  /** Null when the artifact lists no events, or the template is gone (the default event length then). */
  template: ResolvedTemplate | null;
}

export async function readTimedSource(
  ctx: ServiceContext,
  passId: string,
): Promise<TimedSource | null> {
  const source = await boundarySource(ctx.env.DB, passId);
  if (!source || source.passJson === null) return null;
  let built: PassJson;
  try {
    built = JSON.parse(source.passJson) as PassJson;
  } catch (error) {
    ctx.log.warn('pass.timed_source_unreadable', { passId, code: 'PASS_JSON_INVALID', error });
    return null;
  }
  const personalization = JSON.parse(source.personalization) as Personalization;
  if (!source.passJson.includes('"upcomingPassInformation"'))
    return { built, personalization, template: null };
  try {
    const template = await resolveTemplate(
      ctx,
      source.orgId,
      source.templateId,
      source.templateVersion,
    );
    return { built, personalization, template };
  } catch (error) {
    // A template that is gone keeps the pass as built; anything else retries the caller.
    if (!isNotFound(error)) throw error;
    ctx.log.warn('pass.timed_template_missing', { passId, code: 'TEMPLATE_NOT_FOUND' });
    return { built, personalization, template: null };
  }
}

/**
 * `timedPassJson`, or the pass as built when the behavior now refuses its input (a later code change):
 * a wallet card then shows what was published instead of failing.
 */
export function timedOrBuilt(
  ctx: ServiceContext,
  passId: string,
  built: PassJson,
  personalization: Personalization,
  template: ResolvedTemplate,
  at: number,
): PassJson {
  try {
    return timedPassJson(built, personalization, template, at);
  } catch (error) {
    ctx.log.warn('pass.timed_invalid', { passId, code: 'TIMED_PASS_INVALID', error });
    return built;
  }
}
