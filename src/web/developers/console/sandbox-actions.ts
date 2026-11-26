import type { Operation } from '../../ui/operation/index.ts';
import type { Sandbox } from './session.ts';

/** A sandbox answer with a key: the key's secret is shown once, so it is returned and kept nowhere. */
export interface WithKey {
  sandbox: Sandbox;
  secret: string | null;
}

export class ActionError extends Error {
  /** STEP_UP_REQUIRED: where Polaris ID asks for a fresh sign-in. */
  readonly signInUrl: string | undefined;
  /** OPERATION_RUNNING: the operation already under way, which the page follows instead of showing an error. */
  readonly operationId: string | undefined;
  /** SANDBOX_KEY_SHOWN: the key was minted already. */
  readonly keyShown: boolean;
  constructor(
    message: string,
    extra: { signInUrl?: string; operationId?: string; keyShown?: boolean } = {},
  ) {
    super(message);
    this.signInUrl = extra.signInUrl;
    this.operationId = extra.operationId;
    this.keyShown = extra.keyShown === true;
  }
}

/** The ids a finished operation names (`result.ids`): the sandbox it made, read without another call. */
export function sandboxOfOperation(op: Operation): Sandbox | null {
  const ids = op.result?.ids;
  if (!ids?.sandboxId || !ids.orgSlug) return null;
  return { id: ids.sandboxId, orgSlug: ids.orgSlug, templateId: ids.templateId ?? null };
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
      {
        ...(out.code === 'STEP_UP_REQUIRED' && typeof out.signInUrl === 'string'
          ? { signInUrl: out.signInUrl }
          : {}),
        ...(out.code === 'OPERATION_RUNNING' && typeof out.operationId === 'string'
          ? { operationId: out.operationId }
          : {}),
        keyShown: out.code === 'SANDBOX_KEY_SHOWN',
      },
    );
  return out;
}

const sandboxOf = (b: Record<string, unknown>): Sandbox => ({
  id: String(b.id),
  orgId: String(b.orgId),
  orgSlug: String(b.orgSlug),
  templateId: typeof b.templateId === 'string' ? b.templateId : null,
});
const operationOf = (b: Record<string, unknown>): Operation => b.operation as Operation;
const secretOf = (key: unknown): string | null =>
  typeof (key as { secret?: unknown } | null)?.secret === 'string'
    ? (key as { secret: string }).secret
    : null;

/** `POST /developer/sandbox/reopen`: your own close, inside its 30 days, with a new key. */
export async function reopenSandbox(csrf: string): Promise<WithKey> {
  const b = await post('reopen', csrf);
  return { sandbox: sandboxOf(b), secret: secretOf(b.key) };
}

/** `POST /developer/sandbox/reset` with the Turnstile token: answers the operation the page follows. */
export async function startReset(csrf: string, turnstileToken: string): Promise<Operation> {
  return operationOf(await post('reset', csrf, { turnstileToken }));
}

/** `DELETE /developer/sandbox`: answers the operation; the sandbox is gone when it ends. */
export async function startDelete(csrf: string): Promise<Operation> {
  return operationOf(await post('', csrf, undefined, 'DELETE'));
}

/** `POST /developer/sandbox/recreate` with the Turnstile token: delete, then a new sandbox, as one operation. */
export async function startRecreate(csrf: string, turnstileToken: string): Promise<Operation> {
  return operationOf(await post('recreate', csrf, { turnstileToken }));
}

/** `POST /developer/sandbox/key`: the key, once. Null when it was shown already (409): the person rolls it. */
export async function mintKey(csrf: string): Promise<string | null> {
  try {
    return secretOf((await post('key', csrf)).key);
  } catch (e) {
    if (e instanceof ActionError && e.keyShown) return null;
    throw e;
  }
}
