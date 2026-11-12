import { expect } from 'vitest';
import { type FakeAuth, fakeAuth } from '../../../../test/helpers/index.ts';
import { ScanSessionSchema } from '../../../shared/contracts/scan-session.ts';
import {
  CreatedScanningDeviceSchema,
  ScanningSessionDetailSchema,
} from '../../../shared/contracts/scanning-sessions.ts';
import { createApp } from '../../app.ts';
import { createScannerStore } from './auth-store.ts';
import { type ScanKit, setupScanKit } from './test-kit.ts';

export function scanningSessionsFixture() {
  let kit: ScanKit;
  let fake: FakeAuth;
  let userHeaders: Record<string, string>;
  let call: (
    method: string,
    path: string,
    body?: unknown,
    headers?: Record<string, string>,
  ) => Promise<Response>;

  async function setup() {
    kit = await setupScanKit();
    fake = fakeAuth('https://wallet.test');
    fake.bindSessions(kit.env.DB, kit.clock);
    userHeaders = fake.user();
    const app = createApp({
      stores: { ...fake.stores, scanners: createScannerStore(kit.env, kit.clock) },
      clock: kit.clock,
    });
    call = (method, path, body, headers = fake.admin()) =>
      Promise.resolve(
        app.request(
          `https://wallet.test/api/v1${path}`,
          {
            method,
            headers: { ...headers, 'content-type': 'application/json' },
            ...(body === undefined ? {} : { body: JSON.stringify(body) }),
          },
          kit.env,
        ),
      );
  }

  async function parent(name: string) {
    const response = await call('POST', '/scanning-sessions', {
      orgId: kit.org.id,
      name,
      timeZone: 'UTC',
    });
    expect(response.status).toBe(201);
    return ScanningSessionDetailSchema.parse(await response.json());
  }
  async function device(sessionId: string, name: string, surface = 'auto') {
    const response = await call('POST', `/scanning-sessions/${sessionId}/devices`, {
      name,
      surface,
    });
    expect(response.status).toBe(201);
    return CreatedScanningDeviceSchema.parse(await response.json());
  }
  async function pair(code: string) {
    const response = await call('POST', '/scan/pair', { code }, { origin: 'https://wallet.test' });
    expect(response.status).toBe(200);
    const cookie = response.headers.get('set-cookie')?.split(';')[0] ?? '';
    const data = ScanSessionSchema.parse(await response.json());
    return { cookie, origin: 'https://wallet.test', 'x-csrf-token': data.csrfToken ?? '' };
  }

  return {
    setup,
    get kit() {
      return kit;
    },
    get fake() {
      return fake;
    },
    get userHeaders() {
      return userHeaders;
    },
    get call() {
      return call;
    },
    parent,
    device,
    pair,
  };
}
