/** A plan of an Access card, as the designer wrote it into the plan input's schema (`x-plans`). */
export interface PlanChoice {
  id: string;
  label: string;
  kind: 'always' | 'timed' | 'guest';
  summary: string;
  visits?: number | undefined;
  days?: number | undefined;
}

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

const str = (v: unknown): string | undefined => (typeof v === 'string' && v !== '' ? v : undefined);

export function plansOf(def: Record<string, unknown>): PlanChoice[] | undefined {
  if (!Array.isArray(def['x-plans'])) return undefined;
  return def['x-plans'].flatMap((p) => {
    if (!isObject(p) || typeof p.id !== 'string' || typeof p.label !== 'string') return [];
    const kind = p.kind === 'timed' || p.kind === 'guest' ? p.kind : 'always';
    return [
      {
        id: p.id,
        label: p.label,
        kind,
        summary: str(p.summary) ?? '',
        visits: typeof p.visits === 'number' ? p.visits : undefined,
        days: typeof p.days === 'number' ? p.days : undefined,
      },
    ];
  });
}

export function accessOf(def: Record<string, unknown>): 'guest' | 'visits' | 'until' | undefined {
  const v = def['x-access'];
  return v === 'guest' || v === 'visits' || v === 'until' ? v : undefined;
}
