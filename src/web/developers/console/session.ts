/**
 * Who is looking: signed out, signed in without a sandbox, or with one. Plain fetches, no React:
 * the answer decides whether the console chunk loads at all.
 */
export interface Sandbox {
  id: string;
  orgSlug: string;
  templateId: string | null;
}

export type Session =
  | { kind: 'out' }
  | { kind: 'none'; csrf: string; siteKey: string }
  | { kind: 'closed'; csrf: string }
  | { kind: 'ready'; csrf: string; sandbox: Sandbox };

const API = '/api/v1';
let pending: Promise<Session> | undefined;

async function json(res: Response): Promise<Record<string, unknown>> {
  try {
    return (await res.json()) as Record<string, unknown>;
  } catch {
    return {};
  }
}

async function read(): Promise<Session> {
  const head = { accept: 'application/json' };
  const me = await json(await fetch(`${API}/session`, { headers: head }));
  if (me.authenticated !== true || typeof me.csrfToken !== 'string') return { kind: 'out' };
  const csrf = me.csrfToken;
  const res = await fetch(`${API}/developer/sandbox`, { headers: head });
  if (res.status === 401) return { kind: 'out' };
  const body = await json(res);
  const box = body.sandbox as Record<string, unknown> | null | undefined;
  if (!res.ok) return { kind: 'none', csrf, siteKey: '' };
  if (!box)
    return {
      kind: 'none',
      csrf,
      siteKey: typeof body.turnstileSiteKey === 'string' ? body.turnstileSiteKey : '',
    };
  if (box.closedAt) return { kind: 'closed', csrf };
  return {
    kind: 'ready',
    csrf,
    sandbox: {
      id: String(box.id),
      orgSlug: String(box.orgSlug),
      templateId: typeof box.templateId === 'string' ? box.templateId : null,
    },
  };
}

/** One lookup per page, shared by the org chip, every Run slot and the sheet. */
export function loadSession(): Promise<Session> {
  pending ??= read().catch(() => ({ kind: 'out' }) as Session);
  return pending;
}
