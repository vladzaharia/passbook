// The feed keeps a scan's pass across an org rename (config_revision is settings, not authority);
// a suspension (access_revision) before the page statement refuses the read, and one after it
// leaves the answer the page's snapshot gave.
import { describe, expect, it } from 'vitest';
import { runOne } from '../../../../test/helpers/index.ts';
import { afterBatch, beforeBatch } from './batch-interceptor-test-support.ts';
import { recordedCheckIn } from './console-privacy-actions-test-fixtures.ts';
import {
  get,
  kit,
  PUBLIC,
  privatePass,
  setupPrivacyKit,
  templateId,
} from './console-privacy-test-fixtures.ts';
import { RACE_HISTORY_PAGE } from './race-tags.ts';

setupPrivacyKit();

type Change = 'rename' | 'suspend';

const change = (kind: Change) => async (db: D1Database) => {
  if (kind === 'rename')
    await runOne(db, "UPDATE orgs SET name = name || ' (renamed)' WHERE id = ?", [kit.org.id]);
  else
    for (const status of ['suspended', 'active'])
      await runOne(db, 'UPDATE orgs SET status = ? WHERE id = ?', [status, kit.org.id]);
};

/** Apply `kind` once around the feed's page statement. */
async function pageRacing(kind: Change, when: 'before' | 'after') {
  const { result, fired } = await (when === 'before' ? beforeBatch : afterBatch)(
    kit.env,
    RACE_HISTORY_PAGE,
    change(kind),
    () => get(`?orgId=${kit.org.id}`),
  );
  expect(fired).toBe(true);
  return result;
}

describe('scan feed and the org epochs', () => {
  it.each(['before', 'after'] as const)(
    'keeps a feed row and its pass when an org rename comes %s the page',
    async (when) => {
      const pass = await privatePass();
      const scanner = await kit.scanner({ templateIds: [templateId] });
      const row = await recordedCheckIn(scanner, pass.id);
      await runOne(kit.env.DB, "UPDATE orgs SET name = name || ' (before)' WHERE id = ?", [
        kit.org.id,
      ]);
      const response = await pageRacing('rename', when);
      expect(response.status).toBe(200);
      const page = (await response.json()) as { items: { id: string; passId: string | null }[] };
      expect(page.items.find((item) => item.id === row.id)).toMatchObject({
        passId: pass.id,
        passTitle: PUBLIC,
      });
    },
  );

  it('refuses the read when a suspension comes before the page', async () => {
    const pass = await privatePass();
    const scanner = await kit.scanner({ templateIds: [templateId] });
    await recordedCheckIn(scanner, pass.id);
    const response = await pageRacing('suspend', 'before');
    expect(response.status).toBe(403);
    expect(await response.text()).not.toContain(PUBLIC);
  });

  it('answers from the page snapshot when a suspension comes after it', async () => {
    const pass = await privatePass();
    const scanner = await kit.scanner({ templateIds: [templateId] });
    const row = await recordedCheckIn(scanner, pass.id);
    const response = await pageRacing('suspend', 'after');
    expect(response.status).toBe(200);
    const page = (await response.json()) as { items: { id: string; passId: string | null }[] };
    expect(page.items.find((item) => item.id === row.id)?.passId).toBe(pass.id);
  });
});
