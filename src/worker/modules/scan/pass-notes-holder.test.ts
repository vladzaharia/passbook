import { beforeAll, describe, expect, it } from 'vitest';
import type { HistoryPage, PassNote } from '../../../shared/contracts/scan-history.ts';
import { all, first, run } from '../../platform/db.ts';
import { jobCtxOf } from '../delivery/delivery-test-fixtures.ts';
import { getHolderPass } from '../holders/repo.ts';
import {
  finishCredentialTransfer,
  startCredentialTransfer,
} from '../passes/credential-transfer.ts';
import { key, type ScanKit, setupScanKit } from './test-kit.ts';

let kit: ScanKit;
let templateId: string;

beforeAll(async () => {
  kit = await setupScanKit();
  templateId = await kit.scanTemplate('Holders', {
    actions: [{ id: 'enter', label: 'Check in', kind: 'check_in', repeat: 'always' }],
  });
});

const desk = () =>
  kit.scanner({ templateIds: [templateId], settings: { roleWithoutSignIn: 'desk' } });
const note = (passId: string, headers: Record<string, string>, text = 'Nut allergy') =>
  kit.post(headers, `/passes/${passId}/notes`, { body: text, idempotencyKey: key() });
const notes = async (passId: string, headers: Record<string, string>) =>
  ((await (await kit.get(headers, `/passes/${passId}/notes`)).json()) as { items: PassNote[] })
    .items;
const history = async (passId: string, headers: Record<string, string>) =>
  ((await (await kit.get(headers, `/passes/${passId}/history`)).json()) as HistoryPage).items;

async function transfer(passId: string) {
  const expected = await getHolderPass(kit.env.DB, passId, null);
  if (!expected) throw new Error('Missing holder source');
  const started = await startCredentialTransfer(
    jobCtxOf(kit),
    { type: 'system', id: null },
    passId,
    { holderEmail: 'next@example.test', ownerUserId: null },
    null,
    { kind: 'tenant-holder', expected },
  );
  await finishCredentialTransfer(jobCtxOf(kit), started.transferId);
}

describe('a new holder starts clean', () => {
  it('notes and visits of the previous holder are gone after a transfer, and never read by the next', async () => {
    const pass = await kit.scanPass(templateId);
    const { headers } = await desk();
    const checkedIn = await kit.post(headers, '/actions', {
      input: { passId: pass.id, method: 'manual' },
      idempotencyKey: key(),
      clientTs: kit.clock.now(),
      actionId: 'enter',
    });
    expect(checkedIn.status).toBe(200);
    kit.clock.advance(1000);
    expect((await note(pass.id, headers)).status).toBe(200);
    expect(await notes(pass.id, headers)).toHaveLength(1);
    expect((await history(pass.id, headers)).map((i) => i.event)).toEqual(['note', 'checked_in']);
    kit.clock.advance(1000);
    await transfer(pass.id);
    kit.clock.advance(1000);
    expect(await all(kit.env.DB, 'SELECT 1 FROM pass_notes WHERE pass_id = ?', [pass.id])).toEqual(
      [],
    );
    expect(await notes(pass.id, headers)).toEqual([]);
    expect(await history(pass.id, headers)).toEqual([]);
    // The next holder's own note shows, under the new generation.
    expect((await note(pass.id, headers, 'Prefers the side door')).status).toBe(200);
    expect((await notes(pass.id, headers)).map((n) => n.body)).toEqual(['Prefers the side door']);
  });

  it('a note of an older generation that survived is still never read', async () => {
    const pass = await kit.scanPass(templateId);
    const { headers } = await desk();
    await run(
      kit.env.DB,
      `INSERT INTO pass_notes (id, org_id, mode, pass_id, credential_generation, body, author_name, idempotency_key, created_at)
       VALUES (?, ?, 'live', ?, ?, 'old holder', 'Desk', 'k', ?)`,
      [kit.fx.ids.id(), kit.org.id, pass.id, pass.credentialGeneration + 1, kit.clock.now()],
    );
    // Written for a generation the pass is not on: neither the notes nor the history list it.
    expect(await notes(pass.id, headers)).toEqual([]);
    expect(await history(pass.id, headers)).toEqual([]);
    expect(
      await first(kit.env.DB, 'SELECT 1 FROM pass_notes WHERE pass_id = ?', [pass.id]),
    ).not.toBeNull();
  });
});
