import type { Operation } from '../../ui/operation/index.ts';
import { readViewedAt } from '../quickstart/viewed.ts';

export class CreateError extends Error {
  /** OPERATION_RUNNING: the sandbox operation already under way, which the page follows. */
  readonly operationId: string | undefined;
  constructor(message: string, operationId?: string) {
    super(message);
    this.operationId = operationId;
  }
}

/**
 * POST /developer/sandbox. The Turnstile token is the one the widget just gave. Answers the operation the page
 * follows (`OperationProgress`); the key is minted once when it ends (`mintKey`).
 */
export async function startSandbox(csrf: string, turnstileToken: string): Promise<Operation> {
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
      body.code === 'OPERATION_RUNNING' && typeof body.operationId === 'string'
        ? body.operationId
        : undefined,
    );
  }
  return body.operation as Operation;
}
