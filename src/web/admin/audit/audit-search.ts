import { formatShortDate } from '../../lib/format.ts';

export interface AuditSearch {
  /** Deep links from an org page; the top-bar scope applies otherwise. */
  orgId?: string | undefined;
  actorId?: string | undefined;
  action?: string | undefined;
  targetType?: string | undefined;
  targetId?: string | undefined;
  from?: number | undefined;
  to?: number | undefined;
  entry?: number | undefined;
}

const str = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : undefined);
const num = (v: unknown) => {
  const n = typeof v === 'string' && v.trim() !== '' ? Number(v) : v;
  return typeof n === 'number' && Number.isInteger(n) && n >= 0 ? n : undefined;
};

export function parseAuditSearch(raw: Record<string, unknown>): AuditSearch {
  return {
    orgId: str(raw.orgId),
    actorId: str(raw.actorId),
    action: str(raw.action),
    targetType: str(raw.targetType),
    targetId: str(raw.targetId),
    from: num(raw.from),
    to: num(raw.to),
    entry: num(raw.entry),
  };
}

/** Drops unset keys so links and the URL stay short. */
export function compactAudit(search: AuditSearch): AuditSearch {
  return Object.fromEntries(
    Object.entries(search).filter(([, v]) => v !== undefined && v !== ''),
  ) as AuditSearch;
}

export type AuditSubject =
  | { target: string; id: string }
  | { actor: 'user'; id: string }
  | { org: string };

/** Search for an entity's history: `<Link to="/admin/audit" search={auditSearchFor(...)}>`. */
export function auditSearchFor(subject: AuditSubject): AuditSearch {
  if ('target' in subject) return { targetType: subject.target, targetId: subject.id };
  if ('actor' in subject) return { actorId: subject.id };
  return { orgId: subject.org };
}

/** The same as a plain href, for menus and the palette. */
export function auditHref(subject: AuditSubject): string {
  const params = new URLSearchParams(
    Object.entries(compactAudit(auditSearchFor(subject))).map(([k, v]) => [k, String(v)]),
  );
  return `/admin/audit?${params}`;
}

const DAY = 86_400_000;

/** Date input value (YYYY-MM-DD, local) to epoch ms; `to` is the end of that day. */
export function dayToMs(value: string, end: boolean): number | undefined {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!m) return undefined;
  const start = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])).getTime();
  return end ? start + DAY - 1 : start;
}

export function msToDay(ms: number | undefined): string {
  if (ms === undefined) return '';
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** "Date: any", "Oct 1 – Oct 31", "From Oct 1", "To Oct 31". */
export function rangeLabel(from: number | undefined, to: number | undefined): string {
  const day = formatShortDate;
  if (from !== undefined && to !== undefined) return `${day(from)} – ${day(to)}`;
  if (from !== undefined) return `From ${day(from)}`;
  if (to !== undefined) return `To ${day(to)}`;
  return 'any';
}
