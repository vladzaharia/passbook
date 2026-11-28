import { describe, expect, it } from 'vitest';
import { makeOrg, runOne } from '../../../../test/helpers/index.ts';
import { withoutTrigger } from '../../../../test/helpers/triggers.ts';
import { first } from '../../platform/db.ts';
import { afterBatch, beforeBatch } from './batch-interceptor-test-support.ts';
import { recordedCheckIn, recordedNoMatch } from './console-privacy-actions-test-fixtures.ts';
import {
  expectNoSecrets,
  exportPath,
  fake,
  get,
  kit,
  lastExportCount,
  PUBLIC,
  page,
  privatePass,
  setupPrivacyKit,
  templateId,
} from './console-privacy-test-fixtures.ts';
import { RACE_HISTORY_PAGE, tagRe } from './race-tags.ts';
import { startScanCredentialTransfer } from './test-kit.ts';

setupPrivacyKit();

type Surface = 'console' | 'api key' | 'export';

const body = async (surface: Surface, apiKey: Record<string, string>) => {
  const response =
    surface === 'console'
      ? await get(`?orgId=${kit.org.id}`)
      : surface === 'api key'
        ? await get('', apiKey)
        : await get(exportPath());
  expect(response.status).toBe(200);
  return response.text();
};

const csvLines = (text: string) =>
  text
    .replace(/^\uFEFF/, '')
    .trimEnd()
    .split('\r\n');

describe('scan console and feed privacy', () => {
  it.each(['console', 'api key', 'export'] as const)(
    'does not expose a ledger row when its scanner becomes foreign before %s output, and stops showing it after',
    async (surface) => {
      const scanner = await kit.scanner({ templateIds: [templateId] });
      const row = await recordedNoMatch(scanner);
      const other = await makeOrg(kit.fx);
      const apiKey = fake.apiKey({ orgId: kit.org.id, scopes: ['scans:read'] });
      const { result: text, fired } = await beforeBatch(
        kit.env,
        tagRe(RACE_HISTORY_PAGE),
        async (db) => {
          await runOne(db, 'UPDATE scanners SET org_id = ? WHERE id = ?', [other.id, scanner.id]);
        },
        () => body(surface, apiKey),
      );
      expect(fired).toBe(true);
      if (surface === 'export') {
        expect(csvLines(text)).toHaveLength(1);
        expect(text).not.toContain(new Date(row.at).toISOString());
      } else {
        expect(JSON.parse(text)).toMatchObject({ items: [] });
        expect(text).not.toContain(row.id);
        expect(text).not.toContain(scanner.id);
      }
    },
  );

  it.each([
    ['console', 'voided'],
    ['api key', 'voided'],
    ['export', 'voided'],
    ['console', 'credential'],
    ['api key', 'credential'],
    ['export', 'credential'],
    ['console', 'lifecycle'],
    ['api key', 'lifecycle'],
    ['export', 'lifecycle'],
  ] as const)(
    'serves immutable history to %s output after a %s change that came before its page',
    async (surface, change) => {
      const scanner = await kit.scanner({ templateIds: [templateId] });
      const pass = await privatePass();
      const row = await recordedCheckIn(scanner, pass.id);
      const apiKey = fake.apiKey({ orgId: kit.org.id, scopes: ['scans:read'] });
      const mutate = async (db: D1Database) => {
        if (change === 'credential') {
          expect(await startScanCredentialTransfer(kit, pass.id, { db })).toMatchObject({
            state: 'completed',
          });
        } else {
          const mutation =
            change === 'voided'
              ? "UPDATE passes SET status = 'voided' WHERE id = ?"
              : 'UPDATE passes SET lifecycle_generation = lifecycle_generation + 1 WHERE id = ?';
          // A pass update also moves row_version; D1 counts trigger changes.
          await runOne(db, mutation, [pass.id]);
        }
      };
      // A lifecycle bump alone does not withdraw history: the event never named it, so a read that
      // sees the bump is as current as one that does not. Voiding or rotating the credential does.
      const expectRedacted = (text: string) => {
        if (change === 'lifecycle') {
          expect(text).toContain(surface === 'api key' ? pass.id : PUBLIC);
          return;
        }
        if (surface === 'export') {
          expect(csvLines(text)).toHaveLength(2);
          expect(text).toContain(new Date(row.at).toISOString());
        } else {
          const result = JSON.parse(text) as { items: unknown[] };
          expect(result.items).toHaveLength(1);
          expect(result.items[0]).toMatchObject({
            id: row.id,
            at: row.at,
            outcome: 'ok',
            passId: null,
            templateId: null,
            kind: null,
            actionId: null,
            before: null,
            after: null,
          });
        }
        expectNoSecrets(text, pass);
        expect(text).not.toContain(pass.id);
        expect(text).not.toContain(PUBLIC);
      };

      const before = await beforeBatch(kit.env, tagRe(RACE_HISTORY_PAGE), mutate, () =>
        body(surface, apiKey),
      );
      expect(before.fired).toBe(true);
      expectRedacted(before.result);
    },
  );

  it.each(['console', 'api key', 'export'] as const)(
    'answers %s output from the page snapshot when the pass changes after it, and redacts the next read',
    async (surface) => {
      const scanner = await kit.scanner({ templateIds: [templateId] });
      const pass = await privatePass();
      const row = await recordedCheckIn(scanner, pass.id);
      const apiKey = fake.apiKey({ orgId: kit.org.id, scopes: ['scans:read'] });
      const snapshot = await afterBatch(
        kit.env,
        tagRe(RACE_HISTORY_PAGE),
        async (db) => {
          await runOne(db, "UPDATE passes SET status = 'voided' WHERE id = ?", [pass.id]);
        },
        () => body(surface, apiKey),
      );
      expect(snapshot.fired).toBe(true);
      // The snapshot still held the live pass: a control that the redaction below is the change.
      if (surface === 'api key') expect(snapshot.result).toContain(pass.id);
      if (surface === 'console') expect(snapshot.result).toContain(PUBLIC);
      const next = await body(surface, apiKey);
      expect(next).not.toContain(PUBLIC);
      expect(next).not.toContain(pass.id);
      expect(next).toContain(surface === 'export' ? new Date(row.at).toISOString() : row.id);
    },
  );

  it('retains a scan minimally when its signing identity no longer matches the Wallet', async () => {
    const scanner = await kit.scanner({ templateIds: [templateId] });
    const pass = await privatePass();
    const row = await recordedCheckIn(scanner, pass.id);
    const identity = await first<{ identity_id: string }>(
      kit.env.DB,
      'SELECT identity_id FROM passes WHERE id = ?',
      [pass.id],
    );
    if (!identity) throw new Error('The issued pass must have a signing identity.');
    await withoutTrigger(kit.env.DB, 'signing_identities_pti_immutable', () =>
      runOne(kit.env.DB, 'UPDATE signing_identities SET team_identifier = ? WHERE id = ?', [
        'OTHERTEAM',
        identity.identity_id,
      ]),
    );

    const history = await page(`?orgId=${kit.org.id}`);
    expect(history.items).toHaveLength(1);
    expect(history.items[0]).toMatchObject({
      id: row.id,
      passId: null,
      templateId: null,
      passTitle: null,
      kind: null,
      actionId: null,
    });
    expect((await page(`?orgId=${kit.org.id}&passId=${pass.id}`)).items).toEqual([]);
    const apiKey = fake.apiKey({ orgId: kit.org.id, scopes: ['scans:read'] });
    expect((await page('', apiKey)).items[0]).toMatchObject({
      id: row.id,
      passId: null,
      templateId: null,
    });
    const detail = await get(`/${row.id}`);
    expect(detail.status).toBe(200);
    expect(await detail.json()).toMatchObject({ id: row.id, passId: null, passTitle: null });
    const exported = await get(exportPath());
    expect(exported.status).toBe(200);
    const csv = await exported.text();
    expect(
      csv
        .replace(/^\uFEFF/, '')
        .trimEnd()
        .split('\r\n'),
    ).toHaveLength(2);
    expect(csv).not.toContain(pass.id);
    expect(csv).not.toContain(PUBLIC);
    expect(await lastExportCount()).toBe(1);
  });
});
