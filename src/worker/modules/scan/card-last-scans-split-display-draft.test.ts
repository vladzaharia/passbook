import { beforeAll, describe, expect, it } from 'vitest';
import type { ScanOutcome } from '../../../shared/contracts/scan.ts';
import { first } from '../../platform/db.ts';
import { putPassCheckIn } from '../passes/check-in.ts';
import { putMemberPhoto } from '../passes/member-photo.ts';
import { makePng } from '../templates/package/fixtures.ts';
import { scannerActor, withRole } from './actor.ts';
import { historyPlan, readCard, renderCardDisplay } from './card.ts';
import { cardLastScansSplitFixture } from './card-last-scans-split-fixture.ts';
import { planCounts } from './counts.ts';
import { planDisplayHistoryRead, rebindDisplayHistoryRead } from './history-proof-plan.ts';
import { knownPhotoUrl } from './member-photo.ts';
import { getScanner } from './repo-device.ts';
import { candidateById } from './repo-lookup.ts';
import { outputAuthorityPredicate } from './repo-output-authority.ts';
import { readScannerScope } from './repo-scope.ts';
import { foundOf } from './resolve.ts';
import { displayNeedsFor } from './scan-display-history.ts';
import { proofedScanActor, type ScanKit, setupScanKit } from './test-kit.ts';

let kit: ScanKit;

beforeAll(async () => {
  kit = await setupScanKit();
});

const { act, body, simple } = cardLastScansSplitFixture(() => kit);

describe('card last-scan privacy', () => {
  it('does not use a cached private title when the card display renderer fails', async () => {
    const { pass, scanner } = await simple();
    const scannerRow = await getScanner(kit.env.DB, scanner.id);
    const candidate = await candidateById(kit.env.DB, kit.org.id, pass.id);
    if (!scannerRow || !candidate) throw new Error('Missing real card fixture');
    const scope = await readScannerScope(kit.env.DB, scannerRow, null);
    const actor = withRole(
      await proofedScanActor(kit.ctx, scannerActor(kit.ctx, scannerRow, 'live', 'cookie', scope)),
      null,
    );
    const found = await foundOf(kit.ctx, candidate, actor);
    if (!found) throw new Error('Missing evaluated card fixture');
    let reads = 0;
    let failed = false;
    const ctx = {
      ...kit.ctx,
      log: {
        ...kit.ctx.log,
        error: () => {
          failed = true;
        },
      },
    };
    const result = await readCard(ctx, actor, found, planCounts(ctx, actor), 'read');
    if (!result) throw new Error('Expected a card draft');
    const now = ctx.clock.now();
    const bound = result.displayHistory.bind(
      now,
      outputAuthorityPredicate({
        actor,
        event: found.admission?.event ?? actor.event,
        now,
        credentialTombstoneRefs: found.credentialTombstoneRefs,
        credentialKeysetCommitment: found.credentialKeysetCommitment,
        templateId: found.pass.templateId,
        pass: found.liveCandidate?.pass ?? found.pass,
        connectionGeneration: found.connectionGeneration,
        activeTemplateVersion: found.activeVersion,
        orgRevision: found.orgRevision,
        templateRevision: found.templateRevision,
        release: found,
        displayTemplateVersion: found.displayTemplateVersion,
        checkInRules: found.checkInRules,
        lookupHash: found.liveCandidate?.lookupHash,
        requireActive: true,
      }),
    );
    const history = bound.finalize(await ctx.env.DB.batch(bound.stmts));
    expect(history).not.toBeNull();
    if (!history) throw new Error('Expected authorized display history');
    const broken = {
      ...found,
      pass: {
        ...found.pass,
        get displayTitle(): string {
          if (++reads === 1) throw new Error('display renderer failed');
          return 'PRIVATE CACHED HOLDER';
        },
      },
    };
    renderCardDisplay(ctx, actor, broken, result.card, history);
    expect(failed).toBe(true);
    expect(result.card.display.identity.holder).toBe('');
    expect(JSON.stringify(result.card.display)).not.toContain('PRIVATE CACHED HOLDER');
  });

  it('keeps photo and pass-view capabilities out of a card draft until their grants commit', async () => {
    const { templateId, pass, scanner } = await simple();
    const png = btoa(String.fromCharCode(...makePng(270, 270)));
    await putMemberPhoto(
      kit.ctx,
      { type: 'system', id: null },
      pass.id,
      {
        png,
        includeInPass: true,
      },
      null,
    );
    const scannerRow = await getScanner(kit.env.DB, scanner.id);
    const candidate = await candidateById(kit.env.DB, kit.org.id, pass.id);
    if (!scannerRow || !candidate) throw new Error('Missing real card fixture');
    const scope = await readScannerScope(kit.env.DB, scannerRow, null);
    const actor = withRole(
      await proofedScanActor(kit.ctx, scannerActor(kit.ctx, scannerRow, 'live', 'cookie', scope)),
      null,
    );
    const found = await foundOf(kit.ctx, candidate, actor);
    if (!found) throw new Error('Missing evaluated card fixture');
    expect(found).not.toHaveProperty('photoGrant');
    expect(found).not.toHaveProperty('photoUrl');
    expect(candidate).not.toHaveProperty('photoGrant');
    expect(candidate).not.toHaveProperty('photoUrl');
    const photo = await knownPhotoUrl(
      kit.ctx,
      actor,
      candidate,
      found.template,
      found.activePolicy,
    );
    if (!photo) throw new Error('Missing authorized photo plan');
    expect(photo).not.toHaveProperty('url');
    expect(photo.grant).not.toHaveProperty('token');
    expect(
      await first(
        kit.env.DB,
        'SELECT token_hash FROM scan_asset_grant_provenance WHERE token_hash=?',
        [photo.grant.tokenHash],
      ),
    ).toBeNull();

    const preview = await readCard(kit.ctx, actor, found, planCounts(kit.ctx, actor), 'read', 10);
    const committing = await readCard(
      kit.ctx,
      actor,
      found,
      planCounts(kit.ctx, actor),
      'commit',
      10,
    );
    if (!preview || !committing) throw new Error('Missing card draft');
    expect(preview.passViewGrant.guard.purpose).toBe('read');
    expect(committing.passViewGrant.guard.purpose).toBe('commit');
    for (const draft of [preview, committing]) {
      expect(draft.card.passView.assetNames).not.toContain('thumbnail@3x.png');
      expect(draft.card.passView).not.toHaveProperty('assetGrant');
      expect(draft.passViewGrant).not.toHaveProperty('token');
      expect(draft.card.display.identity.photo).toBeNull();
      expect(
        await first(
          kit.env.DB,
          'SELECT token_hash FROM scan_asset_grant_provenance WHERE token_hash=?',
          [draft.passViewGrant.tokenHash],
        ),
      ).toBeNull();
    }

    const response = await kit.post(scanner.headers, '/resolve', body(pass.id));
    expect(response.status).toBe(200);
    const outcome = (await response.json()) as ScanOutcome;
    expect(outcome.kind).toBe('ready');
    expect(outcome.card?.template.id).toBe(templateId);
    expect(outcome.card?.passView.assetNames).not.toContain('thumbnail@3x.png');
    expect(outcome.card?.display.identity.photo?.url).toContain(
      `/passes/${pass.id}/assets/member.png?g=`,
    );
  });

  it('binds a choose-card grant to the authenticated scanner when admission derives an event', async () => {
    const templateId = await kit.scanTemplate('Event-scoped choose card', {
      actions: [{ id: 'enter', label: 'Admit member', kind: 'check_in' }],
    });
    const event = await kit.event({ templateIds: [templateId] });
    const pass = await kit.scanPass(templateId);
    await putPassCheckIn(
      kit.ctx,
      { type: 'system', id: null },
      pass.id,
      { mode: 'in_out', eventId: event.id },
      null,
    );
    const scanner = await kit.scanner({ templateIds: [templateId], settings: { flow: 'choose' } });
    expect((await getScanner(kit.env.DB, scanner.id))?.eventId).toBeNull();
    const response = await kit.post(scanner.headers, '/actions', {
      ...body(pass.id),
      actionId: 'auto',
    });
    expect(response.status).toBe(200);
    const outcome = (await response.json()) as ScanOutcome;
    expect(outcome).toMatchObject({
      kind: 'ready',
      card: { passId: pass.id, checkIn: { mode: 'in_out' } },
    });
    if (!outcome.card) throw new Error('Expected an authorized choose card');
    const path =
      `${outcome.card.passView.assetBaseUrl}icon.png?g=${outcome.card.passView.assetGrant}`.replace(
        '/api/v1/scan',
        '',
      );
    expect((await kit.get(scanner.headers, path)).status).toBe(200);
  });

  it('batches display-history discovery with the original card reads', async () => {
    const templateId = await kit.scanTemplate('Card display history batch', {
      actions: [{ id: 'enter', label: 'Admit member', kind: 'check_in' }],
      display: {
        v: 1,
        holder: '{{inputs.memberName}}',
        header: { subtitle: '{{history.lastScan.action}}' },
        panels: [],
      },
    });
    const pass = await kit.scanPass(templateId);
    const scanner = await kit.scanner({ templateIds: [templateId] });
    await act(scanner.headers, pass.id);
    const scannerRow = await getScanner(kit.env.DB, scanner.id);
    const candidate = await candidateById(kit.env.DB, kit.org.id, pass.id);
    if (!scannerRow || !candidate) throw new Error('Missing real card fixture');
    const scope = await readScannerScope(kit.env.DB, scannerRow, null);
    const actor = withRole(
      await proofedScanActor(kit.ctx, scannerActor(kit.ctx, scannerRow, 'live', 'cookie', scope)),
      null,
    );
    const found = await foundOf(kit.ctx, candidate, actor);
    if (!found) throw new Error('Missing evaluated card fixture');
    const sqlOf = new WeakMap<D1PreparedStatement, string>();
    const batches: string[][] = [];
    const db = new Proxy(kit.env.DB, {
      get(target, prop) {
        if (prop === 'prepare')
          return (sql: string) =>
            new Proxy(target.prepare(sql), {
              get(prepared, member) {
                if (member === 'bind')
                  return (...values: unknown[]) => {
                    const bound = prepared.bind(...values);
                    sqlOf.set(bound, sql);
                    return bound;
                  };
                const value = Reflect.get(prepared, member, prepared);
                return typeof value === 'function' ? value.bind(prepared) : value;
              },
            });
        if (prop === 'batch')
          return async (statements: D1PreparedStatement[]) => {
            batches.push(statements.map((statement) => sqlOf.get(statement) ?? ''));
            return target.batch(statements);
          };
        const value = Reflect.get(target, prop, target);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    const ctx = { ...kit.ctx, env: { ...kit.ctx.env, DB: db } };
    const plan = planDisplayHistoryRead(ctx, actor, found, displayNeedsFor(found));
    const expected = plan.stmts.map((statement) => sqlOf.get(statement));
    expect(expected.length).toBeGreaterThan(0);
    expect(expected.every((sql) => typeof sql === 'string')).toBe(true);
    expect(await readCard(ctx, actor, found, planCounts(ctx, actor), 'read', 10)).not.toBeNull();
    const cardBatch = batches.find((batch) =>
      batch.some((sql) => sql.includes('WITH selected_scans AS MATERIALIZED')),
    );
    if (!cardBatch) throw new Error('Missing original card batch');
    for (const sql of expected) expect(cardBatch).toContain(sql);

    const preloaded = await plan.finish(await db.batch(plan.stmts));
    if (!preloaded) throw new Error('Expected a valid history preload');
    const reboundActor = { ...actor };
    expect(rebindDisplayHistoryRead(preloaded, reboundActor, found)).toBe(true);
    batches.length = 0;
    expect(
      await readCard(
        ctx,
        reboundActor,
        found,
        planCounts(ctx, reboundActor),
        'read',
        10,
        preloaded,
      ),
    ).not.toBeNull();
    expect(batches.flat().some((sql) => sql.includes('scan-history-proof-page'))).toBe(false);
    expect(await readCard(ctx, actor, found, planCounts(ctx, actor), 'read', 10, null)).toBeNull();

    const nextPlan = planDisplayHistoryRead(ctx, actor, found, displayNeedsFor(found));
    const nextPreload = await nextPlan.finish(await db.batch(nextPlan.stmts));
    if (!nextPreload) throw new Error('Expected another valid history preload');
    batches.length = 0;
    const history = await historyPlan(ctx, actor, found, nextPreload);
    expect(history.requiresHistory).toBe(true);
    expect(batches.flat().some((sql) => sql.includes('scan-history-proof-page'))).toBe(false);
  });
});
