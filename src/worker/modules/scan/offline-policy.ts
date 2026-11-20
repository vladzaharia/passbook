import { scanOf } from '../../../shared/scan-defaults.ts';
import {
  type OfflineVerdict,
  offlineModeOf,
  settingsOfflineVerdict,
} from '../../../shared/scan-offline.ts';
import { ConflictError, ValidationError } from '../../platform/errors.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { isNotFound, resolveTemplate } from '../passes/builder.ts';
import type { ScanActor } from './actor.ts';
import { scopeSessionId } from './actor.ts';
import { captureTemplateStamps } from './repo-scope-releases.ts';
import { sessionZoneIds } from './repo-zones.ts';

/**
 * Who may use the offline list, and which sessions may have one. The list is only as safe as this
 * gate: it names no one, but it lets a door admit with no server, so only sessions whose every action
 * is a plain check-in (once or daily) qualify. Access cards, value actions and zones stay online.
 */

const no = (code: string, message: string): OfflineVerdict => ({ ok: false, code, message });

/** Every template in scope has only check-in actions that repeat once or daily, and no access rules. */
async function templatesOfflineVerdict(
  ctx: ServiceContext,
  actor: ScanActor,
): Promise<OfflineVerdict> {
  const stamps = await captureTemplateStamps(
    ctx.env.DB,
    actor.orgId,
    actor.mode,
    actor.templateIds,
  );
  const bad = no(
    'OFFLINE_NEEDS_CHECK_IN',
    'Every action must be a check-in that repeats once or daily.',
  );
  if (!stamps || actor.templateIds.length === 0) return bad;
  const releases = new Map(stamps.releases.map((r) => [r.templateId, r.version] as const));
  const pinned = new Map(stamps.legacy.map((l) => [l.templateId, l.versions] as const));
  for (const id of actor.templateIds) {
    const legacy = pinned.get(id) ?? [];
    const version = releases.get(id) ?? (legacy.length === 1 ? legacy[0] : undefined);
    if (!version) return bad;
    try {
      const scan = scanOf((await resolveTemplate(ctx, actor.orgId, id, version)).manifest);
      if (
        scan.access ||
        !scan.actions.every(
          (a) => a.kind === 'check_in' && (a.repeat === 'once' || a.repeat === 'daily'),
        )
      )
        return bad;
    } catch (error) {
      if (isNotFound(error)) return bad;
      throw error;
    }
  }
  return { ok: true };
}

export async function offlineVerdict(
  ctx: ServiceContext,
  actor: ScanActor,
): Promise<OfflineVerdict> {
  const sessionId = scopeSessionId(actor);
  const zones = sessionId ? (await sessionZoneIds(ctx.env.DB, actor.orgId, sessionId)).length : 0;
  const byRules = settingsOfflineVerdict(actor.settings, zones);
  return byRules.ok ? templatesOfflineVerdict(ctx, actor) : byRules;
}

/**
 * A session's settings as saved: `offline` follows the chosen mode, and the list is refused where the
 * settings or zones already rule it out. Templates are checked when the roster is asked for.
 */
export function savedOfflineSettings<T extends ScanActor['settings']>(
  settings: T,
  zoneCount: number,
): T {
  const mode = offlineModeOf(settings);
  if (mode === 'list') {
    const verdict = settingsOfflineVerdict(settings, zoneCount);
    if (!verdict.ok) throw new ValidationError(verdict.message, [], verdict.code);
  }
  return { ...settings, offline: mode === 'list' };
}

/** Only a paired door uses the device routes: not an admin, not a till's API key. */
const pairedDoor = (actor: ScanActor) =>
  actor.principal === 'scanner' && actor.scanner?.kind === 'device' && !actor.apiKeyId;

/** The roster: the offline list is chosen, the actor is a paired door, and the session qualifies. */
export async function requireOfflineList(ctx: ServiceContext, actor: ScanActor): Promise<void> {
  if (!pairedDoor(actor) || offlineModeOf(actor.settings) !== 'list')
    throw new ConflictError('This session does not use an offline list.', 'OFFLINE_OFF');
  const verdict = await offlineVerdict(ctx, actor);
  if (!verdict.ok) throw new ConflictError(verdict.message, verdict.code);
}

/** The batch: any offline mode accepts queued reads; Stop refuses them all. */
export function requireOfflineQueue(actor: ScanActor): void {
  if (!pairedDoor(actor) || offlineModeOf(actor.settings) === 'stop')
    throw new ConflictError('This session does not take offline scans.', 'OFFLINE_OFF');
}
