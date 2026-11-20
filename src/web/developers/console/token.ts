import { spend } from './budget.ts';
import { masked } from './mask.ts';

/**
 * The Try it bearer. It lives in this module's variable and nowhere else: not in storage, a
 * cookie, a URL or the DOM, and never in anything shown. The server mints it for 15 minutes; the
 * page asks again at 12.
 */
export const REFRESH_MS = 12 * 60_000;

let held: { value: string; refreshAt: number } | null = null;
let inflight: Promise<string> | null = null;
let holders = 0;
let timer: ReturnType<typeof setTimeout> | undefined;
let csrfOf: (() => string) | undefined;

export class TokenError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

async function mint(csrf: string): Promise<string> {
  spend();
  const res = await fetch('/api/v1/developer/try-token', {
    method: 'POST',
    headers: { accept: 'application/json', 'x-csrf-token': csrf },
  });
  const body = (await res.json().catch(() => ({}))) as {
    token?: string;
    code?: string;
    detail?: string;
  };
  if (!res.ok || typeof body.token !== 'string') {
    throw new TokenError(
      body.code ?? 'TRY_TOKEN',
      masked(body.detail ?? 'Could not start Try it. Reload and try again.'),
    );
  }
  held = { value: body.token, refreshAt: Date.now() + REFRESH_MS };
  schedule();
  return body.token;
}

function schedule(retryIn?: number): void {
  clearTimeout(timer);
  if (holders === 0 || !csrfOf) return;
  const wait = retryIn ?? (held ? Math.max(0, held.refreshAt - Date.now()) : REFRESH_MS);
  timer = setTimeout(() => {
    const csrf = csrfOf?.();
    if (holders > 0 && csrf)
      void token(csrf).then(
        () => schedule(),
        () => schedule(30_000),
      );
  }, wait);
}

/** The current token, minted first when there is none or it is due. */
export function token(csrf: string): Promise<string> {
  if (held && Date.now() < held.refreshAt) return Promise.resolve(held.value);
  inflight ??= mint(csrf).finally(() => {
    inflight = null;
  });
  return inflight;
}

/** A console is open: keep a fresh token for it until the returned function runs. */
export function retain(csrf: string): () => void {
  holders += 1;
  csrfOf = () => csrf;
  schedule();
  return () => {
    holders -= 1;
    if (holders === 0) clearTimeout(timer);
  };
}

/** The server said the token is no good: forget it so the next call mints. */
export function drop(): void {
  held = null;
}

export function resetToken(): void {
  held = null;
  inflight = null;
  holders = 0;
  clearTimeout(timer);
}
