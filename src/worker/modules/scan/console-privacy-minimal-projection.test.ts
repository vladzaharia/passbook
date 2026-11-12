import { describe, expect, it } from 'vitest';
import { first, run } from '../../platform/db.ts';
import { recordedCheckIn } from './console-privacy-actions-test-fixtures.ts';
import {
  fake,
  kit,
  page,
  privatePass,
  setupPrivacyKit,
  templateId,
} from './console-privacy-test-fixtures.ts';
import { key } from './test-kit.ts';

setupPrivacyKit();

const projectionOf = async (scanId: string) => {
  const row = await first<{ data: string }>(
    kit.env.DB,
    "SELECT data FROM pass_events WHERE json_extract(data, '$.scanId') = ?",
    [scanId],
  );
  if (!row) throw new Error('A recorded scan must have its pass event.');
  const { authority } = JSON.parse(row.data) as {
    authority: { role: string; eventProjection: { roles: Record<string, unknown> } };
  };
  return { role: authority.role, roles: authority.eventProjection.roles };
};

/** The console and the API-key feed read the same event. */
const readers = async (scanId: string) => {
  const apiKey = fake.apiKey({ orgId: kit.org.id, scopes: ['scans:read'] });
  const console = (await page(`?orgId=${kit.org.id}`)).items.find((item) => item.id === scanId);
  const feed = (await page('', apiKey)).items.find((item) => item.id === scanId);
  return { apiKey, console, feed };
};

const walletExpiry = (passId: string, at: string) =>
  run(
    kit.env.DB,
    "UPDATE pass_versions SET pass_json = json_set(pass_json, '$.expirationDate', ?) WHERE pass_id = ?",
    [at, passId],
  );

describe('console and API-key feed on the event role projection', () => {
  it('both show the pass of an event that projected its recorded role', async () => {
    const scanner = await kit.scanner({ templateIds: [templateId] });
    const pass = await privatePass();
    const row = await recordedCheckIn(scanner, pass.id);
    const { role, roles } = await projectionOf(row.id);
    expect(Object.hasOwn(roles, role)).toBe(true);
    const { apiKey, console, feed } = await readers(row.id);
    expect(console).toMatchObject({ passId: pass.id, templateId, scannerId: scanner.id });
    expect(feed).toMatchObject({ passId: pass.id, templateId, scannerId: scanner.id });
    expect((await page(`?passId=${pass.id}`, apiKey)).items).toMatchObject([{ id: row.id }]);
  });

  // A refusal without a usable pass records the minimal projection (`roles: {}`). Once the pass is
  // usable again the event verifies, and neither reader may show the pass it never projected.
  it.each([
    ['voided', 'reinstated'],
    ['expired', 'renewed'],
  ] as const)('both hide the pass of a %s refusal after it is %s', async (reason, _restored) => {
    const scanner = await kit.scanner({ templateIds: [templateId] });
    const pass = await privatePass();
    if (reason === 'voided')
      await run(kit.env.DB, "UPDATE passes SET status = 'voided' WHERE id = ?", [pass.id]);
    else await walletExpiry(pass.id, '2020-01-01T00:00:00Z');
    kit.clock.advance(1000);
    const response = await kit.post(scanner.headers, '/actions', {
      idempotencyKey: key(),
      input: { passId: pass.id, method: 'manual' },
      clientTs: kit.clock.now(),
      actionId: 'check_in',
    });
    expect(response.status).toBe(200);
    const outcome: { kind: string; reason: string; scanId: string } = await response.json();
    expect(outcome).toMatchObject({ kind: 'refused', reason });
    expect((await projectionOf(outcome.scanId)).roles).toEqual({});
    if (reason === 'voided')
      await run(kit.env.DB, "UPDATE passes SET status = 'active' WHERE id = ?", [pass.id]);
    else await walletExpiry(pass.id, '2099-01-01T00:00:00Z');

    const { apiKey, console, feed } = await readers(outcome.scanId);
    // The event verified (the scanner shows), but its pass was never projected.
    expect(console).toMatchObject({ passId: null, templateId: null, scannerId: scanner.id });
    expect(feed).toMatchObject({
      passId: null,
      templateId: null,
      scannerId: scanner.id,
      kind: null,
      actionId: null,
    });
    expect(JSON.stringify(feed)).not.toContain(pass.id);
    expect((await page(`?passId=${pass.id}`, apiKey)).items).toEqual([]);
  });
});
