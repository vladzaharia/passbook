import { describe, expect, it } from 'vitest';
import { run } from '../../platform/db.ts';
import { racedResolve } from './output-authority-raced-resolve-test-fixtures.ts';
import {
  changeAfterProjection,
  fixture,
  kit,
  noDisclosure,
  raceFence,
  templateId,
} from './repo-output-authority-split-test-fixtures.ts';
import { key } from './test-kit.ts';

describe('atomic scanner response authority', () => {
  it.each([
    'scanner',
    'wallet-personalization',
    'identity-aba',
    'credential-generation',
    'lifecycle-generation',
    'release-adapter',
  ] as const)('suppresses a heads-up card when %s changes after projection', async (change) => {
    await racedResolve(
      await fixture({ tier: 'overdue', photo: true, olderAdapter: change === 'release-adapter' }),
      change,
    );
  });

  it('serves a heads-up card when an identical release of the pass version lands', async () => {
    await racedResolve(await fixture({ tier: 'overdue', photo: true }), 'release');
  });

  it('suppresses a pass-bearing refused stop after its actor is revoked', async () => {
    const f = await fixture();
    const firstEvent = await kit.event({ templateIds: [templateId] });
    const secondEvent = await kit.event({ templateIds: [templateId] });
    const scanner = await kit.scanner({ eventId: firstEvent.id });
    await run(
      kit.env.DB,
      'INSERT INTO pass_check_in(pass_id,org_id,rules,updated_at) VALUES (?,?,?,?)',
      [f.pass.id, kit.org.id, JSON.stringify({ eventId: secondEvent.id }), kit.clock.now()],
    );
    const request = { input: { passId: f.pass.id, method: 'manual' }, clientTs: kit.clock.now() };
    const baseline = await kit.post(scanner.headers, '/resolve', {
      ...request,
      idempotencyKey: key(),
    });
    expect(await baseline.json()).toMatchObject({ kind: 'refused', reason: 'wrong_event' });
    const real = kit.env.DB;
    const race = raceFence(real, () =>
      run(real, 'UPDATE scanners SET revoked_at=? WHERE id=?', [kit.clock.now(), scanner.id]),
    );
    Object.assign(kit.env, { DB: race.db });
    try {
      const response = await kit.post(scanner.headers, '/resolve', {
        ...request,
        idempotencyKey: key(),
      });
      expect(race.fired()).toBe(true);
      const text = await response.text();
      expect(JSON.parse(text)).toMatchObject({
        kind: 'refused',
        reason: 'not_found',
        card: null,
        display: null,
      });
      noDisclosure(text, f.pass.id);
    } finally {
      Object.assign(kit.env, { DB: real });
    }
  });

  it.each(['test', 'live'] as const)(
    'returns only the actor-authorized generic %s-mode detection when its Wallet changes',
    async (mode) => {
      const f = await fixture({ mode });
      const scanner =
        mode === 'test'
          ? f.scanner
          : await kit.scanner({ mode: 'test', templateIds: [templateId] });
      const real = kit.env.DB;
      const race = raceFence(real, () => changeAfterProjection(f, real, 'wallet-personalization'));
      Object.assign(kit.env, { DB: race.db });
      try {
        const response = await kit.post(scanner.headers, '/resolve', {
          idempotencyKey: key(),
          input: { passId: f.pass.id, method: 'manual' },
          clientTs: kit.clock.now(),
        });
        expect(race.fired()).toBe(true);
        const text = await response.text();
        expect(JSON.parse(text)).toMatchObject({
          kind: 'refused',
          reason: mode === 'test' ? 'test_pass' : 'live_pass',
          scanId: null,
          card: null,
          display: null,
          template: null,
        });
        noDisclosure(text, f.pass.id);
        expect(text).not.toContain(f.pass.serial);
      } finally {
        Object.assign(kit.env, { DB: real });
      }
    },
  );

  it('masks cross-mode detection after the actor is revoked', async () => {
    const f = await fixture({ mode: 'test' });
    const real = kit.env.DB;
    const race = raceFence(real, () =>
      run(real, 'UPDATE scanners SET revoked_at=? WHERE id=?', [kit.clock.now(), f.scanner.id]),
    );
    Object.assign(kit.env, { DB: race.db });
    try {
      const response = await kit.post(f.scanner.headers, '/resolve', {
        idempotencyKey: key(),
        input: { passId: f.pass.id, method: 'manual' },
        clientTs: kit.clock.now(),
      });
      expect(race.fired()).toBe(true);
      const text = await response.text();
      expect(JSON.parse(text)).toMatchObject({
        kind: 'refused',
        reason: 'not_found',
        template: null,
        card: null,
        display: null,
      });
      noDisclosure(text, f.pass.id);
    } finally {
      Object.assign(kit.env, { DB: real });
    }
  });

  it.each(['wallet-personalization', 'identity-aba'] as const)(
    'lists the item the read matched when only content (%s) changes during the audit',
    async (change) => {
      const f = await fixture({ photo: true });
      const real = kit.env.DB;
      const race = raceFence(real, () => changeAfterProjection(f, real, change), 2);
      Object.assign(kit.env, { DB: race.db });
      try {
        const response = await kit.post(f.scanner.headers, '/lookup', { q: f.pass.id });
        expect(race.fired()).toBe(true);
        expect(response.status).toBe(200);
        expect((await response.json()) as { items: unknown[] }).toMatchObject({
          items: [{ passId: f.pass.id }],
        });
      } finally {
        Object.assign(kit.env, { DB: real });
      }
    },
  );

  it.each(['scanner', 'credential-generation', 'lifecycle-generation', 'release-adapter'] as const)(
    'rechecks actor and source together after lookup auditing when %s changes',
    async (change) => {
      const f = await fixture({ photo: true, olderAdapter: change === 'release-adapter' });
      const real = kit.env.DB;
      // The first combined read precedes audit; mutate only after it, at the final read.
      const race = raceFence(real, () => changeAfterProjection(f, real, change), 2);
      Object.assign(kit.env, { DB: race.db });
      try {
        const response = await kit.post(f.scanner.headers, '/lookup', { q: f.pass.id });
        expect(race.fired()).toBe(true);
        const text = await response.text();
        if (change === 'release-adapter') {
          // The release differs from the pass's own: a real race, retryable, nothing disclosed.
          expect(response.status).toBe(409);
          expect(JSON.parse(text)).toMatchObject({ code: 'SCAN_PASS_CHANGED' });
        } else {
          expect(response.status).toBe(200);
          expect(JSON.parse(text)).toEqual({ items: [], more: false });
        }
        noDisclosure(text, f.pass.id);
      } finally {
        Object.assign(kit.env, { DB: real });
      }
    },
  );

  it('still lists the pass when an identical release of its version lands during the audit', async () => {
    const f = await fixture({ photo: true });
    const real = kit.env.DB;
    const race = raceFence(real, () => changeAfterProjection(f, real, 'release'), 2);
    Object.assign(kit.env, { DB: race.db });
    try {
      const response = await kit.post(f.scanner.headers, '/lookup', { q: f.pass.id });
      expect(race.fired()).toBe(true);
      expect(response.status).toBe(200);
      expect((await response.json()) as { items: unknown[] }).toMatchObject({
        items: [{ passId: f.pass.id }],
      });
    } finally {
      Object.assign(kit.env, { DB: real });
    }
  });

  it.each([
    'photo',
    'photo-version',
    'photo-key',
    'photo-digest',
    'photo-inclusion',
    'photo-aba',
  ] as const)(
    'retains lookup identity while suppressing a %s changed after audit',
    async (change) => {
      const f = await fixture({ photo: true });
      const real = kit.env.DB;
      const race = raceFence(real, () => changeAfterProjection(f, real, change), 2);
      Object.assign(kit.env, { DB: race.db });
      try {
        const response = await kit.post(f.scanner.headers, '/lookup', { q: f.pass.id });
        expect(race.fired()).toBe(true);
        expect(response.status).toBe(200);
        const text = await response.text();
        expect(JSON.parse(text)).toMatchObject({
          items: [{ passId: f.pass.id, photoUrl: null }],
          more: false,
        });
        expect(text).not.toContain('member.png');
        expect(text).not.toContain('assetGrant');
      } finally {
        Object.assign(kit.env, { DB: real });
      }
    },
  );

  it('lists the item its exact lookup key matched when the key changes during the audit, and not on the next read', async () => {
    const memberNo = 'REVOKED-OUTPUT-KEY';
    const f = await fixture({ memberNo });
    if (!f.candidate.lookupHash) throw new Error('Missing lookup key.');
    const real = kit.env.DB;
    const race = raceFence(
      real,
      () =>
        run(real, 'UPDATE passes SET lookup_hash=NULL,revision=revision+1 WHERE id=?', [f.pass.id]),
      2,
    );
    Object.assign(kit.env, { DB: race.db });
    try {
      const response = await kit.post(f.scanner.headers, '/lookup', { q: memberNo });
      expect(race.fired()).toBe(true);
      // The key is derived from content: the answer is the read's own.
      expect(await response.json()).toMatchObject({ items: [{ passId: f.pass.id }] });
    } finally {
      Object.assign(kit.env, { DB: real });
    }
    const next = await kit.post(f.scanner.headers, '/lookup', { q: memberNo });
    expect(await next.json()).toEqual({ items: [], more: false });
  });

  it('filters only the stale member from a multi-item lookup at one final snapshot', async () => {
    const pairName = 'Unique Output Pair';
    const a = await fixture({ memberName: pairName });
    const b = await fixture({ memberName: pairName });
    const real = kit.env.DB;
    const race = raceFence(real, () => changeAfterProjection(a, real, 'lifecycle-generation'), 2);
    Object.assign(kit.env, { DB: race.db });
    try {
      const response = await kit.post(a.scanner.headers, '/lookup', { q: pairName });
      expect(race.fired()).toBe(true);
      const text = await response.text();
      const result = JSON.parse(text) as { items: { passId: string }[]; more: boolean };
      expect(result.items.map((item) => item.passId)).toContain(b.pass.id);
      expect(result.items.map((item) => item.passId)).not.toContain(a.pass.id);
      expect(text).not.toContain(a.pass.id);
    } finally {
      Object.assign(kit.env, { DB: real });
    }
  });
});
