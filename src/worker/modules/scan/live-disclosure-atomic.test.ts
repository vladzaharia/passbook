import { describe, expect, it, vi } from 'vitest';
import { run } from '../../platform/db.ts';
import { jobCtxOf } from '../delivery/delivery-test-fixtures.ts';
import { createPassRow } from '../passes/create.ts';
import { memberPhoto } from '../passes/repo-member-photo.ts';
import { requireApprovedRelease } from '../templates/releases.ts';
import { type LiveAttachment, liveRecipient } from './live-auth.ts';
import { openLiveSourceProof } from './live-provenance.ts';
import { liveDisclosureCsrfStmts, liveDisclosureCurrent } from './repo-live-authority.ts';
import { candidateById } from './repo-lookup.ts';
import { scanSecretSlots } from './repo-secret-binds.ts';
import { setSetupWatchStmt } from './repo-setups-test-support.ts';
import { resolveOutcome } from './resolve-outcome.ts';
import {
  beginCredentialTransfer,
  hub,
  kit,
  observeCancellation,
  photoFixture,
  template,
} from './scan-hub-test-fixtures.ts';
import { codeOf, key } from './test-kit.ts';

type Statement = { sql: string; params: unknown[] };

/** Count executions, treating a D1 batch as one trip while retaining its individual binds. */
function traceD1(real: D1Database) {
  const trips: Statement[][] = [];
  const statements = new WeakMap<
    D1PreparedStatement,
    { real: D1PreparedStatement; seen: Statement }
  >();
  const wrap = (statement: D1PreparedStatement, seen: Statement): D1PreparedStatement => {
    const proxy = new Proxy(statement, {
      get(target, property) {
        if (property === 'bind')
          return (...params: unknown[]) => wrap(target.bind(...params), { sql: seen.sql, params });
        const value = Reflect.get(target, property, target);
        if (property === 'first' || property === 'all' || property === 'run' || property === 'raw')
          return (...args: unknown[]) => {
            trips.push([seen]);
            return (value as (...values: unknown[]) => unknown).apply(target, args);
          };
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    statements.set(proxy, { real: statement, seen });
    return proxy;
  };
  const db = new Proxy(real, {
    get(target, property) {
      if (property === 'prepare')
        return (sql: string) => wrap(target.prepare(sql), { sql, params: [] });
      if (property === 'batch')
        return (batch: D1PreparedStatement[]) => {
          const entries = batch.map((statement) => {
            const entry = statements.get(statement);
            if (!entry) throw new Error('Untraced D1 statement in batch.');
            return entry;
          });
          trips.push(entries.map((entry) => entry.seen));
          return target.batch(entries.map((entry) => entry.real));
        };
      if (property === 'exec')
        return (sql: string) => {
          trips.push([{ sql, params: [] }]);
          return target.exec(sql);
        };
      const value = Reflect.get(target, property, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  return { db, trips };
}

async function gateFixture(fixture: {
  event: { id: string };
  monitor: { attachment: LiveAttachment };
  pass: { id: string };
}) {
  const sealed = await hub().sourceProof(fixture.event.id);
  const proof = sealed && (await openLiveSourceProof(kit.env, sealed));
  const recipient = await liveRecipient(kit.ctx, fixture.monitor.attachment);
  const loaded = await candidateById(kit.env.DB, kit.org.id, fixture.pass.id);
  if (!proof || !recipient || !loaded) throw new Error('Missing live disclosure fixture.');
  const candidate = { ...loaded, ...proof.credentialContext };
  const stmts = liveDisclosureCsrfStmts(kit.env.DB, proof.actor, recipient.actor);
  if (!stmts.source || !stmts.recipient) throw new Error('Missing paired CSRF statements.');
  const [sourceResult, recipientResult] = await kit.env.DB.batch([stmts.source, stmts.recipient]);
  return {
    proof,
    recipient,
    candidate,
    input: {
      source: proof.actor,
      recipient,
      credentialContext: proof.credentialContext,
      candidate,
      requirePhoto: true,
    },
    results: { sourceResult, recipientResult },
  };
}

describe('atomic live disclosure', () => {
  it('redeems within five post-guard D1 trips with both CSRFs and grant in each atomic final fence', async () => {
    const fixture = await photoFixture();
    const candidate = await candidateById(kit.env.DB, kit.org.id, fixture.pass.id);
    if (!candidate?.passJsonSnapshot) throw new Error('Missing wallet snapshot.');
    const sourceCsrf = fixture.source.headers['x-csrf-token'];
    const recipientCsrf = fixture.monitor.headers['x-csrf-token'];
    const grant = new URL(fixture.path, 'https://wallet.test').searchParams.get('g');
    if (!sourceCsrf || !recipientCsrf || !grant) throw new Error('Missing secret fixture.');
    expect(sourceCsrf).not.toBe(recipientCsrf);

    const original = kit.env.DB;
    const trace = traceD1(original);
    Object.assign(kit.env, { DB: trace.db });
    let response: Response;
    try {
      response = await kit.get(fixture.monitor.headers, fixture.path);
    } finally {
      Object.assign(kit.env, { DB: original });
    }
    expect(response.status).toBe(200);
    const acquisition = trace.trips.findIndex(
      (trip) =>
        trip.some(({ sql }) => sql.includes('SELECT * FROM member_photos')) &&
        trip.some(({ sql }) => sql.includes('FROM scan_asset_grant_provenance')),
    );
    expect(acquisition).toBeGreaterThanOrEqual(0);
    expect(trace.trips.length - acquisition).toBeLessThanOrEqual(5);
    const statements = trace.trips.flat();
    const finals = trace.trips.filter((trip) =>
      trip.some(
        ({ sql }) =>
          sql.includes('scan-ephemeral-csrf:source:scanner') &&
          sql.includes('scan-ephemeral-csrf:recipient:scanner'),
      ),
    );
    expect(finals).toHaveLength(2);
    for (const trip of finals) {
      const combinedSql = trip.map(({ sql }) => sql).join('\n');
      expect(
        trip.every(({ sql, params }) => /^\s*SELECT\b/i.test(sql) && params.length < 100),
      ).toBe(true);
      expect(combinedSql).toMatch(/\bpasses\b/i);
      expect(combinedSql).toContain('credential_ref_keyset');
      expect(combinedSql).toContain('scan_asset_grant_provenance');
      expect(combinedSql).toContain('scan-ephemeral-wallet-json');
      const bound = trip.find(
        ({ sql }) =>
          sql.includes('scan-ephemeral-csrf:source:scanner') &&
          sql.includes('scan-ephemeral-csrf:recipient:scanner'),
      );
      if (!bound) throw new Error('Missing both final CSRF fences.');
      const { sql, params } = bound;
      const slots = scanSecretSlots(sql, params.length);
      if (!slots) throw new Error('Malformed final disclosure binds.');
      const source = slots.findIndex((slot) => slot.label === 'csrf:source:scanner');
      const recipient = slots.findIndex((slot) => slot.label === 'csrf:recipient:scanner');
      expect(source).toBeGreaterThanOrEqual(0);
      expect(recipient).toBeGreaterThanOrEqual(0);
      expect(params[source]).toBe(sourceCsrf);
      expect(params[recipient]).toBe(recipientCsrf);
    }
    for (const { sql, params } of statements) {
      for (const raw of [
        sourceCsrf,
        recipientCsrf,
        fixture.pass.authToken,
        fixture.pass.downloadToken,
        fixture.source.token,
        fixture.monitor.token,
        grant,
      ])
        expect(sql).not.toContain(raw);
      for (const param of params) {
        if (typeof param !== 'string') continue;
        for (const csrf of [sourceCsrf, recipientCsrf])
          if (param.includes(csrf)) expect(param).toBe(csrf);
        if (param.includes(fixture.pass.authToken) && param !== fixture.pass.authToken)
          expect(param).toBe(candidate.passJsonSnapshot);
        if (param.includes(fixture.pass.downloadToken))
          expect(param).toBe(fixture.pass.downloadToken);
        for (const token of [fixture.source.token, fixture.monitor.token, grant])
          expect(param).not.toContain(token);
      }
    }
    await response.body?.cancel();
  });

  it('rejects swapped or missing CSRF preflight results and a changed original watch', async () => {
    const fixture = await photoFixture();
    const gate = await gateFixture(fixture);
    expect(await liveDisclosureCurrent(kit.ctx, gate.input, gate.results)).toBe(true);
    expect(
      await liveDisclosureCurrent(kit.ctx, gate.input, {
        sourceResult: gate.results.recipientResult,
        recipientResult: gate.results.sourceResult,
      }),
    ).toBe(false);
    expect(
      await liveDisclosureCurrent(kit.ctx, gate.input, {
        sourceResult: undefined,
        recipientResult: gate.results.recipientResult,
      }),
    ).toBe(false);
    expect(
      await liveDisclosureCurrent(kit.ctx, gate.input, {
        sourceResult: gate.results.sourceResult,
        recipientResult: undefined,
      }),
    ).toBe(false);
    await setSetupWatchStmt(kit.env.DB, kit.org.id, fixture.monitor.id, {
      scannerIds: [],
      allOrg: false,
    }).run();
    expect(await liveDisclosureCurrent(kit.ctx, gate.input, gate.results)).toBe(false);
  });

  it.each(['source', 'recipient'] as const)(
    'rejects a %s CSRF rotation after the preflight batch',
    async (side) => {
      const fixture = await photoFixture();
      const gate = await gateFixture(fixture);
      expect(await liveDisclosureCurrent(kit.ctx, gate.input, gate.results)).toBe(true);
      const id = side === 'source' ? fixture.source.id : fixture.monitor.id;
      const next = `rotated-${kit.ctx.ids.token()}`;
      await expect(
        run(kit.env.DB, 'UPDATE scanners SET csrf_secret = ? WHERE id = ?', [next, id]),
      ).rejects.toThrow();
      await run(
        kit.env.DB,
        'UPDATE scanners SET csrf_secret = ?, updated_at = updated_at + 1 WHERE id = ?',
        [next, id],
      );
      expect(await liveDisclosureCurrent(kit.ctx, gate.input, gate.results)).toBe(false);
    },
  );

  it.each(['source', 'recipient'] as const)(
    'cancels an opened photo when the %s CSRF rotates',
    async (side) => {
      const fixture = await photoFixture();
      const stored = await memberPhoto(kit.env.DB, kit.org.id, fixture.pass.id);
      if (!stored) throw new Error('Missing photo object.');
      expect((await kit.get(fixture.monitor.headers, fixture.path)).status).toBe(200);
      const originalGet = kit.env.BUCKET.get.bind(kit.env.BUCKET);
      let opened = false;
      let cancelled = 0;
      const spy = vi.spyOn(kit.env.BUCKET, 'get').mockImplementation(async (objectKey, options) => {
        const object = await originalGet(objectKey, options);
        if (objectKey !== stored.r2_key || !object) return object;
        opened = true;
        await run(
          kit.env.DB,
          'UPDATE scanners SET csrf_secret = ?, updated_at = updated_at + 1 WHERE id = ?',
          [
            `rotated-${kit.ctx.ids.token()}`,
            side === 'source' ? fixture.source.id : fixture.monitor.id,
          ],
        );
        return observeCancellation(object, () => {
          cancelled++;
        });
      });
      let response: Response;
      try {
        response = await kit.get(fixture.monitor.headers, fixture.path);
      } finally {
        spy.mockRestore();
      }
      expect(opened).toBe(true);
      expect(cancelled).toBe(1);
      expect(response.status).toBe(404);
      expect(await response.json()).toMatchObject({ code: 'ASSET_NOT_FOUND' });
      expect((await kit.get(fixture.monitor.headers, fixture.path)).status).toBe(404);
    },
  );

  it('keeps the request KEK snapshot when the environment changes during the object read', async () => {
    const fixture = await photoFixture();
    const stored = await memberPhoto(kit.env.DB, kit.org.id, fixture.pass.id);
    if (!stored) throw new Error('Missing photo object.');
    const env = kit.env as typeof kit.env & Record<string, unknown>;
    const keys = Object.keys(env).filter((name) => /^KEK_V\d+$/.test(name));
    if (!keys.length) throw new Error('Missing request KEK.');
    const original = keys.map((name) => [name, env[name]] as const);
    const first = btoa(String.fromCharCode(...new Uint8Array(32).fill(72)));
    const replacement = original.every(([, value]) => value === first)
      ? btoa(String.fromCharCode(...new Uint8Array(32).fill(73)))
      : first;
    const originalGet = kit.env.BUCKET.get.bind(kit.env.BUCKET);
    let opened = false;
    const spy = vi.spyOn(kit.env.BUCKET, 'get').mockImplementation(async (objectKey, options) => {
      const object = await originalGet(objectKey, options);
      if (objectKey !== stored.r2_key || !object) return object;
      opened = true;
      for (const name of keys) env[name] = replacement;
      return object;
    });
    let response: Response;
    try {
      response = await kit.get(fixture.monitor.headers, fixture.path);
    } finally {
      spy.mockRestore();
      for (const [name, value] of original) env[name] = value;
    }
    expect(opened).toBe(true);
    expect(response.status).toBe(200);
    await response.body?.cancel();
  });

  it.each(['live', 'test'] as const)(
    'fences original %s-mode tombstones at the passless final gate',
    async (transferMode) => {
      const fixture = await photoFixture();
      const gate = await gateFixture(fixture);
      const testPass = await kit.scanPass(template, { memberName: 'Other Mode' }, { mode: 'test' });
      if (!testPass.scanCode) throw new Error('Missing test credential.');
      const release = await requireApprovedRelease(
        kit.ctx,
        template,
        kit.org.id,
        transferMode,
        'apple',
      );
      const other = await createPassRow(jobCtxOf(kit), {
        orgId: kit.org.id,
        templateId: template,
        templateVersion: release.version,
        releaseId: release.id,
        releaseGeneration: release.generation,
        input: { memberName: 'Transfer Member' },
        holderEmail: null,
        serial: testPass.scanCode,
        source: 'manual',
        mode: transferMode,
        actor: { type: 'system', id: null },
        execution: { kind: 'system' },
      });
      const evaluation = await resolveOutcome(kit.ctx, gate.proof.actor, {
        input: codeOf(testPass),
        clientTs: kit.clock.now(),
        idempotencyKey: key(),
      });
      expect(evaluation.outcome).toMatchObject({ kind: 'refused', reason: 'test_pass' });
      const context = evaluation.credentialContext;
      if (
        !context?.credentialTombstoneRefs.length ||
        !context.otherModeCredentialTombstoneRefs.length
      )
        throw new Error('Missing evaluated cross-mode credential context.');
      const input = {
        ...gate.input,
        candidate: null,
        credentialContext: context,
        requirePhoto: false,
      };
      expect(await liveDisclosureCurrent(kit.ctx, input, gate.results)).toBe(true);
      const finish = await beginCredentialTransfer(other.id);
      try {
        expect(await liveDisclosureCurrent(kit.ctx, input, gate.results)).toBe(false);
      } finally {
        await finish();
      }
      expect(await liveDisclosureCurrent(kit.ctx, input, gate.results)).toBe(false);
    },
  );
});
