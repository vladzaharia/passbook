import type { AccessManifest, AccessPlan, WeeklyHours } from '../../types.ts';
import { guestUntil } from './decide.ts';
import { DAYS, parseSpan } from './hours.ts';

const DAY_NAMES = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

function clock(minutes: number): string {
  const m = minutes % 1440;
  const h = Math.floor(m / 60);
  const mm = m % 60;
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return `${h12}${mm === 0 ? '' : `:${String(mm).padStart(2, '0')}`} ${h < 12 ? 'AM' : 'PM'}`;
}

/** "Mon–Fri 6 AM–4 PM, 8 PM–11 PM · Sat–Sun 8 AM–8 PM"; days with the same spans share a group. */
export function hoursText(hours: WeeklyHours | undefined): string {
  if (!hours) return '';
  const rows = DAYS.map((day) =>
    (hours[day] ?? [])
      .map(parseSpan)
      .flatMap((s) => (s ? [`${clock(s.start)}–${clock(s.end)}`] : []))
      .join(', '),
  );
  const groups: string[] = [];
  for (let i = 0; i < rows.length; ) {
    const row = rows[i] as string;
    let j = i;
    while (j + 1 < rows.length && rows[j + 1] === row) j++;
    if (row !== '') {
      const days = j === i ? DAY_NAMES[i] : `${DAY_NAMES[i]}–${DAY_NAMES[j]}`;
      groups.push(`${days} ${row}`);
    }
    i = j + 1;
  }
  return groups.join(' · ');
}

/** "Pool, Studio"; `*` reads "Every zone". Names the plan's zone keys through `names` (key to name). */
export function zonesText(
  plan: AccessPlan,
  names: ReadonlyMap<string, string> = new Map(),
): string {
  const out: string[] = [];
  for (const g of plan.zones) {
    if (typeof g.zone !== 'string') continue;
    const label = g.zone === '*' ? 'Every zone' : (names.get(g.zone) ?? g.zone);
    if (!out.includes(label)) out.push(label);
  }
  return out.join(', ');
}

export interface AccessScope {
  plan: string;
  kind: AccessPlan['kind'];
  hours: string;
  zones: string;
  /** The pass's end (ms): its own, or a guest's computed one. */
  until: number | null;
}

/** The `access.*` pieces a pass face or scan screen binds, from the pass's inputs. Null for an unknown plan. */
export function accessScope(
  access: AccessManifest,
  inputs: Record<string, unknown>,
  options: { createdAt: number; timeZone: string; zoneNames?: ReadonlyMap<string, string> },
): AccessScope | null {
  const id = inputs[access.input.plan];
  const plan = access.plans.find((p) => p.id === id);
  if (!plan) return null;
  const own = access.input.until === undefined ? undefined : inputs[access.input.until];
  const parsed = typeof own === 'string' ? Date.parse(own) : Number.NaN;
  const until =
    plan.kind === 'guest'
      ? guestUntil(access, plan, inputs, options.createdAt, options.timeZone)
      : Number.isNaN(parsed)
        ? null
        : parsed;
  return {
    plan: plan.label,
    kind: plan.kind,
    hours: hoursText(plan.hours),
    zones: zonesText(plan, options.zoneNames),
    until,
  };
}
