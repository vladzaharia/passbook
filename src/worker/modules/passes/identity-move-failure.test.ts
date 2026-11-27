import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { fixtureIdentity } from '../../../../test/helpers/env.ts';
import {
  createFixtureIdentity,
  FIXTURE_IDENTITY,
} from '../../../passkit/testing/fixture-identity.ts';
import { run } from '../../platform/db.ts';
import type { LogData, Logger } from '../../platform/log.ts';
import type { BroadcastKit } from '../broadcasts/test-kit.ts';
import { jobCtxOf } from '../delivery/delivery-test-fixtures.ts';
import { handleOperationRun } from '../operations/jobs.ts';
import { SECOND_ID } from './identity-move-resolver-test-fixtures.ts';
import { previewIdentityMove } from './identity-move-start.ts';
import {
  count,
  DAY,
  moveKit,
  opRow,
  orgWithPasses,
  startMove,
} from './identity-move-test-fixtures.ts';

// The second identity's certificate comes from another CA than the Worker's intermediate while `state.broken` is
// set: the way a seed made with its own fixture generator fails when a replacement is signed.
const state = vi.hoisted(() => ({ broken: false }));
vi.mock('../identities/resolver.ts', async (importOriginal) => {
  const original = await importOriginal<typeof import('../identities/resolver.ts')>();
  const { createFixtureIdentity, FIXTURE_IDENTITY } = await import(
    '../../../passkit/testing/fixture-identity.ts'
  );
  const stranger = await createFixtureIdentity(FIXTURE_IDENTITY, {
    now: new Date('2026-01-01T00:00:00.000Z'),
    days: 3650,
    caDays: 3650,
  });
  const wrap = (base: ReturnType<typeof original.createIdentityResolver>) => {
    const second = async () => {
      const platform = await base.platform();
      return {
        ...platform,
        id: SECOND_ID,
        orgId: null,
        material: state.broken
          ? {
              certificate: stranger.certificate,
              privateKey: stranger.privateKey,
              intermediate: platform.material.intermediate,
            }
          : platform.material,
      };
    };
    return {
      ...base,
      forOrg: (orgId: string, id: string | null | undefined, now: number) =>
        id === SECOND_ID ? second() : base.forOrg(orgId, id, now),
      byId: (id: string) => (id === SECOND_ID ? second() : base.byId(id)),
    };
  };
  return {
    ...original,
    createIdentityResolver: (...a: Parameters<typeof original.createIdentityResolver>) =>
      wrap(original.createIdentityResolver(...a)),
  };
});

let kit: BroadcastKit;
beforeAll(async () => {
  kit = await moveKit();
});

afterEach(() => {
  state.broken = false;
});

const refused = (error: unknown) =>
  expect(error).toMatchObject({ code: 'IDENTITY_CHAIN_INVALID', status: 409 });

describe('a target identity that cannot sign', () => {
  it('is refused at start, before an operation or a row exists', async () => {
    const { org } = await orgWithPasses(kit, 1);
    state.broken = true;
    refused(await startMove(kit, org.id).catch((e: unknown) => e));
    expect(await count(kit, 'SELECT count(*) AS n FROM pass_moves WHERE org_id = ?', org.id)).toBe(
      0,
    );
    expect(
      await count(
        kit,
        'SELECT count(*) AS n FROM operations WHERE kind = ? AND target_id = ?',
        'identity.move',
        org.id,
      ),
    ).toBe(0);
  });

  it('is reported by the preview from its certificate alone', async () => {
    const { org } = await orgWithPasses(kit, 1);
    const stranger = await createFixtureIdentity(
      { ...FIXTURE_IDENTITY, passTypeIdentifier: 'pass.test.stranger' },
      { now: new Date('2026-01-01T00:00:00.000Z'), days: 3650, caDays: 3650 },
    );
    await run(
      kit.env.DB,
      "INSERT INTO credentials (id, kind, kek_version, iv, wrapped_dek, ciphertext, created_at) VALUES ('cred-stranger', 'pass_signer', 1, x'00', x'00', x'00', 1)",
    );
    await run(
      kit.env.DB,
      `INSERT INTO signing_identities
         (id, org_id, label, pass_type_identifier, team_identifier, source, credential_id, cert_pem, not_after,
          provenance, purpose, is_default, issuing, created_at)
       VALUES ('identity-stranger', NULL, 'Stranger', 'pass.test.stranger', ?, 'db', 'cred-stranger', ?, ?, 'platform', 'passes', 0, 1, 1)`,
      [FIXTURE_IDENTITY.teamIdentifier, stranger.certificate, kit.clock.now() + 365 * DAY],
    );
    refused(
      await previewIdentityMove(jobCtxOf(kit), {
        orgId: org.id,
        fromIdentityId: 'platform',
        toIdentityId: 'identity-stranger',
      }).catch((e: unknown) => e),
    );
  });

  it('is refused when its certificate is for another pass type or team', async () => {
    const { org } = await orgWithPasses(kit, 1);
    await run(
      kit.env.DB,
      "INSERT OR IGNORE INTO credentials (id, kind, kek_version, iv, wrapped_dek, ciphertext, created_at) VALUES ('cred-other', 'pass_signer', 1, x'00', x'00', x'00', 1)",
    );
    await run(
      kit.env.DB,
      `INSERT INTO signing_identities
         (id, org_id, label, pass_type_identifier, team_identifier, source, credential_id, cert_pem, not_after,
          provenance, purpose, is_default, issuing, created_at)
       VALUES ('identity-other', NULL, 'Other', 'pass.test.other', ?, 'db', 'cred-other', ?, ?, 'platform', 'passes', 0, 1, 1)`,
      [
        FIXTURE_IDENTITY.teamIdentifier,
        (await fixtureIdentity()).certificate,
        kit.clock.now() + 365 * DAY,
      ],
    );
    const error = await previewIdentityMove(jobCtxOf(kit), {
      orgId: org.id,
      fromIdentityId: 'platform',
      toIdentityId: 'identity-other',
    }).catch((e: unknown) => e);
    expect(error).toMatchObject({ code: 'IDENTITY_CERT_MISMATCH', status: 409 });
  });

  it('is refused when there is no certificate to check', async () => {
    const { org } = await orgWithPasses(kit, 1);
    const error = await previewIdentityMove(jobCtxOf(kit), {
      orgId: org.id,
      fromIdentityId: 'platform',
      toIdentityId: SECOND_ID,
    }).catch((e: unknown) => e);
    expect(error).toMatchObject({ code: 'IDENTITY_NOT_CONFIGURED' });
  });

  it("is not reported for the Worker's own certificate", async () => {
    const { org } = await orgWithPasses(kit, 1);
    await expect(
      previewIdentityMove(jobCtxOf(kit), {
        orgId: org.id,
        fromIdentityId: SECOND_ID,
        toIdentityId: 'platform',
      }),
    ).resolves.toMatchObject({ toIdentityId: 'platform' });
  });
});

describe('a move whose identity stops signing after it started', () => {
  it('fails, and the log names the step and the signing check, not only OPERATION_FAILED', async () => {
    const { org } = await orgWithPasses(kit, 1);
    const op = await startMove(kit, org.id);
    state.broken = true;
    const lines: { level: string; event: string; data: LogData }[] = [];
    const log: Logger = {
      debug: () => {},
      info: () => {},
      warn: (event, data = {}) => void lines.push({ level: 'warn', event, data }),
      error: (event, data = {}) => void lines.push({ level: 'error', event, data }),
      child: () => log,
    };
    await handleOperationRun(
      { kind: 'operation.run', operationId: op.id, attempt: op.attempt },
      { ...jobCtxOf(kit), log },
    );

    const row = await opRow(kit, op.id);
    expect(row.status).toBe('failed');
    expect(row.error_code).toBe('OPERATION_FAILED');
    const failed = lines.filter((l) => l.event === 'operation.failed');
    expect(failed).toHaveLength(1);
    expect(failed[0]).toMatchObject({
      level: 'error',
      data: {
        code: 'OPERATION_FAILED',
        operationId: op.id,
        step: 'issue',
        cause: 'SigningError',
        causeCode: 'SIGN_CHAIN_INVALID',
      },
    });
    expect(String(failed[0]?.data.site)).toContain('sign/index.ts');
    expect(JSON.stringify(lines)).not.toMatch(/@example\.com/);
  });
});

describe('a Worker whose Apple intermediate has expired', () => {
  it('reports it as expired, not as a broken chain', async () => {
    const { org } = await orgWithPasses(kit, 1);
    const short = await createFixtureIdentity(
      { ...FIXTURE_IDENTITY, passTypeIdentifier: 'pass.test.short' },
      { now: new Date('2026-01-01T00:00:00.000Z'), days: 3650, caDays: 1 },
    );
    await run(
      kit.env.DB,
      "INSERT OR IGNORE INTO credentials (id, kind, kek_version, iv, wrapped_dek, ciphertext, created_at) VALUES ('cred-short', 'pass_signer', 1, x'00', x'00', x'00', 1)",
    );
    await run(
      kit.env.DB,
      `INSERT INTO signing_identities
         (id, org_id, label, pass_type_identifier, team_identifier, source, credential_id, cert_pem, not_after,
          provenance, purpose, is_default, issuing, created_at)
       VALUES ('identity-short', NULL, 'Short', 'pass.test.short', ?, 'db', 'cred-short', ?, ?, 'platform', 'passes', 0, 1, 1)`,
      [FIXTURE_IDENTITY.teamIdentifier, short.certificate, kit.clock.now() + 3000 * DAY],
    );
    kit.clock.advance(3 * DAY);
    const ctx = jobCtxOf(kit);
    const error = await previewIdentityMove(
      { ...ctx, env: { ...ctx.env, SIGNER_PLATFORM_INTERMEDIATE: short.intermediate } },
      { orgId: org.id, fromIdentityId: 'platform', toIdentityId: 'identity-short' },
    ).catch((e: unknown) => e);
    expect(error).toMatchObject({ code: 'IDENTITY_INTERMEDIATE_EXPIRED', status: 409 });
  });
});
