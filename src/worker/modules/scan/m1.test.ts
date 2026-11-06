import { beforeEach, describe, expect, it } from 'vitest';
import type { ScanOutcome } from '../../../shared/contracts/scan.ts';
import type { ScanKit } from './test-kit.ts';
import { codeOf, key, setupScanKit } from './test-kit.ts';

let kit: ScanKit;
let templateId: string;
beforeEach(async () => {
  kit = await setupScanKit();
  templateId = await kit.scanTemplate('Door ticket', {
    actions: [{ id: 'enter', label: 'Check in', kind: 'check_in', repeat: 'once' }],
  });
});
const scope = () => ({ orgId: kit.org.id, timeZone: 'UTC' });
const checkIn = async () => {
  const pass = await kit.scanPass(templateId);
  const response = await kit.post(kit.admin(), '/actions', {
    idempotencyKey: key(),
    input: codeOf(pass),
    clientTs: kit.clock.now(),
    actionId: 'enter',
    scope: scope(),
  });
  expect(response.status).toBe(200);
  return { pass, outcome: (await response.json()) as ScanOutcome };
};

describe('M1 door integration', () => {
  it('undo commits once, changes counts and permits a new check-in', async () => {
    const { pass, outcome } = await checkIn();
    expect(outcome.kind).toBe('ok');
    const body = { idempotencyKey: key(), scope: scope() };
    const call = () => kit.post(kit.admin(), `/scans/${outcome.scanId}/undo`, body);
    const first = await call();
    expect(first.status).toBe(200);
    expect(await first.json()).toMatchObject({ kind: 'ok', counts: { today: 0 } });
    expect(await (await call()).json()).toMatchObject({ replay: true });
    const again = await kit.post(kit.admin(), '/actions', {
      idempotencyKey: key(),
      input: codeOf(pass),
      clientTs: kit.clock.now(),
      actionId: 'enter',
      scope: scope(),
    });
    expect(await again.json()).toMatchObject({ kind: 'ok', counts: { today: 1 } });
    const events = await kit.env.DB.prepare(
      "SELECT count(*) AS n FROM pass_events WHERE kind = 'scan.undone'",
    ).first<{ n: number }>();
    expect(events?.n).toBe(1);
  });

  it('only one concurrent undo changes the gate', async () => {
    const { outcome } = await checkIn();
    const results = await Promise.all(
      Array.from({ length: 3 }, () =>
        kit.post(kit.admin(), `/scans/${outcome.scanId}/undo`, {
          idempotencyKey: key(),
          scope: scope(),
        }),
      ),
    );
    expect(results.map((r) => r.status).sort()).toEqual([200, 409, 409]);
  });

  it('cannot undo a check-in in another mode', async () => {
    const { outcome } = await checkIn();
    const response = await kit.post(
      { ...kit.admin(), 'x-passbook-mode': 'test' },
      `/scans/${outcome.scanId}/undo`,
      { idempotencyKey: key(), scope: scope() },
    );
    expect(response.status).toBe(404);
  });

  it('searches prefixes, masks exact email and never searches partial email', async () => {
    await kit.scanPass(
      templateId,
      { memberName: 'Annabelle' },
      { holderEmail: 'anna@example.com' },
    );
    const search = async (q: string) =>
      (await kit.post(kit.admin(), '/lookup', { q, scope: scope() })).json();
    expect(await search('Ann')).toMatchObject({
      items: [{ title: 'Annabelle', maskedEmail: 'a•••@e•••.com' }],
      more: false,
    });
    expect(await search('anna@example.com')).toMatchObject({ items: [{ title: 'Annabelle' }] });
    expect(await search('anna@exam')).toEqual({ items: [], more: false });
    expect(await search('An')).toEqual({ items: [], more: false });
    const audits = await kit.env.DB.prepare(
      "SELECT detail FROM audit_log WHERE action = 'scan.lookup'",
    ).all();
    expect(JSON.stringify(audits.results)).not.toContain('Ann');
  });

  it('renders a real template display and excludes secret inputs', async () => {
    const { outcome } = await checkIn();
    expect(outcome.display?.identity.holder).toBe('Anna Popescu');
    expect(outcome.display?.templateVersion).not.toBe('');
    expect(JSON.stringify(outcome.display)).not.toContain('scanCode');
  });
});

describe('M1 concurrent event arrivals', () => {
  it('enforces capacity atomically across different passes', async () => {
    const event = await kit.event({ templateIds: [templateId] });
    await kit.env.DB.prepare('UPDATE scan_events SET capacity = 1 WHERE id = ?')
      .bind(event.id)
      .run();
    const scanner = await kit.scanner({ eventId: event.id });
    const passes = await Promise.all(Array.from({ length: 3 }, () => kit.scanPass(templateId)));
    const outcomes = await Promise.all(
      passes.map(async (pass) => {
        const response = await kit.post(scanner.headers, '/actions', {
          idempotencyKey: key(),
          input: codeOf(pass),
          clientTs: kit.clock.now(),
          actionId: 'enter',
        });
        expect(response.status).toBe(200);
        return (await response.json()) as ScanOutcome;
      }),
    );
    expect(outcomes.filter((o) => o.kind === 'ok')).toHaveLength(1);
    expect(outcomes.filter((o) => o.reason === 'capacity_full')).toHaveLength(2);
  });
});
