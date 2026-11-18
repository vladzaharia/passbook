import { suspended } from '@/passkit/template/access/decide.ts';
import { isOpen, nextOpen } from '@/passkit/template/access/hours.ts';
import type { AccessManifest, AccessPlan } from '@/passkit/types.ts';

export interface ZoneRef {
  key: string;
  name: string;
  /** The zone's own clock, or the one it inherits. */
  timeZone: string | null;
}

export type AccessStatus =
  | { kind: 'suspended' }
  | { kind: 'not_started'; at: number }
  | { kind: 'ended'; at: number }
  | { kind: 'open' }
  | { kind: 'opens'; at: number }
  | { kind: 'closed' };

export interface AccessState {
  plan: AccessPlan | null;
  /** The plan id the pass holds, when the template no longer has it. */
  unknown: string | null;
  /** Plan zones, then the pass's extra zones; `*` reads "Every zone". */
  zones: { key: string; name: string; extra: boolean }[];
  status: AccessStatus;
  timeZone: string;
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

function time(value: unknown): number | null {
  const ms = typeof value === 'string' ? Date.parse(value) : Number.NaN;
  return Number.isNaN(ms) ? null : ms;
}

/** What a pass's Access card says now, from the template's plans and the pass's own inputs. */
export function accessState(
  access: AccessManifest,
  inputs: Record<string, unknown>,
  zones: readonly ZoneRef[],
  now: number,
  fallbackZone: string,
): AccessState {
  const id = inputs[access.input.plan];
  const plan = access.plans.find((p) => p.id === id) ?? null;
  const unknown = !plan && typeof id === 'string' ? id : null;
  const byKey = new Map(zones.map((z) => [z.key, z]));
  const extraRaw = access.input.zones ? inputs[access.input.zones] : undefined;
  const extra = (
    Array.isArray(extraRaw) ? extraRaw : typeof extraRaw === 'string' ? [extraRaw] : []
  ).filter((k): k is string => typeof k === 'string' && k !== '');
  const granted = (plan?.zones ?? []).flatMap((g) => (typeof g.zone === 'string' ? [g.zone] : []));
  const listed = [
    ...granted.map((key) => ({ key, extra: false })),
    ...extra.filter((k) => !granted.includes(k)).map((key) => ({ key, extra: true })),
  ].map((z) => ({
    ...z,
    name: z.key === '*' ? 'Every zone' : (byKey.get(z.key)?.name ?? z.key),
  }));
  const firstZone = granted.map((k) => byKey.get(k)).find(Boolean);
  const timeZone = firstZone?.timeZone ?? fallbackZone;
  return {
    plan,
    unknown,
    zones: listed,
    timeZone,
    status: statusOf(access, plan, inputs, now, timeZone),
  };
}

function statusOf(
  access: AccessManifest,
  plan: AccessPlan | null,
  inputs: Record<string, unknown>,
  now: number,
  timeZone: string,
): AccessStatus {
  if (!plan) return { kind: 'closed' };
  if (suspended(access, inputs)) return { kind: 'suspended' };
  const from = time(access.input.from ? inputs[access.input.from] : undefined);
  const until = time(access.input.until ? inputs[access.input.until] : undefined);
  if (from !== null && from > now) return { kind: 'not_started', at: from };
  if (until !== null && until <= now) return { kind: 'ended', at: until };
  if (plan.kind === 'always') return { kind: 'open' };
  if (isOpen(plan.hours, timeZone, now)) return { kind: 'open' };
  const next = nextOpen([plan.hours], timeZone, now);
  return next === null ? { kind: 'closed' } : { kind: 'opens', at: next };
}

/** The access block of a template manifest, or null. */
export function accessOf(manifest: unknown): AccessManifest | null {
  const scan = isRecord(manifest) && isRecord(manifest.scan) ? manifest.scan : null;
  const access = scan?.access;
  return isRecord(access) && Array.isArray(access.plans) && isRecord(access.input)
    ? (access as unknown as AccessManifest)
    : null;
}
