import { expect, vi } from 'vitest';
import {
  type CreatedDeveloperSandbox,
  CreatedDeveloperSandboxSchema,
  DeveloperSandboxSchema,
  SandboxKeyResponseSchema,
} from '../../../shared/contracts/developer.ts';
import { type OperationDto, OperationSchema } from '../../../shared/contracts/operations.ts';

/** A test's own `send(method, path, headers, body)`: every call goes through the app as the person. */
export type Send = (
  method: string,
  path: string,
  headers: Record<string, string>,
  body?: unknown,
) => Response | Promise<Response>;

const ended = (op: OperationDto) => ['succeeded', 'failed', 'cancelled'].includes(op.status);

/**
 * Reads the operation until `until` holds, by default until it ends (the work runs in the request's
 * `waitUntil`, detached in a test).
 */
export async function settle(
  send: Send,
  headers: Record<string, string>,
  id: string,
  until: (op: OperationDto) => boolean = ended,
) {
  let op: OperationDto | undefined;
  await vi.waitFor(
    async () => {
      const res = await send('GET', `/operations/${id}`, headers);
      expect(res.status).toBe(200);
      op = OperationSchema.parse(await res.json());
      expect(until(op)).toBe(true);
    },
    { timeout: 20_000, interval: 20 },
  );
  return op as OperationDto;
}

/** Starts an operation, expects the 202, and waits for the end. */
export async function startAndSettle(
  send: Send,
  headers: Record<string, string>,
  method: string,
  path: string,
  body?: unknown,
  until?: (op: OperationDto) => boolean,
): Promise<OperationDto> {
  const res = await send(method, path, headers, body);
  expect(res.status, await res.clone().text()).toBe(202);
  const started = OperationSchema.parse(((await res.json()) as { operation: unknown }).operation);
  return settle(send, headers, started.id, until);
}

/**
 * A person's new sandbox the way the page makes it: the create operation, then the key, once. The answer has
 * the shape the create used to have, so a test reads `key` and `templateId` as before.
 */
export async function makeSandbox(
  send: Send,
  headers: Record<string, string>,
  body: unknown = { turnstileToken: 'ok' },
): Promise<CreatedDeveloperSandbox> {
  const op = await startAndSettle(send, headers, 'POST', '/developer/sandbox', body);
  expect(op.status, JSON.stringify(op.error)).toBe('succeeded');
  const keyed = await send('POST', '/developer/sandbox/key', headers);
  expect(keyed.status, await keyed.clone().text()).toBe(201);
  const { key } = SandboxKeyResponseSchema.parse(await keyed.json());
  const read = await send('GET', '/developer/sandbox', headers);
  const { sandbox } = (await read.json()) as { sandbox: unknown };
  return CreatedDeveloperSandboxSchema.parse({
    ...DeveloperSandboxSchema.parse(sandbox),
    key,
    previousKey: null,
  });
}
