import {
  CreateDevicePassSchema,
  DevicePassListSchema,
  DevicePassResponseSchema,
} from '../../../shared/contracts/device-passes.ts';
import { IdParamSchema } from '../../../shared/contracts/index.ts';
import type { SessionAuth } from '../../platform/auth.ts';
import type { AppBindings } from '../../platform/context.ts';
import { BadRequestError, NotFoundError, UnauthenticatedError } from '../../platform/errors.ts';
import { idempotentJson, principalOf } from '../../platform/idempotency.ts';
import { createRouter, register } from '../../platform/openapi.ts';
import { serviceContext } from '../../platform/service-context.ts';
import { STEP_UP_AUTH } from '../developer/routes-sandbox.ts';
import { addAgain, createDevicePass, issueCode, listOwn, voidOwn } from './device-pass.ts';
import { devicePassEnabled } from './device-pass-identity.ts';

/** /api/v1/developer/device-passes. A person's own calls: never a key or a token (`human`). */
export const developerDevicePassRoutes = createRouter();
developerDevicePassRoutes.use('*', async (c, next) => {
  c.header('cache-control', 'no-store');
  await next();
});

const READ = { human: true, signIn: 'strict', developer: true } as const;
const TAG = 'developer';
const WRITE_CODES = [
  'IDEMPOTENCY_KEY_REQUIRED',
  'DEVICE_PASS_NOT_SANDBOX',
  'DEVICE_PASS_SOURCE_VOIDED',
  'DEVICE_PASS_LIMIT',
  'DEVICE_PASS_BLOCKED',
  'DEVICE_PASS_RATE_LIMITED',
  'DEVICE_PASS_IDENTITY_NOT_READY',
] as const;

function sessionOf(c: { var: AppBindings['Variables'] }): SessionAuth {
  const auth = c.var.auth;
  if (auth?.kind !== 'session') throw new UnauthenticatedError();
  return auth;
}

/**
 * Off, a signed-in developer finds no such route (404). The guards run first, so a key, a token or no sign-in meet
 * them as on any route and the flag is not readable by anyone who cannot already use the feature.
 */
function requireOn(c: { env: { DEVICE_PASS_ENABLED?: string } }): void {
  if (!devicePassEnabled(c.env)) throw new NotFoundError();
}

/** Every make is replay-safe or refused: the key is not optional. */
function requireKey(c: { req: { header(name: string): string | undefined } }): void {
  if (!c.req.header('idempotency-key')?.trim())
    throw new BadRequestError('Send an Idempotency-Key header.', 'IDEMPOTENCY_KEY_REQUIRED');
}

/** Idempotency keeps the response 24 h; the one-time code is not kept, so a replay answers `code: null`. */
const withoutCode = <T extends { devicePass: object }>(body: T) => ({
  devicePass: { ...body.devicePass, code: null },
});

register(
  developerDevicePassRoutes,
  TAG,
  {
    method: 'post',
    path: '/',
    summary:
      'Make a device pass: a Test pass of your own sandbox on your phone, shown as PassBook Test, valid for 24 hours. Answers a one-time code to open on the phone (Idempotency-Key)',
    operationId: 'developer.postDevicePasses',
    auth: STEP_UP_AUTH,
    body: CreateDevicePassSchema,
    status: 201,
    response: DevicePassResponseSchema,
    codes: WRITE_CODES,
  },
  async (c) => {
    requireOn(c);
    requireKey(c);
    const ctx = serviceContext(c);
    const auth = sessionOf(c);
    const body = c.req.valid('json');
    return idempotentJson(
      c,
      ctx,
      { orgId: 'device-pass', mode: 'test', principal: principalOf(auth), body },
      201,
      async () => ({ devicePass: await createDevicePass(ctx, auth, body.passId) }),
      undefined,
      withoutCode,
    );
  },
);

register(
  developerDevicePassRoutes,
  TAG,
  {
    method: 'get',
    path: '/',
    summary: 'Your device passes: the open ones and the last 7 days, with state, phones and expiry',
    operationId: 'developer.getDevicePasses',
    auth: READ,
    response: DevicePassListSchema,
    codes: ['DEVICE_PASS_NOT_SANDBOX'],
  },
  async (c) => {
    requireOn(c);
    return c.json(await listOwn(serviceContext(c), sessionOf(c)));
  },
);

register(
  developerDevicePassRoutes,
  TAG,
  {
    method: 'post',
    path: '/{id}/code',
    summary:
      'A new one-time code for a device pass that is not opened yet. The old code stops working; a pass has 5 codes (Idempotency-Key)',
    operationId: 'developer.postDevicePassesByIdCode',
    auth: STEP_UP_AUTH,
    params: IdParamSchema,
    status: 201,
    response: DevicePassResponseSchema,
    codes: [
      'IDEMPOTENCY_KEY_REQUIRED',
      'DEVICE_PASS_NOT_FOUND',
      'DEVICE_PASS_CODE_USED',
      'DEVICE_PASS_CODE_LIMIT',
    ],
  },
  async (c) => {
    requireOn(c);
    requireKey(c);
    const ctx = serviceContext(c);
    const auth = sessionOf(c);
    const { id } = c.req.valid('param');
    return idempotentJson(
      c,
      ctx,
      { orgId: 'device-pass', mode: 'test', principal: principalOf(auth), body: { id } },
      201,
      async () => ({ devicePass: await issueCode(ctx, auth, id) }),
      undefined,
      withoutCode,
    );
  },
);

register(
  developerDevicePassRoutes,
  TAG,
  {
    method: 'post',
    path: '/{id}/again',
    summary:
      'Add again: a new device pass from the same source after the old one expired or was voided. It counts against the 5 (Idempotency-Key)',
    operationId: 'developer.postDevicePassesByIdAgain',
    auth: STEP_UP_AUTH,
    params: IdParamSchema,
    status: 201,
    response: DevicePassResponseSchema,
    codes: [...WRITE_CODES, 'DEVICE_PASS_NOT_FOUND', 'DEVICE_PASS_STILL_OPEN'],
  },
  async (c) => {
    requireOn(c);
    requireKey(c);
    const ctx = serviceContext(c);
    const auth = sessionOf(c);
    const { id } = c.req.valid('param');
    return idempotentJson(
      c,
      ctx,
      { orgId: 'device-pass', mode: 'test', principal: principalOf(auth), body: { id } },
      201,
      async () => ({ devicePass: await addAgain(ctx, auth, id) }),
      undefined,
      withoutCode,
    );
  },
);

register(
  developerDevicePassRoutes,
  TAG,
  {
    method: 'delete',
    path: '/{id}',
    summary: 'Void a device pass: its phones get the voided copy',
    operationId: 'developer.deleteDevicePassesById',
    auth: READ,
    params: IdParamSchema,
    response: DevicePassResponseSchema,
    codes: ['DEVICE_PASS_NOT_FOUND'],
  },
  async (c) => {
    requireOn(c);
    return c.json({
      devicePass: await voidOwn(serviceContext(c), sessionOf(c), c.req.valid('param').id),
    });
  },
);
