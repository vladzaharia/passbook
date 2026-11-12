import { describe, expect, it } from 'vitest';
import { consoleCall, create, setupScannerFixture } from './scanners-split-test-fixtures.ts';

setupScannerFixture();

const TAKEN = { code: 'SCANNER_NAME_TAKEN', detail: 'Another scanner already has that name.' };

/** A removed scanner's name may be reused; restoring it then collides with the active one. */
async function removedWithTwin(kind: 'device' | 'terminal') {
  const name = `Twin ${kind}`;
  const removed = (await create({ name, kind })).body;
  expect((await consoleCall('POST', `/${removed.id}/revoke`)).status).toBe(200);
  const twin = await create({ name, kind });
  expect(twin.res.status).toBe(201);
  return { removed: removed.id, twin: twin.body.id };
}

describe('restoring a removed scanner whose name was taken', () => {
  it('answers 409 SCANNER_NAME_TAKEN for a pairing code and pair-here, then restores once renamed', async () => {
    const { removed, twin } = await removedWithTwin('device');
    for (const path of ['pairing', 'pair-here']) {
      const res = await consoleCall('POST', `/${removed}/${path}?restore=true`);
      expect(res.status).toBe(409);
      expect(await res.json()).toMatchObject(TAKEN);
    }
    expect((await consoleCall('PATCH', `/${twin}`, { name: 'Twin renamed' })).status).toBe(200);
    expect((await consoleCall('POST', `/${removed}/pairing?restore=true`)).ok).toBe(true);
  });

  it('answers 409 SCANNER_NAME_TAKEN for a till token, then restores once renamed', async () => {
    const { removed, twin } = await removedWithTwin('terminal');
    const res = await consoleCall('POST', `/${removed}/token?restore=true`);
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject(TAKEN);
    expect((await consoleCall('PATCH', `/${twin}`, { name: 'Till renamed' })).status).toBe(200);
    expect((await consoleCall('POST', `/${removed}/token?restore=true`)).ok).toBe(true);
  });
});
