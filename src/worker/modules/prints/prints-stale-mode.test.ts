import { describe, expect, it } from 'vitest';
import { run } from '../../platform/db.ts';
import { jobCtxOf } from '../delivery/delivery-test-fixtures.ts';
import { ruleKit } from '../message-rules/test-kit.ts';
import { approveAppleRelease } from '../passes/apple-release-test-fixtures.ts';
import { createPassRow } from '../passes/create.ts';
import { clearSettingsCache } from '../settings/service.ts';

const json = { 'content-type': 'application/json' };

describe('staff print page of a Test pass', () => {
  it('opens, downloads and records a redraw with ?mode=test, and not without it', async () => {
    const kit = await ruleKit();
    await run(
      kit.env.DB,
      "INSERT OR REPLACE INTO settings (scope, key, value, updated_by, updated_at) VALUES ('platform', 'print.enabled', 'true', 'test', 1)",
    );
    clearSettingsCache(kit.env.DB);
    const release = await approveAppleRelease(kit, {
      templateId: kit.dated.id,
      version: 'v1',
      orgId: kit.org.id,
      mode: 'test',
    });
    const pass = await createPassRow(jobCtxOf(kit), {
      orgId: kit.org.id,
      templateId: kit.dated.id,
      templateVersion: release.version,
      releaseId: release.id,
      releaseGeneration: release.generation,
      input: { memberName: 'Test Holder' },
      holderEmail: null,
      source: 'manual',
      mode: 'test',
      execution: { kind: 'system' },
      actor: { type: 'system', id: null },
    });
    const test = { 'x-passbook-mode': 'test' };
    const send = (method: string, path: string, headers: Record<string, string> = {}) =>
      kit.api(path, { method, headers: { ...kit.auth.admin(), ...json, ...headers } });
    expect(
      (
        await kit.api(`/passes/${pass.id}/channels`, {
          method: 'PUT',
          headers: { ...kit.auth.admin(), ...json, ...test },
          body: JSON.stringify({ channels: { paper: 'on' } }),
        })
      ).status,
    ).toBe(200);
    expect((await send('POST', `/passes/${pass.id}/prints`, test)).status).toBe(200);

    const base = `/passes/${pass.id}/print`;
    expect((await send('GET', base)).status).toBe(409);
    const page = await send('GET', `${base}?mode=test`);
    expect(page.status).toBe(200);
    const html = await page.text();
    expect(html).toContain(`/print/pdf?mode=test`);
    expect(html).toContain('data-drawn="staff"');
    expect((await send('GET', `${base}/pdf?mode=test`)).status).toBe(200);
    expect((await send('POST', `${base}/drawn?mode=test`)).status).toBe(200);
    expect((await send('POST', `${base}/drawn`)).status).toBe(409);
    // Only the print paths read the query: a pass route does not.
    expect((await send('POST', `/passes/${pass.id}/prints?mode=test`)).status).toBe(409);
  });
});
