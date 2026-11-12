import { describe, expect, it } from 'vitest';
import { makeApiKey, makeScanEvent, makeScanner } from '../../../../test/helpers/index.ts';
import { ScanEventSchema } from '../../../shared/contracts/index.ts';
import { first } from '../../platform/db.ts';
import {
  call,
  clock,
  env,
  eventId,
  f,
  freeScannerId,
  input,
  member,
  operator,
  orgId,
  page,
  primaryTemplate,
  reader,
  templateId,
  unrelatedRole,
} from './events-tenant-split-test-fixtures.ts';
import { state } from './repo-events-tenant-state-test-fixtures.ts';
import { makeLegacyScanPass } from './test-kit.ts';

describe('scan event tenant routes', () => {
  it('allows scanning readers but denies their configuration writes and unrelated roles', async () => {
    expect((await call(reader, 'GET', `?orgId=${orgId}`)).status).toBe(200);
    expect((await call(reader, 'GET', `/${eventId}`)).status).toBe(200);
    expect((await call(operator, 'GET', `?orgId=${orgId}`)).status).toBe(200);
    expect((await call(operator, 'GET', `/${eventId}`)).status).toBe(200);
    const before = await state();
    expect((await call(reader, 'POST', '', input())).status).toBe(403);
    expect((await call(reader, 'PATCH', `/${eventId}`, { name: 'Changed' })).status).toBe(403);
    expect((await call(reader, 'POST', `/${eventId}/archive`)).status).toBe(403);
    expect(
      (await call(reader, 'POST', `/${eventId}/scanners`, { scannerIds: [freeScannerId] })).status,
    ).toBe(403);
    expect((await call(operator, 'POST', '', input())).status).toBe(403);
    expect((await call(operator, 'PATCH', `/${eventId}`, { name: 'Changed' })).status).toBe(403);
    expect((await call(operator, 'POST', `/${eventId}/archive`)).status).toBe(403);
    expect(
      (await call(operator, 'POST', `/${eventId}/scanners`, { scannerIds: [freeScannerId] }))
        .status,
    ).toBe(403);
    expect((await call(unrelatedRole, 'GET', `?orgId=${orgId}`)).status).toBe(403);
    expect((await call(unrelatedRole, 'GET', `/${eventId}`)).status).toBe(403);
    expect(await state()).toEqual(before);
  });

  it('persists an authorized detail recount', async () => {
    const detail = await call(reader, 'GET', `/${eventId}`);
    expect(detail.status).toBe(200);
    expect(ScanEventSchema.parse(await detail.json()).expected).toBe(0);
    expect(
      await first<{ expected: number | null; expected_at: number | null }>(
        env.DB,
        'SELECT expected, expected_at FROM scan_events WHERE id = ?',
        [eventId],
      ),
    ).toEqual({ expected: 0, expected_at: clock.now() });
  });

  it('recounts every event in a 21-item page, including fresh caches', async () => {
    for (let i = 0; i < 20; i++) {
      await makeScanEvent(f, { orgId, templateIds: [templateId] });
    }
    await makeLegacyScanPass(f, { orgId, template: primaryTemplate.resolved });
    const cached = async () =>
      (
        await first<{ n: number }>(
          env.DB,
          'SELECT count(*) AS n FROM scan_events WHERE org_id = ? AND expected_at IS NOT NULL',
          [orgId],
        )
      )?.n;
    const firstPage = await page(await call(reader, 'GET', `?orgId=${orgId}`));
    expect(firstPage.items).toHaveLength(21);
    expect(firstPage.items.every((item) => item.expected === 1)).toBe(true);
    expect(await cached()).toBe(10);
    const secondPage = await page(await call(reader, 'GET', `?orgId=${orgId}`));
    expect(secondPage.items.every((item) => item.expected === 1)).toBe(true);
    expect(await cached()).toBe(20);
    const thirdPage = await page(await call(reader, 'GET', `?orgId=${orgId}`));
    expect(thirdPage.items.every((item) => item.expected === 1)).toBe(true);
    expect(await cached()).toBe(21);
    await makeLegacyScanPass(f, { orgId, template: primaryTemplate.resolved });
    const changed = await page(await call(reader, 'GET', `?orgId=${orgId}`));
    expect(changed.items).toHaveLength(21);
    expect(changed.items.every((item) => item.expected === 2)).toBe(true);
  });

  it('scopes modes and rejects scanner and API principals', async () => {
    const testId = (await makeScanEvent(f, { orgId, mode: 'test' })).id;
    const liveEvents = await page(await call(member, 'GET', `?orgId=${orgId}`));
    expect(liveEvents.items.map((item) => item.id)).not.toContain(testId);
    expect(await page(await call(member, 'GET', `?orgId=${orgId}&cursor=${testId}`))).toEqual({
      items: [],
      nextCursor: null,
    });
    expect((await call(member, 'GET', `/${testId}`)).status).toBe(404);
    const testSession = { headers: { ...member.headers, 'x-passbook-mode': 'test' } };
    const testEvents = await page(await call(testSession, 'GET', `?orgId=${orgId}`));
    expect(testEvents.items.map((item) => item.id)).toContain(testId);
    expect((await call(testSession, 'GET', `/${testId}`)).status).toBe(200);
    expect((await call(member, 'PATCH', `/${testId}`, { name: 'Wrong mode' })).status).toBe(404);
    expect((await call(member, 'POST', `/${testId}/archive`)).status).toBe(404);
    expect(
      (await call(member, 'POST', `/${testId}/scanners`, { scannerIds: [freeScannerId] })).status,
    ).toBe(404);
    const created = await call(testSession, 'POST', '', input());
    expect(created.status).toBe(201);
    expect(ScanEventSchema.parse(await created.json()).mode).toBe('test');
    const key = await makeApiKey(f, { orgId, scopes: ['scans:read'] });
    expect((await call(key, 'GET', `?orgId=${orgId}`)).status).toBe(401);
    const globalKey = await makeApiKey(f, { orgId: null, scopes: ['scans:read'] });
    expect((await call(globalKey, 'GET', `?orgId=${orgId}`)).status).toBe(401);
    expect((await call(globalKey, 'GET', `/${eventId}`)).status).toBe(401);
    expect((await call(globalKey, 'PATCH', `/${eventId}`, { name: 'Forbidden' })).status).toBe(401);
    const scanner = await makeScanner(f, { orgId, kind: 'terminal' });
    expect((await call(scanner, 'GET', `?orgId=${orgId}`)).status).toBe(401);
  });

  it('advances same-clock event and scanner revisions', async () => {
    const eventRevision = async () =>
      (
        await first<{ updated_at: number }>(
          env.DB,
          'SELECT updated_at FROM scan_events WHERE id = ?',
          [eventId],
        )
      )?.updated_at ?? 0;
    const scannerRevision = async () =>
      (
        await first<{ updated_at: number }>(
          env.DB,
          'SELECT updated_at FROM scanners WHERE id = ?',
          [freeScannerId],
        )
      )?.updated_at ?? 0;
    const initial = await eventRevision();
    expect((await call(member, 'PATCH', `/${eventId}`, { capacity: 5 })).status).toBe(200);
    const edited = await eventRevision();
    expect(edited).toBeGreaterThan(initial);
    expect((await call(member, 'PATCH', `/${eventId}`, { capacity: 6 })).status).toBe(200);
    const editedAgain = await eventRevision();
    expect(editedAgain).toBeGreaterThan(edited);
    const scannerInitial = await scannerRevision();
    expect(
      (await call(member, 'POST', `/${eventId}/scanners`, { scannerIds: [freeScannerId] })).status,
    ).toBe(200);
    const assigned = await scannerRevision();
    expect(assigned).toBeGreaterThan(scannerInitial);
    expect((await call(member, 'POST', `/${eventId}/archive`)).status).toBe(200);
    const archived = await eventRevision();
    expect(archived).toBeGreaterThan(editedAgain);
    expect(await scannerRevision()).toBeGreaterThan(assigned);
    expect((await call(member, 'PATCH', `/${eventId}`, { archived: false })).status).toBe(200);
    expect(await eventRevision()).toBeGreaterThan(archived);
  });
});
