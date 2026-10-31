export interface AuditSearch {
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
  const out: AuditSearch = {
    orgId: str(raw.orgId),
    actorId: str(raw.actorId),
    action: str(raw.action),
    targetType: str(raw.targetType),
    targetId: str(raw.targetId),
    from: num(raw.from),
    to: num(raw.to),
    entry: num(raw.entry),
  };
  return out;
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
