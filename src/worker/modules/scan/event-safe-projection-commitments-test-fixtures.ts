import { expect, it } from 'vitest';
import type { ScanActor } from './actor.ts';
import {
  eventSafeProjectionWithCommitments,
  verifyEventActionLabelHash,
  verifyEventScannerNameHash,
  verifyEventTitleHash,
} from './event-safe-projection.ts';
import type { Found } from './resolve.ts';

type Fixture = (options?: { title?: string }) => {
  found: Found;
  actor: ScanActor;
  action: Found['scan']['actions'][number];
};

export function registerEventTitleCommitmentTests(
  fixture: Fixture,
  env: { KEK_V1: string },
  otherEnv: { KEK_V1: string },
) {
  it('commits only role-visible safe titles without storing them and binds every scope component', async () => {
    const { found, actor, action } = fixture({ title: '{{lounge}}' });
    const projection = await eventSafeProjectionWithCommitments(
      env,
      found,
      actor,
      action,
      'scan-1',
    );
    expect(projection.roles.door?.titleHash).toBeNull();
    expect(projection.roles.desk?.titleHash).toBeNull();
    const hash = projection.roles.manager?.titleHash ?? null;
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(projection)).not.toContain('Roof Lounge');
    const args = {
      orgId: 'org-1',
      passId: 'pass-1',
      scanId: 'scan-1',
      role: 'manager' as const,
      title: 'Roof Lounge',
      hash,
    };
    expect(await verifyEventTitleHash(env, args)).toBe(true);
    await expect(verifyEventTitleHash({}, args)).rejects.toThrow();
    expect(await verifyEventTitleHash(otherEnv, args)).toBe(false);
    expect(await verifyEventTitleHash(env, { ...args, orgId: 'org-2' })).toBe(false);
    expect(await verifyEventTitleHash(env, { ...args, passId: 'pass-2' })).toBe(false);
    expect(await verifyEventTitleHash(env, { ...args, scanId: 'scan-2' })).toBe(false);
    expect(await verifyEventTitleHash(env, { ...args, role: 'desk' })).toBe(false);
    expect(await verifyEventTitleHash(env, { ...args, title: 'Another title' })).toBe(false);
    expect(await verifyEventTitleHash(env, { ...args, hash: '0'.repeat(64) })).toBe(false);
    expect(await verifyEventTitleHash(env, { ...args, hash: 'broken' })).toBe(false);
  });

  it('binds action labels and scanner names to scope, role, identity and separate purposes', async () => {
    const { found, actor, action } = fixture();
    const projection = await eventSafeProjectionWithCommitments(
      env,
      found,
      actor,
      action,
      'scan-1',
    );
    const manager = projection.roles.manager;
    if (!manager) throw new Error('Missing manager projection');
    const label = {
      orgId: 'org-1',
      passId: 'pass-1',
      scanId: 'scan-1',
      role: 'manager' as const,
      actionId: 'enter',
      kind: 'check_in' as const,
      label: 'Check in',
      hash: manager.action?.labelHash ?? null,
    };
    const name = {
      orgId: 'org-1',
      passId: 'pass-1',
      scanId: 'scan-1',
      role: 'manager' as const,
      scannerName: 'Main Gate',
      hash: manager.scannerNameHash,
    };
    expect(await verifyEventActionLabelHash(env, label)).toBe(true);
    await expect(verifyEventActionLabelHash({}, label)).rejects.toThrow();
    expect(await verifyEventActionLabelHash(env, { ...label, actionId: 'other' })).toBe(false);
    expect(await verifyEventActionLabelHash(env, { ...label, kind: 'set' })).toBe(false);
    expect(await verifyEventActionLabelHash(env, { ...label, label: 'Changed' })).toBe(false);
    expect(await verifyEventActionLabelHash(env, { ...label, role: 'desk' })).toBe(false);
    expect(await verifyEventActionLabelHash(env, { ...label, hash: name.hash })).toBe(false);
    expect(await verifyEventScannerNameHash(env, name)).toBe(true);
    await expect(verifyEventScannerNameHash({}, name)).rejects.toThrow();
    expect(await verifyEventScannerNameHash(otherEnv, name)).toBe(false);
    expect(await verifyEventScannerNameHash(env, { ...name, scanId: 'scan-2' })).toBe(false);
    expect(await verifyEventScannerNameHash(env, { ...name, role: 'desk' })).toBe(false);
    expect(await verifyEventScannerNameHash(env, { ...name, scannerName: 'Other Gate' })).toBe(
      false,
    );
    expect(await verifyEventScannerNameHash(env, { ...name, hash: label.hash })).toBe(false);
    const stored = JSON.stringify(projection);
    expect(stored).not.toContain('enter');
    expect(stored).not.toContain('Check in');
    expect(stored).not.toContain('Main Gate');
    expect(stored).not.toContain('Morgan Rider');
  });

  it('captures the evaluated actor and source before asynchronous key derivation', async () => {
    const { found, actor, action } = fixture();
    const pending = eventSafeProjectionWithCommitments(env, found, actor, action, 'scan-1');
    actor.role = 'door';
    if (!actor.scanner) throw new Error('Missing scanner');
    actor.scanner.name = 'Changed Scanner';
    found.pass.personalization.memberName = 'Changed Holder';
    const projection = await pending;
    expect(
      await verifyEventScannerNameHash(env, {
        orgId: 'org-1',
        passId: 'pass-1',
        scanId: 'scan-1',
        role: 'manager',
        scannerName: 'Main Gate',
        hash: projection.roles.manager?.scannerNameHash ?? null,
      }),
    ).toBe(true);
    expect(
      await verifyEventActionLabelHash(env, {
        orgId: 'org-1',
        passId: 'pass-1',
        scanId: 'scan-1',
        role: 'manager',
        actionId: 'enter',
        kind: 'check_in',
        label: 'Check in',
        hash: projection.roles.manager?.action?.labelHash ?? null,
      }),
    ).toBe(true);
    expect(
      await verifyEventTitleHash(env, {
        orgId: 'org-1',
        passId: 'pass-1',
        scanId: 'scan-1',
        role: 'manager',
        title: 'Morgan Rider',
        hash: projection.roles.manager?.titleHash ?? null,
      }),
    ).toBe(true);
    expect(JSON.stringify(projection)).not.toContain('Morgan Rider');
    expect(JSON.stringify(projection)).not.toContain('Changed Holder');
  });
}
