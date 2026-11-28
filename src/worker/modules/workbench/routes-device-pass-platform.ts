import {
  DevicePassDeveloperSchema,
  VoidedDevicePassesSchema,
} from '../../../shared/contracts/device-passes.ts';
import { OkSchema } from '../../../shared/contracts/index.ts';
import { UnauthenticatedError } from '../../platform/errors.ts';
import { createRouter, register } from '../../platform/openapi.ts';
import { serviceContext } from '../../platform/service-context.ts';
import { STEP_UP_SECONDS } from '../../platform/sign-in-guard.ts';
import { clearBlock, voidAllOf } from './device-pass-platform.ts';

/** Mount at /api/v1/platform. Person-only: a platform admin session, never a key. Works while the flag is off. */
export const devicePassPlatformRoutes = createRouter();

const WRITE = { platform: 'platform:users', stepUp: { maxAgeSec: STEP_UP_SECONDS } } as const;

register(
  devicePassPlatformRoutes,
  'platform',
  {
    method: 'post',
    path: '/device-passes/void',
    summary: 'Void every open device pass of one developer; their phones get the voided copy',
    operationId: 'platform.postDevicePassesVoid',
    auth: WRITE,
    body: DevicePassDeveloperSchema,
    response: VoidedDevicePassesSchema,
  },
  async (c) => {
    const auth = c.var.auth;
    if (auth?.kind !== 'session') throw new UnauthenticatedError();
    const voided = await voidAllOf(serviceContext(c), auth, c.req.valid('json').userId);
    return c.json({ voided });
  },
);

register(
  devicePassPlatformRoutes,
  'platform',
  {
    method: 'post',
    path: '/device-passes/unblock',
    summary: 'Let a developer make device passes again after one was shared',
    operationId: 'platform.postDevicePassesUnblock',
    auth: WRITE,
    body: DevicePassDeveloperSchema,
    response: OkSchema,
  },
  async (c) => {
    const auth = c.var.auth;
    if (auth?.kind !== 'session') throw new UnauthenticatedError();
    await clearBlock(serviceContext(c), auth, c.req.valid('json').userId);
    return c.json({ ok: true as const });
  },
);
