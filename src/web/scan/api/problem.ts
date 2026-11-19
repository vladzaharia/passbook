export interface Problem {
  code: string;
  title?: string;
  detail?: string;
  requestId?: string;
  fields?: Record<string, string>;
}

/** Reads a problem+json body leniently: a proxy or an older server may leave fields out. */
export function problemOf(data: unknown): Problem | null {
  if (typeof data !== 'object' || data === null) return null;
  const o = data as Record<string, unknown>;
  if (typeof o.code !== 'string') return null;
  const str = (v: unknown) => (typeof v === 'string' ? v : undefined);
  const fields: Record<string, string> = {};
  if (Array.isArray(o.issues))
    for (const issue of o.issues as unknown[]) {
      const i = issue as { path?: unknown; message?: unknown } | null;
      if (typeof i?.path === 'string' && typeof i.message === 'string') fields[i.path] = i.message;
    }
  return {
    code: o.code,
    title: str(o.title),
    detail: str(o.detail),
    requestId: str(o.requestId),
    fields,
  };
}
