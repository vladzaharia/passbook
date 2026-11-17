import { beforeAll, describe, expect, it } from 'vitest';
import { grant } from '../../platform/authority.ts';
import type { ScanActor } from './guard.ts';
import { grantMiss } from './misses.ts';
import { finalizeScan } from './scan-write-statements.ts';
import { type ScanKit, setupScanKit } from './test-kit.ts';

let kit: ScanKit;
beforeAll(async () => {
  kit = await setupScanKit();
});

const actor = (orgId: string) =>
  ({
    orgId,
    mode: 'live',
    actorKey: 's:scanner',
    actor: { type: 'scanner', id: 'scanner' },
    scanner: { id: 'scanner' },
  }) as unknown as ScanActor;

function stopGrant() {
  const g = grant(kit.ctx, {
    purpose: 'org_mode.scan.stop',
    principal: { kind: 'scanner', scannerId: 'scanner', credentialEpoch: 1 },
    tables: ['scans', 'counters'],
  });
  const closing = finalizeScan(g, {
    id: 'scan',
    claimAt: 1,
    outcome: 'refused',
    reason: 'not_found',
    passId: null,
    templateId: null,
    actionId: null,
    actionKind: null,
    passVersion: null,
    overrideOf: null,
    approvedBy: null,
  });
  return { g, closing };
}

describe('the stop grant counts a miss only right after the statement that closes the scan', () => {
  it('accepts the increment directly after it', () => {
    const { g, closing } = stopGrant();
    expect(() => grantMiss(g, closing, kit.ctx, actor(kit.org.id), 1)).not.toThrow();
  });

  it('refuses an increment with another statement in between (changes() would read that one)', () => {
    const { g, closing } = stopGrant();
    g.audit({
      at: 1,
      orgId: kit.org.id,
      actorType: 'scanner',
      actorId: 'scanner',
      action: 'scan.test',
      targetType: null,
      targetId: null,
      requestId: null,
      ipPrefix: null,
      detail: null,
    });
    expect(() => grantMiss(g, closing, kit.ctx, actor(kit.org.id), 1)).toThrow(
      'must follow the statement that closes the scan',
    );
  });
});
