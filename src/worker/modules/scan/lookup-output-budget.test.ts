import { describe, expect, it } from 'vitest';
import { countD1 } from '../../../../test/helpers/index.ts';
import type { ScanOutcome } from '../../../shared/contracts/scan.ts';
import { clearSettingsCache } from '../settings/service.ts';
import {
  kit,
  registerLookupOutputFixture,
  resolveRequest,
  scannerForLookup,
  setupPhoto,
  templateId,
} from './lookup-output-test-fixtures.ts';

registerLookupOutputFixture();

describe('lookup output authority', () => {
  it('keeps a cold photo resolve with verified history within five D1 trips after the guard', async () => {
    const pass = await setupPhoto();
    const event = await kit.event({ templateIds: [templateId] });
    const scanner = await kit.scanner({ eventId: event.id });
    const response = await kit.post(scanner.headers, '/actions', {
      ...resolveRequest(pass.scanCode!),
      actionId: 'enter',
    });
    expect(response.status).toBe(200);
    const scan = (await response.json()) as { kind: string; scanId: string | null };
    expect(scan.kind).toBe('ok');
    const real = kit.env.DB;
    const counted = countD1(real);
    Object.assign(kit.env, { DB: counted.db });
    try {
      await kit.post(scanner.headers, '/resolve', {});
      const guard = counted.count();
      counted.reset();
      clearSettingsCache(counted.db);
      const resolved = await kit.post(scanner.headers, '/resolve', resolveRequest(pass.scanCode!));
      expect(resolved.status).toBe(200);
      const outcome = (await resolved.json()) as ScanOutcome;
      expect(outcome).toMatchObject({ kind: 'ready', card: { passId: pass.id } });
      expect(outcome.card?.lastScans.map((row) => row.scanId)).toContain(scan.scanId);
      expect(outcome.card?.display.identity.photo?.url).toContain('/assets/member.png?g=');
      expect(counted.count() - guard).toBeLessThanOrEqual(5);
    } finally {
      Object.assign(kit.env, { DB: real });
    }
  });

  it('keeps a cold resolve miss, including its final miss accounting, within five trips after the guard', async () => {
    await setupPhoto();
    const { scanner } = await scannerForLookup();
    const real = kit.env.DB;
    const counted = countD1(real);
    Object.assign(kit.env, { DB: counted.db });
    try {
      await kit.post(scanner.headers, '/resolve', {});
      const guard = counted.count();
      counted.reset();
      clearSettingsCache(counted.db);
      const response = await kit.post(
        scanner.headers,
        '/resolve',
        resolveRequest('not-present-729'),
      );
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({
        reason: 'not_found',
        card: null,
        display: null,
      });
      expect(counted.count() - guard).toBeLessThanOrEqual(5);
    } finally {
      Object.assign(kit.env, { DB: real });
    }
  });
});
