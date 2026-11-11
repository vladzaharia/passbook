import { expect, it } from 'vitest';
import { all, first, run } from '../../platform/db.ts';
import { approveAppleRelease } from '../passes/apple-release-test-fixtures.ts';
import { rollbackRelease } from '../templates/releases.ts';
import { candidateById } from './repo-lookup.ts';
import { CHECK_IN, kit, stageVersion } from './repo-lookup-release-test-fixtures.ts';
import { key } from './test-kit.ts';

export function registerLookupReleasePrivacyCases() {
  it.each([
    { state: 'active', route: 'resolve', rollback: false },
    { state: 'active', route: 'resolve', rollback: true },
    { state: 'active', route: 'actions', rollback: true },
    { state: 'inactive', route: 'resolve', rollback: true },
    { state: 'inactive', route: 'actions', rollback: true },
    { state: 'mode mismatch', route: 'resolve', rollback: true },
    { state: 'mode mismatch', route: 'actions', rollback: true },
  ] as const)(
    'keeps a $state $route private after release supersession/rollback',
    async ({ state, route, rollback }) => {
      const templateId = await kit.scanTemplate('Release race', { actions: [CHECK_IN] });
      const mode = state === 'mode mismatch' ? 'test' : 'live';
      const original = await approveAppleRelease(kit, { templateId, version: 'v1', mode });
      const pass = await kit.scanPass(
        templateId,
        { memberName: 'Release Race Private Person' },
        { mode },
      );
      if (state === 'inactive')
        await run(kit.env.DB, "UPDATE passes SET status='voided' WHERE id=?", [pass.id]);
      const scanner = await kit.scanner({ templateIds: [templateId], mode: 'live' });
      await stageVersion(templateId, 'v2');
      const request = {
        idempotencyKey: key(),
        input: { passId: pass.id, method: 'manual' },
        clientTs: kit.clock.now(),
        ...(route === 'actions' ? { actionId: 'auto' } : {}),
      };

      const real = kit.env.DB;
      let raced = false;
      const candidates = new WeakSet<D1PreparedStatement>();
      const db = new Proxy(real, {
        get(target, prop) {
          if (prop === 'prepare')
            return (sql: string) => {
              const statement = target.prepare(sql);
              if (!sql.includes('credential_keyset.commitment AS credential_keyset_commitment'))
                return statement;
              return new Proxy(statement, {
                get(inner, member) {
                  if (member === 'bind')
                    return (...values: unknown[]) => {
                      const bound = inner.bind(...values);
                      candidates.add(bound);
                      return bound;
                    };
                  const value = Reflect.get(inner, member, inner);
                  return typeof value === 'function' ? value.bind(inner) : value;
                },
              });
            };
          if (prop === 'batch')
            return async (statements: D1PreparedStatement[]) => {
              const results = await target.batch(statements);
              const index = statements.findIndex((statement) => candidates.has(statement));
              const row = index < 0 ? undefined : results[index]?.results?.[0];
              if (
                !raced &&
                row !== null &&
                typeof row === 'object' &&
                'id' in row &&
                row.id === pass.id
              ) {
                raced = true;
                const next = await approveAppleRelease(kit, { templateId, version: 'v2', mode });
                if (rollback) {
                  await rollbackRelease(kit.ctx, next.publisherAuth, templateId, {
                    orgId: kit.org.id,
                    mode,
                    provider: 'apple',
                    releaseId: original.id,
                    candidateHash: original.candidateHash,
                    expectedGeneration: next.generation,
                    reason: 'Restore the earlier scanner release.',
                  });
                }
              }
              return results;
            };
          const value = Reflect.get(target, prop, target);
          return typeof value === 'function' ? value.bind(target) : value;
        },
      });
      Object.assign(kit.env, { DB: db });
      let response: Response;
      try {
        response = await kit.post(scanner.headers, `/${route}`, request);
      } finally {
        Object.assign(kit.env, { DB: real });
      }
      expect(raced).toBe(true);
      const fresh = await candidateById(real, kit.org.id, pass.id);
      expect(fresh?.activeReleaseId).not.toBe(original.id);
      expect(fresh?.activeReleaseGeneration).toBeGreaterThan(original.generation);
      expect(fresh?.activeReleaseVersion).toBe(rollback ? 'v1' : 'v2');
      if (rollback) expect(fresh?.activeReleaseCandidateHash).toBe(original.candidateHash);
      expect(response.status).toBe(200);
      const text = await response.text();
      expect(JSON.parse(text)).toMatchObject({
        kind: 'refused',
        reason: state === 'mode mismatch' ? 'test_pass' : 'not_found',
        action: null,
        template: null,
        card: null,
        display: null,
      });
      const identity = await first<{ pass_type_identifier: string; team_identifier: string }>(
        real,
        'SELECT pass_type_identifier, team_identifier FROM signing_identities WHERE id=?',
        [pass.identityId],
      );
      if (!identity) throw new Error('Missing release race signing identity');
      const secrets = [
        pass.id,
        pass.serial,
        pass.scanCode,
        pass.identityId,
        pass.releaseId,
        pass.authToken,
        pass.downloadToken,
        original.id,
        original.candidateHash,
        fresh?.activeReleaseId,
        fresh?.activeReleaseCandidateHash,
        identity.pass_type_identifier,
        identity.team_identifier,
        templateId,
        'Release race',
        'Release Race Private Person',
      ].filter((value): value is string => typeof value === 'string' && value.length > 0);
      for (const secret of secrets) expect(text).not.toContain(secret);
      if (state === 'mode mismatch') {
        expect(JSON.parse(text)).toMatchObject({ scanId: null, at: null, replay: false });
        if (route === 'actions') {
          const scan = await first(real, 'SELECT * FROM scans WHERE idempotency_key=?', [
            request.idempotencyKey,
          ]);
          expect(scan).toMatchObject({
            mode: 'live',
            state: 'done',
            outcome: 'refused',
            reason: 'not_found',
            pass_id: null,
            template_id: null,
            pass_version: null,
            action_id: null,
            action_kind: null,
          });
          for (const secret of secrets) expect(JSON.stringify(scan)).not.toContain(secret);
          const replay = await kit.post(scanner.headers, '/actions', request);
          expect(replay.status).toBe(200);
          const replayText = await replay.text();
          expect(JSON.parse(replayText)).toMatchObject({
            kind: 'refused',
            reason: 'not_found',
            scanId: null,
            replay: false,
            action: null,
            template: null,
            card: null,
            display: null,
          });
          for (const secret of secrets) expect(replayText).not.toContain(secret);
          expect(
            await first(real, 'SELECT * FROM scans WHERE idempotency_key=?', [
              request.idempotencyKey,
            ]),
          ).toEqual(scan);
        }
      }
      expect(
        await all(real, 'SELECT pass_id FROM scan_gates WHERE pass_id=?', [pass.id]),
      ).toHaveLength(0);
      expect(
        await all(real, "SELECT id FROM pass_events WHERE pass_id=? AND kind LIKE 'scan.%'", [
          pass.id,
        ]),
      ).toHaveLength(0);
    },
  );
}
