import { beforeAll, expect, it } from 'vitest';
import { run } from '../../platform/db.ts';
import { codeOf, key, type ScanKit, setupScanKit } from './test-kit.ts';

let kit: ScanKit;

beforeAll(async () => {
  kit = await setupScanKit();
});

it('redacts private action, template, flag and previous scanner labels on gate results', async () => {
  const actionLabel = 'action-private@example.test';
  const templateName = 'template-private@example.test';
  const flagLabel = 'flag-private@example.test';
  const scannerName = 'scanner-private@example.test';
  const templateId = await kit.scanTemplate(templateName, {
    actions: [{ id: 'check_in', label: actionLabel, kind: 'check_in', repeat: 'once' }],
    flags: [{ input: 'tier', label: flagLabel, equals: ['blocked'], stop: false }],
  });
  const pass = await kit.scanPass(templateId, { tier: 'blocked' });
  const scanner = await kit.scanner({ templateIds: [templateId] });
  await run(kit.env.DB, 'UPDATE scanners SET name=? WHERE id=?', [scannerName, scanner.id]);
  const request = () =>
    kit.post(scanner.headers, '/actions', {
      input: codeOf(pass),
      idempotencyKey: key(),
      clientTs: kit.clock.now(),
      actionId: 'check_in',
    });

  const first = await request();
  expect(first.status).toBe(200);
  const firstText = await first.text();
  expect(JSON.parse(firstText)).toMatchObject({
    kind: 'ok',
    action: null,
    template: null,
    flags: [],
  });
  for (const privateValue of [actionLabel, templateName, flagLabel, scannerName])
    expect(firstText).not.toContain(privateValue);

  const held = await request();
  expect(held.status).toBe(200);
  const heldText = await held.text();
  expect(JSON.parse(heldText)).toMatchObject({
    kind: 'heads_up',
    reason: 'already_done',
    action: null,
    template: null,
    flags: [],
    previous: { scannerName: 'Scanner', actionLabel: 'Scan' },
  });
  for (const privateValue of [actionLabel, templateName, flagLabel, scannerName])
    expect(heldText).not.toContain(privateValue);
});

it('does not repeat an opaque Wallet value as previous scanner or staff names', async () => {
  const secret = 'opaque-wallet-scanner-value';
  const templateId = await kit.scanTemplate(
    'Door entry',
    {
      actions: [{ id: 'check_in', label: 'Check in', kind: 'check_in', repeat: 'once' }],
    },
    { passStyle: { userInfo: { internalValue: secret } } },
  );
  const pass = await kit.scanPass(templateId);
  const staff = await kit.staff('door', secret);
  const scanner = await kit.scanner({
    templateIds: [templateId],
    staffId: staff.id,
    settings: { staffSignIn: true },
  });
  await run(kit.env.DB, 'UPDATE scanners SET name=? WHERE id=?', [secret, scanner.id]);
  const request = () =>
    kit.post(scanner.headers, '/actions', {
      input: codeOf(pass),
      idempotencyKey: key(),
      clientTs: kit.clock.now(),
      actionId: 'check_in',
    });
  expect((await request()).status).toBe(200);
  const held = await request();
  expect(held.status).toBe(200);
  const text = await held.text();
  expect(JSON.parse(text)).toMatchObject({
    kind: 'heads_up',
    previous: { scannerName: 'Scanner', staffName: null },
  });
  expect(text).not.toContain(secret);
});
