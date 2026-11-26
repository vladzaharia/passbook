import { readViewedAt } from '../quickstart/viewed.ts';
import type { Sandbox } from './session.ts';

export interface Created {
  sandbox: Sandbox;
  /** Shown once; null when the sandbox existed and its key was made earlier. */
  secret: string | null;
}

export class CreateError extends Error {}

/** POST /developer/sandbox. The Turnstile token is the one the widget just gave. */
export async function createSandbox(csrf: string, turnstileToken: string): Promise<Created> {
  const res = await fetch('/api/v1/developer/sandbox', {
    method: 'POST',
    headers: {
      accept: 'application/json',
      'content-type': 'application/json',
      'x-csrf-token': csrf,
    },
    body: JSON.stringify({ turnstileToken, viewedAt: readViewedAt() }),
  });
  const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) {
    throw new CreateError(
      typeof body.detail === 'string'
        ? body.detail
        : 'Could not create the sandbox. Reload and try again.',
    );
  }
  const key = body.key as { secret?: unknown } | null | undefined;
  return {
    sandbox: {
      id: String(body.id),
      orgId: String(body.orgId),
      orgSlug: String(body.orgSlug),
      templateId: typeof body.templateId === 'string' ? body.templateId : null,
    },
    secret: typeof key?.secret === 'string' ? key.secret : null,
  };
}
