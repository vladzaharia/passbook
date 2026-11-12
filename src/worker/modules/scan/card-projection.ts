import {
  actionGoals,
  type ScanDisplayScope,
} from '../../../passkit/template/scan-display/index.ts';
import { validityOf } from '../../../shared/pass-view/validity.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import {
  pick,
  safeJson,
  safeTimestamp,
  visibleAction,
  visibleFields,
  visibleHistory,
  visibleIdentity,
  visibleScan,
} from './card-semantics.ts';
import type { BuildDisplayInput } from './display.ts';
import { isOwnPhotoUrl } from './display-photo-url.ts';
import { cardPrivacy } from './dto-projection.ts';
import { projectScanInputs } from './projection-privacy.ts';
import type { Found } from './resolve.ts';

/** Build the scope before rendering: secrets and fields above the actor's role never enter it. */
export function scopeOf(
  ctx: ServiceContext,
  input: BuildDisplayInput,
  found: Found,
): ScanDisplayScope {
  const { actor } = input;
  const { pass, passJson, template } = found;
  const manifest = template.manifest;
  const role = actor.role ?? 'door';
  const validity = validityOf(passJson, ctx.clock.now());
  const privacy = cardPrivacy(found, actor);
  const names = visibleIdentity(found, actor, privacy);
  const safe = (value: unknown) => safeJson(found, actor, value, privacy);
  const safeTime = (value: number | null) =>
    value !== null && safeTimestamp(found, actor, privacy, value) ? value : null;
  const actions = found.scan.actions.filter((action) =>
    visibleAction(found, actor, action, privacy),
  );
  const goals = actionGoals({ scan: { actions } });
  return {
    inputs: safe(projectScanInputs(found, actor)) ?? {},
    fields: visibleFields(found, actor),
    pass: {
      title: safe(names.title) ?? '',
      subtitle: safe(names.subtitle) ?? null,
      status: safe(validity.status) ?? null,
      statusLabel: safe(validity.status) ?? null,
      validFrom: safeTime(validity.validFrom),
      validUntil: safeTime(validity.validUntil),
      createdAt: safeTime(pass.createdAt),
      version: safe(pass.version) ?? null,
      templateName: safe(found.ref.name) ?? '',
      style: safe(found.ref.style) ?? '',
      externalId: null,
    },
    scan: visibleScan(ctx, input, found),
    history: visibleHistory(found, actor, input.history),
    event: actor.event
      ? (safeJson(
          found,
          actor,
          pick(actor.event, ['name', 'opensAt', 'closesAt', 'capacity']),
          privacy,
          true,
        ) ?? null)
      : null,
    scanner: { name: safe(actor.name) ?? '', role },
    lookups: safe(manifest.lookups ?? {}) ?? {},
    goals: safe(goals) ?? {},
    assets:
      input.photoUrl && actor.settings.showPhoto !== false && isOwnPhotoUrl(input.photoUrl)
        ? { photo: input.photoUrl }
        : {},
    templateVersion: safe(String(template.version)) ?? '',
    now: safeTime(ctx.clock.now()) ?? undefined,
  };
}
