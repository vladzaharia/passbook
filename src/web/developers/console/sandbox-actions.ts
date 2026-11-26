import type { Sandbox } from './session.ts';

/** A sandbox answer with a key: the key's secret is shown once, so it is returned and kept nowhere. */
export interface WithKey {
  sandbox: Sandbox;
  secret: string | null;
  /** Reset only: what it deleted. */
  deleted?: { passes: number; captures: number; calls: number; other: number };
  kept?: number;
  /** The purge ran out of time: no new key yet. Ask again; it resumes and costs no reset. */
  more?: boolean;
  resetsLeft?: number;
}

export class ActionError extends Error {
  /** STEP_UP_REQUIRED: where Polaris ID asks for a fresh sign-in. */
  readonly signInUrl: string | undefined;
  constructor(message: string, signInUrl?: string) {
    super(message);
    this.signInUrl = signInUrl;
  }
}

async function post(
  path: string,
  csrf: string,
  body?: unknown,
  method: 'POST' | 'DELETE' = 'POST',
): Promise<Record<string, unknown>> {
  const res = await fetch(`/api/v1/developer/sandbox${path ? `/${path}` : ''}`, {
    method,
    headers: {
      accept: 'application/json',
      'x-csrf-token': csrf,
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const out = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok)
    throw new ActionError(
      typeof out.detail === 'string' ? out.detail : 'That did not work. Reload and try again.',
      out.code === 'STEP_UP_REQUIRED' && typeof out.signInUrl === 'string'
        ? out.signInUrl
        : undefined,
    );
  return out;
}

const sandboxOf = (b: Record<string, unknown>): Sandbox => ({
  id: String(b.id),
  orgId: String(b.orgId),
  orgSlug: String(b.orgSlug),
  templateId: typeof b.templateId === 'string' ? b.templateId : null,
});
const secretOf = (key: unknown): string | null =>
  typeof (key as { secret?: unknown } | null)?.secret === 'string'
    ? (key as { secret: string }).secret
    : null;

/** `POST /developer/sandbox/reopen`: your own close, inside its 30 days, with a new key. */
export async function reopenSandbox(csrf: string): Promise<WithKey> {
  const b = await post('reopen', csrf);
  return { sandbox: sandboxOf(b), secret: secretOf(b.key) };
}

/** `POST /developer/sandbox/reset` with the Turnstile token: test data deleted, track restarted, key replaced. */
export async function resetSandbox(csrf: string, turnstileToken: string): Promise<WithKey> {
  const b = await post('reset', csrf, { turnstileToken });
  const deleted = b.deleted as WithKey['deleted'];
  return {
    sandbox: sandboxOf(b.sandbox as Record<string, unknown>),
    secret: secretOf(b.key),
    ...(deleted ? { deleted } : {}),
    ...(typeof b.kept === 'number' ? { kept: b.kept } : {}),
    ...(b.more === true ? { more: true } : {}),
    ...(typeof b.resetsLeft === 'number' ? { resetsLeft: b.resetsLeft } : {}),
  };
}

/** `DELETE /developer/sandbox`: the sandbox is gone and the person may make a new one. */
export async function deleteSandbox(csrf: string): Promise<void> {
  await post('', csrf, undefined, 'DELETE');
}

/** `POST /developer/sandbox/recreate` with the Turnstile token: delete, then a new sandbox and a new key, shown once. */
export async function recreateSandbox(csrf: string, turnstileToken: string): Promise<WithKey> {
  const b = await post('recreate', csrf, { turnstileToken });
  return { sandbox: sandboxOf(b), secret: secretOf(b.key) };
}
