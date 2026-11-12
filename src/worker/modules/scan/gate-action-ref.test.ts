import { beforeAll, expect, it } from 'vitest';
import { first, run } from '../../platform/db.ts';
import type { EventRow } from '../events/repo.ts';
import { scanById } from './repo-scans.ts';
import { scanActionIdRef } from './scan-action-ref.ts';
import { verifyScanEventProvenance } from './scan-event-proof.ts';
import { codeOf, key, type ScanKit, setupScanKit } from './test-kit.ts';

let kit: ScanKit;
beforeAll(async () => {
  kit = await setupScanKit();
});

it('keeps a private action ID out of recorded event data and rejects forged references', async () => {
  const secret = 'private-wallet-action-id';
  const templateId = await kit.scanTemplate(
    'Opaque action identity',
    {
      actions: [{ id: secret, label: 'Check in', kind: 'check_in', repeat: 'always' }],
    },
    { passStyle: { userInfo: { internalAction: secret } } },
  );
  const pass = await kit.scanPass(templateId);
  const scanner = await kit.scanner({ templateIds: [templateId] });
  const idempotencyKey = key();
  const request = () =>
    kit.post(scanner.headers, '/actions', {
      input: codeOf(pass),
      idempotencyKey,
      clientTs: kit.clock.now(),
      actionId: secret,
    });
  const response = await request();
  expect(response.status).toBe(200);
  const result = (await response.json()) as { kind: string; scanId: string | null };
  expect(result.kind).toBe('ok');
  if (!result.scanId) throw new Error('Missing committed scan');
  const event = await first<EventRow>(
    kit.env.DB,
    "SELECT * FROM pass_events WHERE pass_id=? AND json_extract(data,'$.scanId')=?",
    [pass.id, result.scanId],
  );
  const scan = await scanById(kit.env.DB, kit.org.id, result.scanId);
  if (!event || !scan) throw new Error('Missing committed evidence');
  expect(event.data).not.toContain(secret);
  const retention = await first<{ scan_id: string; ledger_event_id: string; pass_ref: string }>(
    kit.env.DB,
    'SELECT * FROM scan_retention_proofs WHERE scan_id=?',
    [result.scanId],
  );
  expect(retention).toMatchObject({ scan_id: result.scanId, ledger_event_id: event.id });
  expect(retention?.pass_ref).toMatch(/^[0-9a-f]{64}$/);
  expect(JSON.stringify(retention)).not.toContain(pass.id);
  expect(JSON.stringify(retention)).not.toContain(secret);
  const data = JSON.parse(event.data) as {
    actionIdRef: string;
    authority: {
      pinnedTemplateVersion: string;
      walletVersion: number;
      walletTemplateVersion: string | null;
      effect: { gateAfter: { actionIdRef: string } };
    };
  };
  const ref = await scanActionIdRef(kit.env, {
    orgId: pass.orgId,
    mode: pass.mode,
    templateId,
    actionId: secret,
  });
  expect(ref).toMatch(/^[0-9a-f]{64}$/);
  expect(data.actionIdRef).toBe(ref);
  expect(data.authority.effect.gateAfter.actionIdRef).toBe(ref);
  const reference = {
    ...scan,
    pinnedTemplateVersion: data.authority.pinnedTemplateVersion,
    walletVersion: data.authority.walletVersion,
    walletTemplateVersion: data.authority.walletTemplateVersion,
    direction: scan.direction ?? null,
    presenceScope: scan.presenceScope ?? null,
  };
  expect(await verifyScanEventProvenance(kit.env, event, reference)).toBe(true);
  expect(
    await verifyScanEventProvenance(kit.env, event, { ...reference, actionId: 'different-action' }),
  ).toBe(false);
  const cache = new Map<string, Promise<boolean>>();
  expect(await verifyScanEventProvenance(kit.env, event, reference, cache)).toBe(true);
  expect([...cache.keys()].join('')).not.toContain(secret);

  // Ledger rows keep plain facts: no event proof is stored, and none is needed to read them.
  const envelope = JSON.parse(event.data) as { authority: Record<string, unknown> };
  expect(Object.hasOwn(envelope.authority, 'eventProof')).toBe(false);
  const forgedReason = { ...JSON.parse(event.data), reason: 'not_found' };
  expect(
    await verifyScanEventProvenance(
      kit.env,
      { ...event, data: JSON.stringify(forgedReason) },
      reference,
    ),
  ).toBe(false);
  // The action reference is keyed: another key ring does not recognise it.
  const keys = Object.fromEntries(
    Object.entries(kit.env).filter(([name]) => /^KEK_V\d+$/.test(name)),
  ) as Record<string, string>;
  const changed = Object.fromEntries(Object.keys(keys).map((name) => [name, btoa('x'.repeat(32))]));
  expect(await verifyScanEventProvenance(keys, event, reference)).toBe(true);
  expect(await verifyScanEventProvenance(changed, event, reference)).toBe(false);

  const forgedGate = structuredClone(data);
  forgedGate.authority.effect.gateAfter.actionIdRef = '0'.repeat(64);
  expect(
    await verifyScanEventProvenance(
      kit.env,
      { ...event, data: JSON.stringify(forgedGate) },
      reference,
    ),
  ).toBe(false);
  const forgedRaw = { ...data, actionId: secret };
  expect(
    await verifyScanEventProvenance(
      kit.env,
      { ...event, data: JSON.stringify(forgedRaw) },
      reference,
    ),
  ).toBe(false);
  await run(kit.env.DB, 'UPDATE pass_events SET data=? WHERE id=?', [
    JSON.stringify(forgedRaw),
    event.id,
  ]);
  const replay = await request();
  expect(replay.status).toBe(200);
  expect(await replay.json()).toMatchObject({ kind: 'refused', reason: 'not_found' });
});
