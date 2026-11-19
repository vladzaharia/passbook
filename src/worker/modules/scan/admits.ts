import {
  type Admits,
  AdmitsSchema,
  admitsOf,
  admitsWire,
} from '../../../shared/contracts/scanners.ts';
import type { Pass } from '../passes/repo-map.ts';
import type { ScanActor } from './actor.ts';
import { eventMatch } from './repo-event-match.ts';
import type { EventScope } from './repo-scope.ts';

/** A stored `accepts`: null admits any pass type; undefined when it does not parse. */
export function storedAdmits(raw: string | null): Admits | null | undefined {
  if (raw === null) return null;
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    // Unreadable JSON is an invalid scope; every caller fails closed on it.
    return undefined;
  }
  // Strict shapes: anything extra is not a scope this code wrote.
  const parsed = AdmitsSchema.safeParse(value);
  if (!parsed.success) return undefined;
  return admitsOf(parsed.data);
}

/**
 * The stored form: a single shape stays in the older one-key form, which a Worker that predates
 * Admits still reads; only a mix is stored as both lists.
 */
export const admitsJson = (admits: Admits): string => JSON.stringify(admitsWire(admits));

/** An event takes a pass by its org, mode, archive state and pass filter. */
export function eventAcceptsPass(
  actor: Pick<ScanActor, 'orgId' | 'mode'>,
  event: NonNullable<ScanActor['event']>,
  pass: Pass,
): boolean {
  if (event.orgId !== actor.orgId || event.mode !== actor.mode || event.archivedAt !== null)
    return false;
  const match = eventMatch(event.matchInput, event.matchValues);
  if (!match) return false;
  if (match.input === null) return true;
  if (!Object.hasOwn(pass.personalization, match.input)) return false;
  const value = pass.personalization[match.input];
  if (typeof value === 'boolean') return match.values.includes(value ? '1' : '0');
  return (
    (typeof value === 'string' || (typeof value === 'number' && Number.isFinite(value))) &&
    match.values.includes(String(value))
  );
}

/**
 * The entry of a mixed scope that admits the pass: an event that takes it (the one open now, then
 * the earliest close), else the template entries. Null when none does.
 */
function admittingEntry(
  actor: ScanActor,
  pass: Pass,
  now: number,
): EventScope | 'templates' | null {
  const taking = (actor.events ?? []).filter(
    (scope) =>
      scope.templateIds.includes(pass.templateId) && eventAcceptsPass(actor, scope.event, pass),
  );
  const open = (scope: EventScope) => scope.event.opensAt <= now && now <= scope.event.closesAt;
  const [best] = taking.sort(
    (a, b) =>
      Number(open(b)) - Number(open(a)) ||
      a.event.closesAt - b.event.closesAt ||
      (a.event.id < b.event.id ? -1 : 1),
  );
  if (best) return best;
  return actor.entryTemplateIds?.includes(pass.templateId) ? 'templates' : null;
}

export function matchesEvent(actor: ScanActor, pass: Pass): boolean {
  if (actor.events) return admittingEntry(actor, pass, 0) !== null;
  return actor.event ? eventAcceptsPass(actor, actor.event, pass) : true;
}

/** The mixed scope an actor has or was narrowed from; null for a single-shape scope. */
export function admitsIdentity(actor: ScanActor): ScanActor['admittedFrom'] | null {
  if (actor.admittedFrom) return actor.admittedFrom;
  if (!actor.events) return null;
  return {
    templateIds: [...actor.templateIds].sort(),
    eventIds: actor.events.map((s) => s.event.id).sort(),
    timeZone: actor.timeZone,
  };
}

/** One entry of a mixed scope, as a single-shape actor. Spread keeps the captured epochs. */
function narrowed(actor: ScanActor, entry: EventScope | 'templates'): ScanActor {
  const admittedFrom = admitsIdentity(actor) ?? undefined;
  const { events: _events, entryTemplateIds, ...single } = actor;
  return entry === 'templates'
    ? { ...single, admittedFrom, event: null, templateIds: [...(entryTemplateIds ?? [])] }
    : {
        ...single,
        admittedFrom,
        event: entry.event,
        templateIds: [...entry.templateIds],
        timeZone: entry.event.timeZone,
      };
}

/** A mixed scope narrowed to the entry that admits this pass; unchanged when none does. */
export function narrowToPass(actor: ScanActor, pass: Pass, now: number): ScanActor {
  if (!actor.events) return actor;
  const entry = admittingEntry(actor, pass, now);
  return entry ? narrowed(actor, entry) : actor;
}

/**
 * The candidates one code found, narrowed like `evaluate` picks: exactly one admitted pass in the
 * actor's mode narrows the scope. None or several leave it mixed, and `evaluate` refuses.
 */
export function narrowForCandidates(
  actor: ScanActor,
  candidates: readonly { pass: Pass }[] | null,
  now: number,
): ScanActor {
  if (!actor.events || !candidates) return actor;
  const admitted = candidates.filter(
    (c) => c.pass.mode === actor.mode && admittingEntry(actor, c.pass, now) !== null,
  );
  const [one] = admitted;
  return one && admitted.length === 1 ? narrowToPass(actor, one.pass, now) : actor;
}

/** The entry a recorded scan ran under (its event, else the template entries); null when the scope no longer admits it. */
export function narrowToRecorded(
  actor: ScanActor,
  eventId: string | null,
  templateId: string | null,
): ScanActor | null {
  if (!actor.events) return actor;
  if (templateId === null) return null;
  if (eventId === null)
    return actor.entryTemplateIds?.includes(templateId) ? narrowed(actor, 'templates') : null;
  const scope = actor.events.find(
    (s) => s.event.id === eventId && s.templateIds.includes(templateId),
  );
  return scope ? narrowed(actor, scope) : null;
}
