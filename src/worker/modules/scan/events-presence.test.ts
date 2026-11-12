import { beforeEach, describe, expect, it } from 'vitest';
import { makeSession, makeUser } from '../../../../test/helpers/index.ts';
import { ScanOutcomeSchema } from '../../../shared/contracts/scan.ts';
import { run } from '../../platform/db.ts';
import { createSessionStore } from '../auth/sessions.ts';
import { ensureCredentialRefKeyset } from '../passes/credential-keyset.ts';
import { tenantAuthorityOf } from '../passes/http.ts';
import { captureEventAuthority, eventView, listEvents } from './events.ts';
import type { EventAuthority } from './repo-event-keyset.ts';
import { codeOf, grantScanMembership, key, type ScanKit, setupScanKit } from './test-kit.ts';

let kit: ScanKit;
let authority: EventAuthority;

beforeEach(async () => {
  kit = await setupScanKit();
  await ensureCredentialRefKeyset(kit.env.DB, kit.env);
  const user = await makeUser(kit.fx);
  await grantScanMembership(kit.fx, kit.org.id, user.id, ['read_only']);
  const session = await makeSession(kit.fx, { userId: user.id });
  const auth = await createSessionStore(kit.env, kit.clock).resolve(session.cookieValue);
  if (!auth) throw new Error('Missing event reader session.');
  authority = await captureEventAuthority(
    kit.ctx,
    auth,
    await tenantAuthorityOf(kit.ctx, auth, kit.org.id, 'scanning:read'),
  );
});

describe('event arrivals across action scopes', () => {
  it.each(['once', 'daily', 'cooldown', 'always'] as const)(
    'counts each admitted pass once for %s check-ins',
    async (repeat) => {
      const templateId = await kit.scanTemplate('Event attendance', {
        actions: [
          {
            id: 'check_in',
            label: 'Check in',
            kind: 'check_in',
            repeat,
            ...(repeat === 'cooldown' ? { cooldownMinutes: 5 } : {}),
          },
        ],
      });
      const event = await kit.event({ templateIds: [templateId] });
      const scanner = await kit.scanner({ eventId: event.id });
      const first = await kit.scanPass(templateId);
      const second = await kit.scanPass(templateId);
      const at = kit.clock.now();
      const request = {
        input: codeOf(first),
        actionId: 'check_in',
        clientTs: at,
        idempotencyKey: key(),
      };
      const act = async (body: typeof request) => {
        const response = await kit.post(scanner.headers, '/actions', body);
        expect(response.status).toBe(200);
        return ScanOutcomeSchema.parse(await response.json());
      };
      const admitted = await act(request);
      expect(admitted.kind).toBe('ok');
      expect(admitted.counts.event?.arrived).toBe(1);
      expect((await eventView(kit.ctx, event.id, authority)).arrived).toBe(1);
      const replay = await act(request);
      expect(replay.replay).toBe(true);
      expect((await eventView(kit.ctx, event.id, authority)).arrived).toBe(1);
      expect((await act({ ...request, input: codeOf(second), idempotencyKey: key() })).kind).toBe(
        'ok',
      );
      expect((await eventView(kit.ctx, event.id, authority)).arrived).toBe(2);
      const page = await listEvents(kit.ctx, 'live', { orgId: kit.org.id, limit: 50 }, authority);
      expect(page.items.find((item) => item.id === event.id)?.arrived).toBe(2);
      await run(kit.env.DB, 'UPDATE passes SET test_data_quarantined=1 WHERE id=?', [second.id]);
      expect((await eventView(kit.ctx, event.id, authority)).arrived).toBe(1);
    },
  );

  it('removes an undone admission while retaining other witnessed arrivals', async () => {
    const templateId = await kit.scanTemplate('Undo attendance', {
      actions: [{ id: 'check_in', label: 'Check in', kind: 'check_in', repeat: 'once' }],
    });
    const event = await kit.event({ templateIds: [templateId] });
    const scanner = await kit.scanner({ eventId: event.id });
    const first = await kit.scanPass(templateId);
    const second = await kit.scanPass(templateId);
    const admit = async (pass: typeof first) => {
      const response = await kit.post(scanner.headers, '/actions', {
        input: codeOf(pass),
        actionId: 'check_in',
        clientTs: kit.clock.now(),
        idempotencyKey: key(),
      });
      expect(response.status).toBe(200);
      const outcome = ScanOutcomeSchema.parse(await response.json());
      expect(outcome.kind).toBe('ok');
      if (!outcome.scanId) throw new Error('Missing successful check-in.');
      return outcome.scanId;
    };
    const firstScan = await admit(first);
    await admit(second);
    expect((await eventView(kit.ctx, event.id, authority)).arrived).toBe(2);
    const undo = await kit.post(scanner.headers, `/scans/${firstScan}/undo`, {
      idempotencyKey: key(),
    });
    expect(undo.status).toBe(200);
    expect((await eventView(kit.ctx, event.id, authority)).arrived).toBe(1);
  });
});
