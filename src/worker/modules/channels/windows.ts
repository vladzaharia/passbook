import type { ChannelWindow } from '../../../shared/contracts/channels.ts';
import type { Mode } from '../../../shared/contracts/common.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import {
  activeHold,
  nextScheduledOpen,
  sessionWindow,
  storedHours,
} from '../scan/session-hours.ts';
import { activeSessions, eventIdsOf, eventsOf } from './repo-replace.ts';

const HOUR = 3_600_000;
export const WINDOW_HORIZON_MS = 48 * HOUR;

/** Whether a session's `accepts` admits the template (both shapes: templates, events; null: everything). */
function admits(
  accepts: string | null,
  templateId: string,
  eventIds: ReadonlySet<string>,
): boolean {
  if (accepts === null) return true;
  let a: unknown;
  try {
    a = JSON.parse(accepts);
  } catch {
    return false;
  }
  if (typeof a !== 'object' || a === null) return false;
  const { templateIds, eventIds: ids, eventId } = a as Record<string, unknown>;
  if (Array.isArray(templateIds) && templateIds.includes(templateId)) return true;
  if (Array.isArray(ids) && ids.some((id) => typeof id === 'string' && eventIds.has(id)))
    return true;
  return typeof eventId === 'string' && eventIds.has(eventId);
}

/**
 * Events and scanning sessions that admit the template and are open now or open within the horizon.
 * A session with no hours (and no hold) is 24/7: it is listed as a warning and never counts as open.
 */
export async function openWindows(
  ctx: ServiceContext,
  orgId: string,
  mode: Mode,
  templateId: string,
  now: number,
  horizon = WINDOW_HORIZON_MS,
): Promise<ChannelWindow[]> {
  const db = ctx.env.DB;
  const [events, sessions, eventIds] = await Promise.all([
    eventsOf(db, orgId, mode, templateId, now, now + horizon),
    activeSessions(db, orgId, mode),
    eventIdsOf(db, orgId, mode, templateId),
  ]);
  const out: ChannelWindow[] = events.map((e) => ({
    kind: 'event',
    id: e.id,
    name: e.name,
    opensAt: e.opens_at,
    closesAt: e.closes_at,
    open: e.opens_at <= now,
    scheduled: true,
  }));
  const ids = new Set(eventIds);
  for (const s of sessions) {
    if (!admits(s.accepts, templateId, ids)) continue;
    const scheduled = storedHours(s.hours) !== null || activeHold(s.hold, now) !== null;
    if (!scheduled) {
      out.push({
        kind: 'session',
        id: s.id,
        name: s.name,
        opensAt: null,
        closesAt: null,
        open: false,
        scheduled,
      });
      continue;
    }
    const w = sessionWindow(s, now);
    if (w.open) {
      out.push({
        kind: 'session',
        id: s.id,
        name: s.name,
        opensAt: null,
        closesAt: w.closesAt,
        open: true,
        scheduled,
      });
      continue;
    }
    const next = nextScheduledOpen(s, now);
    if (next !== null && next - now <= horizon)
      out.push({
        kind: 'session',
        id: s.id,
        name: s.name,
        opensAt: next,
        closesAt: null,
        open: false,
        scheduled,
      });
  }
  return out;
}

/** The window that stops a save or a rotation, if one is open. */
export const blockingWindow = (windows: readonly ChannelWindow[]): ChannelWindow | undefined =>
  windows.find((w) => w.open && w.scheduled);

/** When every open window has closed (or `fallback` while an end is unknown). */
export function windowsCloseAt(windows: readonly ChannelWindow[], fallback: number): number {
  const open = windows.filter((w) => w.open && w.scheduled);
  return open.reduce((at, w) => Math.max(at, w.closesAt ?? fallback), 0);
}
