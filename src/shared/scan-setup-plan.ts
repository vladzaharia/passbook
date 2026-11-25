import type {
  PlannedEvent,
  PlannedSession,
  PlannedZone,
  ScanSetupIntent,
  ScanSetupPlan,
  SetupLink,
} from './contracts/scan-setup-intent.ts';
import { setupChecks } from './scan-setup-checks.ts';
import {
  isTracked,
  lastClose,
  placeDepths,
  type SetupIssue,
  sessionHoursOf,
  zoneKeyFor,
} from './scan-setup-plan-derive.ts';
import { planDoor } from './scan-setup-plan-door.ts';
import { planCheckFacts } from './scan-setup-plan-facts.ts';
import { applyPreset } from './scan-setup-plan-presets.ts';
import {
  isRef,
  MAX_ZONE_DEPTH,
  type RefTarget,
  type SetupPlanContext,
  type SetupPlanResult,
  type ZoneFacts,
} from './scan-setup-plan-types.ts';
import { resolveOrgTimeZone } from './time-zone.ts';

function existingDepth(zones: ZoneFacts[], id: string): number {
  const byId = new Map(zones.map((z) => [z.id, z]));
  const seen = new Set<string>();
  let d = 0;
  for (let at = byId.get(id)?.parentId ?? null; at !== null && !seen.has(at); d++) {
    seen.add(at);
    at = byId.get(at)?.parentId ?? null;
  }
  return d;
}

function planEvents(
  intent: ScanSetupIntent,
  ctx: SetupPlanContext,
  refs: Map<string, RefTarget>,
  tz: string,
  issues: SetupIssue[],
): PlannedEvent[] {
  const out: PlannedEvent[] = [];
  const templateIds = new Set(ctx.templates.map((t) => t.id));
  intent.events.forEach((e, i) => {
    const path = ['events', i];
    if ('eventId' in e) {
      if (!ctx.events.some((x) => x.id === e.eventId))
        issues.push({ code: 'EVENT_NOT_FOUND', path });
      return;
    }
    if ('fromTemplate' in e) {
      const t = ctx.templates.find((x) => x.id === e.fromTemplate);
      if (!t) {
        issues.push({ code: 'TEMPLATE_NOT_FOUND', path: [...path, 'fromTemplate'] });
        return;
      }
      const links: SetupLink[] = [];
      (t.upcomingEvents ?? []).forEach((u, n) => {
        if (u.existingId) {
          links.push({ id: u.existingId });
          return;
        }
        const ref = `${e.ref ?? `template-${i + 1}`}-${n + 1}`;
        links.push({ ref });
        out.push({
          ref,
          name: u.name,
          templateIds: [t.id],
          match: u.match ? { input: u.match.input, values: [u.match.value] } : null,
          opensAt: u.opensAt,
          closesAt: u.closesAt,
          timeZone: u.timeZone ?? tz,
          capacity: null,
          reentry: false,
        });
      });
      if (e.ref) refs.set(e.ref, { kind: 'group', templateId: t.id, links });
      return;
    }
    e.templateIds.forEach((id, n) => {
      if (!templateIds.has(id))
        issues.push({ code: 'TEMPLATE_NOT_FOUND', path: [...path, 'templateIds', n] });
    });
    if (e.closesAt <= e.opensAt)
      issues.push({
        code: 'SETUP_CLOSES_BEFORE_OPENS',
        path: [...path, 'closesAt'],
        params: { event: e.name },
      });
    out.push({
      ref: e.ref,
      name: e.name,
      templateIds: [...new Set(e.templateIds)],
      match: null,
      opensAt: e.opensAt,
      closesAt: e.closesAt,
      timeZone: tz,
      capacity: e.max ?? null,
      reentry: e.reentry ?? false,
    });
  });
  return out;
}

function registerRefs(intent: ScanSetupIntent, issues: SetupIssue[]): Map<string, RefTarget> {
  const refs = new Map<string, RefTarget>();
  const add = (ref: string, target: RefTarget, path: (string | number)[]) => {
    if (refs.has(ref)) issues.push({ code: 'SETUP_REF_DUPLICATE', path, params: { ref } });
    else refs.set(ref, target);
  };
  intent.places.forEach((p, i) => {
    if ('ref' in p) add(p.ref, { kind: 'place' }, ['places', i, 'ref']);
  });
  intent.events.forEach((e, i) => {
    if ('ref' in e && e.ref && 'name' in e) add(e.ref, { kind: 'event' }, ['events', i, 'ref']);
    if ('fromTemplate' in e && e.ref)
      add(e.ref, { kind: 'group', templateId: e.fromTemplate, links: [] }, ['events', i, 'ref']);
  });
  return refs;
}

function planZones(
  intent: ScanSetupIntent,
  ctx: SetupPlanContext,
  refs: Map<string, RefTarget>,
  issues: SetupIssue[],
): PlannedZone[] {
  const taken = new Set(ctx.zones.map((z) => z.key));
  const rows: { ref: string; parentRef: string | null; parentDepth: number }[] = [];
  const zones = new Map<string, PlannedZone>();
  intent.places.forEach((p, i) => {
    const path = ['places', i];
    if ('zoneId' in p) {
      const z = ctx.zones.find((x) => x.id === p.zoneId);
      if (!z) issues.push({ code: 'ZONE_NOT_FOUND', path: [...path, 'zoneId'] });
      else if (z.archived) issues.push({ code: 'ZONE_ARCHIVED', path: [...path, 'zoneId'] });
      return;
    }
    let parent: SetupLink | null = null;
    let parentDepth = 0;
    if (p.inside !== undefined) {
      const target = refs.get(p.inside);
      if (target?.kind === 'place') parent = { ref: p.inside };
      else if (target)
        issues.push({
          code: 'SETUP_REF_KIND',
          path: [...path, 'inside'],
          params: { ref: p.inside, kind: 'place' },
        });
      else if (ctx.zones.some((z) => z.id === p.inside && !z.archived)) {
        parent = { id: p.inside };
        parentDepth = existingDepth(ctx.zones, p.inside) + 1;
      } else
        issues.push({
          code: isRef(p.inside) ? 'SETUP_REF_UNKNOWN' : 'ZONE_NOT_FOUND',
          path: [...path, 'inside'],
          params: { ref: p.inside },
        });
    }
    rows.push({
      ref: p.ref,
      parentRef: parent && 'ref' in parent ? parent.ref : null,
      parentDepth,
    });
    if (p.key !== undefined && taken.has(p.key))
      issues.push({ code: 'ZONE_KEY_TAKEN', path: [...path, 'key'], params: { key: p.key } });
    if (p.key !== undefined) taken.add(p.key);
    const tracked = isTracked(p);
    const doorHours = intent.doors
      .filter((d) => d.place === p.ref)
      .map((d) => sessionHoursOf(d.hours))
      .filter((h) => h !== 'empty');
    zones.set(p.ref, {
      ref: p.ref,
      key: p.key ?? zoneKeyFor(p.name, taken),
      name: p.name,
      parent,
      timeZone: parent === null ? (intent.timeZone ?? null) : null,
      occupancy: tracked ? 'track' : 'off',
      capacity: p.max ?? null,
      maxStayMinutes: tracked ? (p.maxStayMinutes ?? 720) : null,
      clearAt: tracked ? (p.clearAt ?? lastClose(doorHours)) : null,
    });
  });
  const { order, issues: tree } = placeDepths(rows, MAX_ZONE_DEPTH);
  for (const t of tree) {
    const i = intent.places.findIndex((p) => 'ref' in p && p.ref === t.ref);
    issues.push({ code: t.code, path: ['places', i, 'inside'], params: { ref: t.ref } });
  }
  return order.flatMap((ref) => zones.get(ref) ?? []);
}

/**
 * The fully resolved setup: every object to make or reuse, with the values its create schema takes.
 * Presets fill blanks first, then the defaults are derived. Pure: the caller loads `ctx`.
 */
export function planScanSetup(input: ScanSetupIntent, ctx: SetupPlanContext): SetupPlanResult {
  const intent = applyPreset(input);
  const issues: SetupIssue[] = [];
  const timeZone = intent.timeZone ?? resolveOrgTimeZone(ctx.orgTimeZone);
  const refs = registerRefs(intent, issues);
  const zones = planZones(intent, ctx, refs, issues);
  const events = planEvents(intent, ctx, refs, timeZone, issues);
  if (events.length > 10) issues.push({ code: 'SETUP_TOO_MANY_NEW_EVENTS', path: ['events'] });
  const staff = intent.staff.map((s, i) => ({ ref: `staff-${i + 1}`, name: s.name, role: s.role }));
  const sessions: PlannedSession[] = intent.doors.map((door, i) =>
    planDoor(door, i, { intent, ctx, refs, events, issues }),
  );
  if (issues.length > 0) return { ok: false, issues };
  const plan: ScanSetupPlan = {
    mode: ctx.mode,
    timeZone,
    preset: intent.preset ?? null,
    zones,
    events,
    staff,
    sessions,
    checks: [],
  };
  plan.checks = setupChecks(planCheckFacts(plan, intent, ctx));
  return { ok: true, plan };
}
