import { z } from 'zod';
import { createRouter, stub } from '../../platform/openapi.ts';
import { rateLimit } from '../../platform/rate-limit.ts';

const device = z.object({ deviceId: z.string(), passTypeId: z.string() });
const serial = device.extend({ serial: z.string() });
const passParams = z.object({ passTypeId: z.string(), serial: z.string() });

/** /wallet/v1: Apple Wallet web service. Authorization: ApplePass <token>. */
export const appleRoutes = createRouter();
appleRoutes.use('*', rateLimit('RL_APPLE'));
stub(appleRoutes, 'apple', {
  method: 'post',
  path: '/devices/{deviceId}/registrations/{passTypeId}/{serial}',
  summary: 'Register a device',
  params: serial,
  status: 201,
});
stub(appleRoutes, 'apple', {
  method: 'delete',
  path: '/devices/{deviceId}/registrations/{passTypeId}/{serial}',
  summary: 'Unregister a device',
  params: serial,
});
stub(appleRoutes, 'apple', {
  method: 'get',
  path: '/devices/{deviceId}/registrations/{passTypeId}',
  summary: 'Serials updated since a tag',
  params: device,
  query: z.object({ passesUpdatedSince: z.string().optional() }),
});
stub(appleRoutes, 'apple', {
  method: 'get',
  path: '/passes/{passTypeId}/{serial}',
  summary: 'Latest pass (If-Modified-Since, 304)',
  params: passParams,
});
stub(appleRoutes, 'apple', {
  method: 'post',
  path: '/passes/{passTypeId}/{serial}/personalize',
  summary: 'Pass personalization (NFC identities only)',
  params: passParams,
});
stub(appleRoutes, 'apple', {
  method: 'post',
  path: '/log',
  summary: 'Device log lines',
  body: z.object({ logs: z.array(z.string()).max(100) }),
  status: 200,
});
