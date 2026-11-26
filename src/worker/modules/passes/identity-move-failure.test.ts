import { beforeAll, describe, expect, it, vi } from 'vitest';
import type { LogData, Logger } from '../../platform/log.ts';
import type { BroadcastKit } from '../broadcasts/test-kit.ts';
import { jobCtxOf } from '../delivery/delivery-test-fixtures.ts';
import { handleOperationRun } from '../operations/jobs.ts';
import { SECOND_ID } from './identity-move-resolver-test-fixtures.ts';
import { moveKit, opRow, orgWithPasses, startMove } from './identity-move-test-fixtures.ts';

// The second identity's certificate comes from another CA than the Worker's intermediate: the way a seed made
// with its own fixture generator fails when the first replacement is signed.
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
        material: {
          certificate: stranger.certificate,
          privateKey: stranger.privateKey,
          intermediate: platform.material.intermediate,
        },
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

describe('a move that cannot sign its replacements', () => {
  it('fails, and the log names the step and the signing check, not only OPERATION_FAILED', async () => {
    const { org } = await orgWithPasses(kit, 1);
    const op = await startMove(kit, org.id);
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
