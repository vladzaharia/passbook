import type { Context } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { z } from 'zod';
import type { AppBindings } from '../../platform/context.ts';
import { PayloadTooLargeError } from '../../platform/errors.ts';
import { createRouter, register } from '../../platform/openapi.ts';
import { clientIp, rateLimit } from '../../platform/rate-limit.ts';
import { servePassFile } from '../passes/file.ts';
import { type C, svc, valid } from '../passes/http.ts';
import { personalize } from './personalize.ts';
import {
  authorizePass,
  recordDeviceLogs,
  registerDevice,
  unregisterDevice,
  updatedSerials,
} from './service.ts';

const device = z.object({ deviceId: z.string(), passTypeId: z.string() });
const serial = device.extend({ serial: z.string() });
const passParams = z.object({ passTypeId: z.string(), serial: z.string() });

/** /wallet/v1: Apple Wallet web service. Authorization: ApplePass <token>. */
export const appleRoutes = createRouter();
// Phones behind one NAT share an IP, so the per-IP layer is wide and the tight limits are per
// device and per pass. /log has neither, so it keeps the IP key.
appleRoutes.use('*', rateLimit('RL_APPLE_IP'));
const byDevice = (c: Context<AppBindings>) => `device:${c.req.param('deviceId')?.slice(0, 128)}`;
export const passRateKey = (passTypeId: string | undefined, serial: string | undefined) =>
  `pass:${passTypeId?.slice(0, 128)}:${serial?.slice(0, 64)}`;
const byPass = (c: Context<AppBindings>) =>
  passRateKey(c.req.param('passTypeId'), c.req.param('serial'));
appleRoutes.use('/devices/:deviceId/*', rateLimit('RL_APPLE', byDevice));
appleRoutes.use('/passes/:passTypeId/:serial', rateLimit('RL_APPLE', byPass));
appleRoutes.use('/passes/:passTypeId/:serial/personalize', rateLimit('RL_APPLE', byPass));
appleRoutes.use('/log', rateLimit('RL_APPLE'));
appleRoutes.use(
  '*',
  bodyLimit({
    maxSize: 64 * 1024,
    onError: () => {
      throw new PayloadTooLargeError();
    },
  }),
);

const empty = (status: 200 | 201 | 204) => new Response(null, { status });

register(
  appleRoutes,
  'apple',
  {
    method: 'post',
    path: '/devices/{deviceId}/registrations/{passTypeId}/{serial}',
    summary: 'Register a device',
    params: serial,
    status: 201,
  },
  async (c: C) => {
    const p = valid<z.infer<typeof serial>>(c, 'param');
    const body = (await c.req.json().catch(() => null)) as { pushToken?: unknown } | null;
    const outcome = await registerDevice(svc(c), {
      ...p,
      authorization: c.req.header('authorization'),
      pushToken: body?.pushToken,
    });
    return empty(outcome === 'created' ? 201 : 200);
  },
);

register(
  appleRoutes,
  'apple',
  {
    method: 'delete',
    path: '/devices/{deviceId}/registrations/{passTypeId}/{serial}',
    summary: 'Unregister a device',
    params: serial,
  },
  async (c: C) => {
    await unregisterDevice(svc(c), {
      ...valid<z.infer<typeof serial>>(c, 'param'),
      authorization: c.req.header('authorization'),
    });
    return empty(200);
  },
);

register(
  appleRoutes,
  'apple',
  {
    method: 'get',
    path: '/devices/{deviceId}/registrations/{passTypeId}',
    summary: 'Serials updated since a tag',
    params: device,
    query: z.object({ passesUpdatedSince: z.string().optional() }),
  },
  async (c: C) => {
    const p = valid<z.infer<typeof device>>(c, 'param');
    const q = valid<{ passesUpdatedSince?: string }>(c, 'query');
    const result = await updatedSerials(svc(c), { ...p, since: q.passesUpdatedSince });
    return result ? c.json(result) : empty(204);
  },
);

register(
  appleRoutes,
  'apple',
  {
    method: 'get',
    path: '/passes/{passTypeId}/{serial}',
    summary: 'Latest pass (If-Modified-Since, 304)',
    params: passParams,
  },
  async (c: C) => {
    const p = valid<z.infer<typeof passParams>>(c, 'param');
    const { pass } = await authorizePass(
      svc(c),
      p.passTypeId,
      p.serial,
      c.req.header('authorization'),
    );
    return servePassFile(c.env.BUCKET, pass, c.req.raw);
  },
);

register(
  appleRoutes,
  'apple',
  {
    method: 'post',
    path: '/passes/{passTypeId}/{serial}/personalize',
    summary: 'Pass personalization (NFC identities only; no ApplePass header)',
    params: passParams,
  },
  async (c: C) => {
    const signed = await personalize(svc(c), {
      ...valid<z.infer<typeof passParams>>(c, 'param'),
      body: await c.req.json().catch(() => null),
    });
    return new Response(signed as BodyInit, {
      headers: { 'content-type': 'application/octet-stream' },
    });
  },
);

register(
  appleRoutes,
  'apple',
  {
    method: 'post',
    path: '/log',
    summary: 'Device log lines',
    body: z.object({ logs: z.array(z.string().max(10_000)).max(1000) }),
    status: 200,
  },
  async (c: C) => {
    await recordDeviceLogs(svc(c), valid<{ logs: string[] }>(c, 'json').logs, clientIp(c));
    return empty(200);
  },
);
