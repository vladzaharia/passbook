// Differential: the rest of the scan readers on the join-once predicate return exactly the rows of their
// scalar-form originals (repo-read-once-legacy-more.ts), for member, scanner (good and bad epoch), key and
// platform actors, over the seeds of scan-read-once.test.ts plus pass notes.
import { describe, expect, it } from 'vitest';
import { passRow } from '../../platform/authority-checks.ts';
import { db } from '../../platform/authority-ext-fixtures.ts';
import { actors, seed } from '../../platform/authority-read-join-fixtures.ts';
import { all, run } from '../../platform/db.ts';
import type { ScanActor } from './actor.ts';
import { collidingClaimStmt } from './repo-act-claim-current.ts';
import { ownedReceiptStmt, projectionStmt } from './repo-act-replay-current.ts';
import { assetReadCurrent } from './repo-asset-read.ts';
import { countScanRows, type ScanLogFilter } from './repo-feed.ts';
import { readNotes } from './repo-notes.ts';
import { scanAuthorizedStmt } from './repo-read-authority.ts';
import { legacyOf } from './repo-read-once-legacy-auth.ts';
import {
  legacyActorFenceStmt,
  legacyAssetStmt,
  legacyAuthorizedStmt,
  legacyBrandingStmt,
  legacyClaimStmt,
  legacyExtrasStmts,
  legacyFeedCountStmt,
  legacyNotesStmt,
  legacyOwnedReceiptStmt,
  legacyPreviewActorStmt,
  legacyPreviewStmt,
  legacySummaryTotalsStmt,
} from './repo-read-once-legacy-more.ts';
import { actorPassScopeSql } from './repo-recipient-scope.ts';
import { passlessStmt } from './repo-resolve-passless-read.ts';
import { previewActorStmt, previewCurrentStmt } from './repo-routes-display.ts';
import { ownScansWhere, readSummary } from './repo-scan-history.ts';
import type { ScanRow } from './repo-scans.ts';
import { orgBrandingForActorStmt } from './repo-session.ts';
import { readSummaryExtras } from './repo-summary-extras.ts';
import { fence, scanner, seedScanRows } from './scan-read-once-test-fixtures.ts';

const ownActor = {
  ...scanner,
  actorKey: 'k0',
  actor: { type: 'scanner', id: 'x' },
} as unknown as ScanActor;
const own = ownScansWhere(ownActor);

describe('the remaining scan readers on the join-once predicate equal their scalar originals', () => {
  it('returns the same rows for every actor kind', async () => {
    const s = await seed();
    await seedScanRows(s);
    const now = s.f.clock.now();
    const passes = await all<{
      id: string;
      org_id: string;
      mode: string;
      template_id: string;
      c: number;
      l: number;
      i: number;
    }>(
      db,
      `SELECT id, org_id, mode, template_id, credential_generation AS c, lifecycle_generation AS l,
         image_generation AS i FROM passes WHERE org_id IN (?, ?) ORDER BY id`,
      [s.a.id, s.b.id],
    );
    for (const [n, p] of passes.entries())
      await run(
        db,
        `INSERT INTO pass_notes (id, org_id, mode, pass_id, credential_generation, body, author_name, idempotency_key, created_at)
         VALUES (?, ?, ?, ?, ?, 'hi', 'Ann', ?, ?)`,
        [s.ident(`note-${n}`), p.org_id, p.mode, p.id, p.c, `nk${n}`, 10 + n],
      );
    const scans = await all<{ id: string; at: number }>(
      db,
      "SELECT id, at FROM scans WHERE org_id = ? AND mode = 'live' ORDER BY id",
      [s.a.id],
    );
    const scanRow = (id: string, at: number) =>
      ({ id, at, state: 'done', reason: null, requestHash: 'r' }) as unknown as ScanRow;
    let nonEmpty = 0;
    const same = (name: string, was: unknown, is: unknown, count = true) => {
      expect(is, name).toEqual(was);
      if (count && JSON.stringify(was).length > 6) nonEmpty++;
    };
    const rowsOf = async (stmt: D1PreparedStatement) => (await stmt.all()).results;
    const inner = {
      sql: 'EXISTS (SELECT 1 FROM passes p WHERE p.org_id = ao.org_id AND p.mode = ao.mode)',
      params: [],
    };
    const window = { from: 0, to: 10_000 };
    const filters: ScanLogFilter[] = [
      { mode: 'live', limit: 5, orgId: s.a.id },
      { mode: 'live', limit: 5, orgId: s.a.id, scannerId: s.ident('sc-a-live') },
      { mode: 'live', limit: 5, scannerId: s.ident('sc-a-live') },
      { mode: 'test', limit: 5 },
    ];
    for (const actor of await actors(s)) {
      if (actor.scope === 'platform' && !actor.platform) continue;
      const checks = actor.check
        ? passRow(actor.check === 'own' ? s.w.a.pass : (s.tb.passes.live ?? ''))
        : undefined;
      const auth = fence(actor, now, checks);
      const old = legacyOf(auth);
      const at = (what: string) => `${actor.name}: ${what}`;
      same(
        at('authorized'),
        await rowsOf(legacyAuthorizedStmt(db, old)),
        await rowsOf(scanAuthorizedStmt(db, auth)),
        false,
      );
      same(
        at('branding'),
        await rowsOf(legacyBrandingStmt(db, old)),
        await rowsOf(orgBrandingForActorStmt(db, auth)),
      );
      same(
        at('preview actor'),
        await rowsOf(legacyPreviewActorStmt(db, old)),
        await rowsOf(previewActorStmt(db, auth)),
        false,
      );
      same(
        at('passless'),
        await rowsOf(legacyActorFenceStmt(db, old, inner)),
        await rowsOf(passlessStmt(db, auth, [inner])),
      );
      same(
        at('projection'),
        await rowsOf(legacyActorFenceStmt(db, old, inner, '1 AS authorized')),
        await rowsOf(projectionStmt(db, auth, inner)),
      );
      for (const sc of scans.slice(0, 3)) {
        for (const key of ['i0', 'other'])
          same(
            at('claim'),
            await rowsOf(legacyClaimStmt(db, old, 'k0', scanRow(sc.id, sc.at), key)),
            await rowsOf(collidingClaimStmt(db, auth, 'k0', scanRow(sc.id, sc.at), key)),
            false,
          );
        same(
          at('receipt'),
          await rowsOf(legacyOwnedReceiptStmt(db, old, own, sc.id)),
          await rowsOf(ownedReceiptStmt(db, auth, own, sc.id)),
          false,
        );
      }
      for (const p of passes) {
        const pass = {
          id: p.id,
          templateId: p.template_id,
          credentialGeneration: p.c,
          lifecycleGeneration: p.l,
          imageGeneration: p.i,
        };
        const candidate = { pass, templateSnapshot: { raw: '{"release":null}' } };
        const preview = previewCurrentStmt(db, auth, candidate as never);
        same(
          at('preview'),
          await rowsOf(legacyPreviewStmt(db, old, pass, null)),
          await rowsOf(preview as D1PreparedStatement),
        );
        const q = { passId: p.id, templateId: p.template_id, generation: p.c, limit: 10 };
        const authorized = (await rowsOf(legacyAuthorizedStmt(db, old))).length > 0;
        const notes = await readNotes(db, auth, q);
        same(at('notes'), authorized ? await rowsOf(legacyNotesStmt(db, old, q)) : [], notes.rows);
        const scope = actorPassScopeSql(scanner, 'p');
        if (!scope) throw new Error('scope');
        for (const photo of [false, true]) {
          const was = await rowsOf(legacyAssetStmt(db, old, pass, scope, null));
          const is = await assetReadCurrent(db, auth, scanner, candidate as never, photo);
          if (!photo) expect(is, at('asset')).toBe(was.length > 0);
        }
      }
      for (const f of filters) {
        const was = (await rowsOf(legacyFeedCountStmt(db, old, f, 100))) as { n: number }[];
        const authorized = (await rowsOf(legacyAuthorizedStmt(db, old))).length > 0;
        const is = await countScanRows(db, auth, f, 100);
        same(at('count'), authorized ? (was[0]?.n ?? 0) : 0, is.n);
      }
      const totals = await legacySummaryTotalsStmt(db, old, own, window).first();
      const summary = await readSummary(db, auth, ownActor, window, now);
      same(at('summary'), summary.authorized ? totals : null, summary.totals);
      const scope = { where: own.sql, params: own.params };
      const [t, q, v, r, ty, st, c, ov] = await Promise.all(
        legacyExtrasStmts(db, old, scope, window).map(rowsOf),
      );
      const extras = await readSummaryExtras(db, auth, scope, window);
      if (extras.authorized) {
        same(at('extras totals'), t?.[0], extras.totals);
        same(at('extras quarters'), q, extras.quarters);
        same(at('extras value'), v, extras.value);
        same(at('extras reasons'), r, extras.reasons);
        same(at('extras types'), ty, extras.types);
        same(at('extras staff'), st, extras.staff);
        same(at('extras count'), (c?.[0] as { n: number })?.n, extras.overrideCount);
        same(at('extras overrides'), ov, extras.overrides);
      } else same(at('extras empty'), [], [...extras.quarters, ...extras.value, ...extras.staff]);
    }
    expect(nonEmpty).toBeGreaterThan(40);
  });
});
