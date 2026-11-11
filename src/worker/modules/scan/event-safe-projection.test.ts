import { describe, expect, it } from 'vitest';
import type {
  PassJson,
  Personalization,
  ScanAction,
  ScanRole,
  TemplateManifest,
} from '../../../passkit/types.ts';
import { scanOf } from '../../../shared/scan-defaults.ts';
import { ADMIN_SETTINGS, type ScanActor } from './actor.ts';
import { cardPrivacy } from './dto-projection.ts';
import {
  eventSafeProjection,
  eventSafeProjectionWithCommitments,
  verifyEventActionLabelHash,
  verifyEventScannerNameHash,
} from './event-safe-projection.ts';
import { registerEventTitleCommitmentTests } from './event-safe-projection-commitments-test-fixtures.ts';
import { scanValueSafe } from './projection-privacy.ts';
import type { Found } from './resolve.ts';
import { ROLE_RANK } from './rules.ts';

const env = { KEK_V1: btoa(String.fromCharCode(...new Uint8Array(32).fill(37))) };
const otherEnv = { KEK_V1: btoa(String.fromCharCode(...new Uint8Array(32).fill(38))) };
const PUBLIC_ACTION: ScanAction = { id: 'enter', label: 'Check in', kind: 'check_in' };
const personalization: Personalization = {
  memberName: 'Morgan Rider',
  tier: 'Silver',
  lounge: 'Roof Lounge',
  privateNote: 'PRIVATE-NOTE-FOUND',
};

type FixtureOptions = {
  role?: ScanRole;
  action?: ScanAction;
  activeAction?: ScanAction;
  pinnedInputs?: Record<string, Record<string, unknown>>;
  activeInputs?: Record<string, Record<string, unknown>>;
  title?: string;
  scannerName?: string;
};

function fixture(options: FixtureOptions = {}) {
  const role = options.role ?? 'manager';
  const action = options.action ?? PUBLIC_ACTION;
  const properties = {
    memberName: { type: 'string' },
    tier: { type: 'string' },
    lounge: { type: 'string', 'x-scan': 'manager' },
    privateNote: { type: 'string', 'x-scan': 'hidden' },
    ...options.pinnedInputs,
  };
  const manifest = {
    name: 'Entry ticket',
    inputs: { type: 'object', properties },
    bindings: [],
    display: { title: options.title ?? '{{memberName}}' },
    scan: { actions: [action] },
  } as unknown as TemplateManifest;
  const activeManifest = {
    ...structuredClone(manifest),
    inputs: { type: 'object', properties: { ...properties, ...options.activeInputs } },
    scan: { actions: [options.activeAction ?? action] },
  } as unknown as TemplateManifest;
  const template = { version: 'v1', manifest };
  const active = { version: 'v2', manifest: activeManifest };
  const pinnedAction = scanOf(manifest).actions[0]!;
  const activeAction = scanOf(activeManifest).actions[0]!;
  const resolved = {
    ...pinnedAction,
    minRole:
      ROLE_RANK[pinnedAction.minRole] >= ROLE_RANK[activeAction.minRole]
        ? pinnedAction.minRole
        : activeAction.minRole,
  };
  const found = {
    pass: {
      id: 'pass-1',
      orgId: 'org-1',
      mode: 'live',
      templateVersion: 'v1',
      personalization: structuredClone(personalization),
      serial: 'SERIAL-PRIVATE',
      authToken: 'AUTH-PRIVATE-111',
      downloadToken: 'DOWNLOAD-PRIVATE',
      webServiceUrl: 'https://private.example.test',
      scanCode: 'SCAN-PRIVATE',
      externalId: null,
      holderEmail: null,
    },
    passJson: {
      formatVersion: 1,
      passTypeIdentifier: 'type.example',
      teamIdentifier: 'team',
      serialNumber: 'SERIAL-PRIVATE',
      organizationName: 'Test',
      description: 'Ticket',
      barcodes: [
        { format: 'PKBarcodeFormatQR', message: 'BARCODE-PRIVATE', messageEncoding: 'utf-8' },
      ],
    } as PassJson,
    template,
    activePolicy: active,
    activeTemplate: active,
    activeVersion: 'v2',
    walletTemplateVersion: 'v1',
    versionPersonalization: JSON.stringify(personalization),
    scan: { ...scanOf(manifest), actions: [resolved] },
  } as unknown as Found;
  const actor = {
    principal: 'admin',
    orgId: 'org-1',
    mode: 'live',
    actorKey: 'u:admin',
    actor: { type: 'user', id: 'admin' },
    scanner: { name: options.scannerName ?? 'Main Gate' },
    event: null,
    templateIds: [],
    timeZone: 'UTC',
    role,
    staff: null,
    settings: { ...ADMIN_SETTINGS },
    name: 'Admin console',
    terminal: false,
  } as unknown as ScanActor;
  return { found, actor, action: found.scan.actions[0]! };
}

const visible = { kind: 'check_in', labelHash: null };

describe('event-time scanner disclosure', () => {
  it('keeps a safe public action for each independently permitted role', () => {
    const { found, actor, action } = fixture();
    const actorBefore = structuredClone(actor);
    expect(eventSafeProjection(found, actor, action)).toEqual({
      v: 1,
      roles: {
        door: { action: visible, scannerNameHash: null, titleHash: null },
        desk: { action: visible, scannerNameHash: null, titleHash: null },
        manager: { action: visible, scannerNameHash: null, titleHash: null },
      },
    });
    expect(actor).toEqual(actorBefore);
    expect(JSON.stringify(eventSafeProjection(found, actor, action))).not.toContain('Morgan Rider');
  });

  it('caps simulation at the actual role even for an admin with manager staff authority', () => {
    const { found, actor, action } = fixture({ role: 'door' });
    actor.staff = { role: 'manager' } as ScanActor['staff'];
    const before = structuredClone(actor);
    const projection = eventSafeProjection(found, actor, action);
    expect(Object.keys(projection.roles)).toEqual(['door']);
    expect(projection.roles.door?.action).toEqual(visible);
    expect(actor).toEqual(before);
  });

  it('intersects pinned and active action roles, even for an otherwise public action', () => {
    const { found, actor, action } = fixture({
      action: PUBLIC_ACTION,
      activeAction: { ...PUBLIC_ACTION, minRole: 'manager' },
    });
    const projection = eventSafeProjection(found, actor, action);
    expect(projection.roles.door?.action).toBeNull();
    expect(projection.roles.desk?.action).toBeNull();
    expect(projection.roles.manager?.action).toEqual(visible);
  });

  it('requires the action input to survive both current and historical source policies', () => {
    const inputAction: ScanAction = { ...PUBLIC_ACTION, input: 'tier' };
    const desk = fixture({
      action: inputAction,
      activeInputs: { tier: { type: 'string', 'x-scan': 'desk' } },
    });
    const deskProjection = eventSafeProjection(desk.found, desk.actor, desk.action);
    expect(deskProjection.roles.door?.action).toBeNull();
    expect(deskProjection.roles.desk?.action).toEqual(visible);
    expect(deskProjection.roles.manager?.action).toEqual(visible);

    const hidden = fixture({
      action: inputAction,
      activeInputs: { tier: { type: 'string', 'x-scan': 'hidden' } },
    });
    const hiddenProjection = eventSafeProjection(hidden.found, hidden.actor, hidden.action);
    expect(Object.values(hiddenProjection.roles).every((value) => value?.action === null)).toBe(
      true,
    );
  });

  it('does not let an admin/staff actor leak a manager-only value into lower-role text', async () => {
    const action: ScanAction = { ...PUBLIC_ACTION, label: 'Use Roof Lounge' };
    const sample = fixture({ action, scannerName: 'Entry Roof Lounge', title: '{{lounge}}' });
    sample.actor.staff = { role: 'manager' } as ScanActor['staff'];
    const projection = await eventSafeProjectionWithCommitments(
      env,
      sample.found,
      sample.actor,
      sample.action,
      'scan-1',
    );
    expect(projection.roles.door).toEqual({ action: null, scannerNameHash: null, titleHash: null });
    expect(projection.roles.desk).toEqual({ action: null, scannerNameHash: null, titleHash: null });
    const manager = projection.roles.manager!;
    expect(manager.action?.kind).toBe('check_in');
    expect(
      await verifyEventActionLabelHash(env, {
        orgId: 'org-1',
        passId: 'pass-1',
        scanId: 'scan-1',
        role: 'manager',
        actionId: 'enter',
        kind: 'check_in',
        label: 'Use Roof Lounge',
        hash: manager.action?.labelHash ?? null,
      }),
    ).toBe(true);
    expect(
      await verifyEventScannerNameHash(env, {
        orgId: 'org-1',
        passId: 'pass-1',
        scanId: 'scan-1',
        role: 'manager',
        scannerName: 'Entry Roof Lounge',
        hash: manager.scannerNameHash,
      }),
    ).toBe(true);
    expect(JSON.stringify(projection)).not.toContain('Roof Lounge');
  });

  it('rejects action input/identity drift or an unsafe active label', () => {
    const drift = fixture({
      action: { ...PUBLIC_ACTION, input: 'tier' },
      activeAction: { ...PUBLIC_ACTION, input: 'lounge' },
    });
    expect(
      eventSafeProjection(drift.found, drift.actor, drift.action).roles.manager?.action,
    ).toBeNull();
    const active = fixture({
      activeAction: { ...PUBLIC_ACTION, label: 'Private PRIVATE-NOTE-FOUND' },
    });
    expect(
      eventSafeProjection(active.found, active.actor, active.action).roles.manager?.action,
    ).toBeNull();
    const forged = fixture();
    expect(
      eventSafeProjection(forged.found, forged.actor, { ...forged.action, label: 'Changed' }).roles
        .manager?.action,
    ).toBeNull();
  });

  it('does not persist an action id copied from a visible input or opaque Wallet data', () => {
    const sample = fixture({ action: { ...PUBLIC_ACTION, id: 'silver' } });
    sample.found.pass.personalization.tier = 'silver';
    sample.found.versionPersonalization = JSON.stringify({ ...personalization, tier: 'silver' });
    expect(
      eventSafeProjection(sample.found, sample.actor, sample.action).roles.manager?.action,
    ).toBeNull();
    const opaque = fixture({ action: { ...PUBLIC_ACTION, id: 'raw_wallet_identifier' } });
    opaque.found.passJson.userInfo = { nested: { external: 'raw_wallet_identifier' } };
    expect(
      eventSafeProjection(opaque.found, opaque.actor, opaque.action).roles.manager?.action,
    ).toBeNull();
  });

  it.each([
    'BARCODE-PRIVATE',
    'prefix BARCODE-PRIVATE suffix',
    'prefix AUTH-PRIVATE-111 suffix',
    'prefix PRIVATE-NOTE-FOUND suffix',
  ])('never persists a label containing protected data: %s', (label) => {
    const sample = fixture({ action: { ...PUBLIC_ACTION, label } });
    const projection = eventSafeProjection(sample.found, sample.actor, sample.action);
    expect(Object.values(projection.roles).every((value) => value?.action === null)).toBe(true);
    expect(JSON.stringify(projection)).not.toContain(label);
  });

  it('checks denied values from the bounded Wallet personalization as well as the current pass', () => {
    const sample = fixture({ action: { ...PUBLIC_ACTION, label: 'Old WALLET-PRIVATE-NOTE' } });
    sample.found.versionPersonalization = JSON.stringify({
      ...personalization,
      privateNote: 'WALLET-PRIVATE-NOTE',
    });
    expect(
      Object.values(eventSafeProjection(sample.found, sample.actor, sample.action).roles).every(
        (value) => value?.action === null,
      ),
    ).toBe(true);
  });

  it('returns a minimal projection without Found or with an invalid actor/policy', () => {
    const sample = fixture();
    const minimal = { v: 1, roles: {} };
    expect(eventSafeProjection(null, sample.actor, sample.action)).toEqual(minimal);
    sample.actor.role = null;
    expect(eventSafeProjection(sample.found, sample.actor, sample.action)).toEqual(minimal);
    sample.actor.role = 'manager';
    sample.found.activeVersion = 'unavailable-policy';
    expect(eventSafeProjection(sample.found, sample.actor, sample.action)).toEqual(minimal);
  });

  it('retains safe actions with optional or different Wallet personalization and protects unknown leaves', async () => {
    const sample = fixture();
    for (const value of [null, '{bad', '[]', 'null']) {
      sample.found.versionPersonalization = value;
      expect(
        eventSafeProjection(sample.found, sample.actor, sample.action).roles.manager?.action,
      ).toEqual(visible);
    }
    sample.found.versionPersonalization = JSON.stringify(personalization);
    sample.found.walletTemplateVersion = 'older-wallet-policy';
    const projection = await eventSafeProjectionWithCommitments(
      env,
      sample.found,
      sample.actor,
      sample.action,
      'scan-1',
    );
    expect(projection.roles.manager?.action?.kind).toBe('check_in');
    expect(projection.roles.manager?.scannerNameHash).toMatch(/^[0-9a-f]{64}$/);
    expect(projection.roles.manager?.titleHash).toBeNull();
    const publicDescription = fixture({ action: { ...PUBLIC_ACTION, label: 'Ticket' } });
    expect(
      eventSafeProjection(
        publicDescription.found,
        publicDescription.actor,
        publicDescription.action,
      ).roles.manager?.action?.kind,
    ).toBe('check_in');
  });
});

describe('Wallet values in scanner privacy predicates', () => {
  it('denies nested userInfo, NFC, authentication, barcode text and escaped/encoded values', () => {
    const { found, actor } = fixture();
    found.passJson.authenticationToken = 'WALLET-AUTH-SECRET';
    found.passJson.barcode = {
      format: 'PKBarcodeFormatQR',
      message: 'LEGACY-CODE',
      messageEncoding: 'utf-8',
      altText: 'LEGACY-ALT',
    };
    found.passJson.barcodes![0]!.altText = 'BARCODE-ALT';
    found.passJson.nfc = {
      message: 'NFC-SECRET',
      encryptionPublicKey: 'NFC-PUBLIC-KEY',
      requiresAuthentication: true,
    };
    found.passJson.userInfo = {
      nested: [{ opaque: '<hidden&value>' }, { number: 42, flag: true, small: 'xyz' }],
    };
    const policy = cardPrivacy(found, actor);
    for (const value of [
      'prefix WALLET-AUTH-SECRET suffix',
      'prefix LEGACY-CODE suffix',
      'prefix LEGACY-ALT suffix',
      'prefix BARCODE-ALT suffix',
      'prefix NFC-SECRET suffix',
      'prefix NFC-PUBLIC-KEY suffix',
      'prefix <hidden&value> suffix',
      'prefix &lt;hidden&amp;value&gt; suffix',
      `prefix ${encodeURIComponent('<hidden&value>')} suffix`,
      'prefix xyz suffix',
    ]) {
      expect(scanValueSafe(found, value, actor)).toBe(false);
      expect(policy.safe(value)).toBe(false);
    }
    expect(scanValueSafe(found, 'General entry', actor)).toBe(true);
    expect(policy.safe('General entry')).toBe(true);
    // Opaque Wallet numbers and booleans protect their spelling in strings, not unrelated scalars.
    expect(scanValueSafe(found, 42, actor)).toBe(true);
    expect(policy.safe(42)).toBe(true);
    expect(scanValueSafe(found, true, actor)).toBe(true);
    expect(policy.safe(true)).toBe(true);
  });

  it('applies the same Wallet denylist before signing action and scanner names', async () => {
    const sample = fixture({
      action: { ...PUBLIC_ACTION, label: 'Inspect hidden%2Fwallet' },
      scannerName: 'Gate NFC-SECRET',
    });
    sample.found.passJson.userInfo = { nested: ['hidden/wallet'] };
    sample.found.passJson.nfc = { message: 'NFC-SECRET', encryptionPublicKey: 'NFC-PUBLIC' };
    const projection = await eventSafeProjectionWithCommitments(
      env,
      sample.found,
      sample.actor,
      sample.action,
      'scan-1',
    );
    for (const role of ['door', 'desk', 'manager'] as const) {
      expect(projection.roles[role]?.action).toBeNull();
      expect(projection.roles[role]?.scannerNameHash).toBeNull();
    }
    expect(JSON.stringify(projection)).not.toContain('hidden%2Fwallet');
    expect(JSON.stringify(projection)).not.toContain('NFC-SECRET');
  });

  it('rejects opaque Wallet metadata without blocking source-authorized display fields', async () => {
    const sample = fixture({
      action: { ...PUBLIC_ACTION, label: 'Use opaque-private-value' },
      scannerName: 'Gate opaque-private-value',
    });
    sample.found.versionPersonalization = null;
    sample.found.passJson.generic = {
      primaryFields: [
        { key: 'name', value: 'Morgan Rider', privateMetadata: 'opaque-private-value' },
      ],
    };
    const projection = await eventSafeProjectionWithCommitments(
      env,
      sample.found,
      sample.actor,
      sample.action,
      'scan-1',
    );
    expect(projection.roles.manager?.action).toBeNull();
    expect(projection.roles.manager?.scannerNameHash).toBeNull();
    expect(projection.roles.manager?.titleHash).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(projection)).not.toContain('opaque-private-value');
    expect(JSON.stringify(projection)).not.toContain('Morgan Rider');
  });

  it('keeps an action visible when its label shares a word with a field label, but not with a field value', async () => {
    const sample = fixture({ action: { ...PUBLIC_ACTION, label: 'Add Points' } });
    sample.found.versionPersonalization = null;
    sample.found.passJson.storeCard = {
      primaryFields: [{ key: 'balance', label: 'Points', value: '120 credits' }],
    };
    const shared = await eventSafeProjectionWithCommitments(
      env,
      sample.found,
      sample.actor,
      sample.action,
      'scan-1',
    );
    expect(shared.roles.manager?.action).not.toBeNull();
    sample.found.passJson.storeCard = {
      primaryFields: [{ key: 'balance', label: 'Points', value: 'Add Points' }],
    };
    const copied = await eventSafeProjectionWithCommitments(
      env,
      sample.found,
      sample.actor,
      sample.action,
      'scan-1',
    );
    expect(copied.roles.manager?.action).toBeNull();
  });

  it('does not commit a scanner name copied from a Wallet field while allowing a source-authorized title', async () => {
    const sample = fixture({ scannerName: 'Morgan Rider' });
    sample.found.passJson.generic = {
      primaryFields: [{ key: 'name', value: 'Morgan Rider' }],
    };
    const projection = await eventSafeProjectionWithCommitments(
      env,
      sample.found,
      sample.actor,
      sample.action,
      'scan-1',
    );
    expect(projection.roles.manager?.scannerNameHash).toBeNull();
    expect(projection.roles.manager?.titleHash).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(projection)).not.toContain('Morgan Rider');
  });
});

describe('event title commitments', () => {
  registerEventTitleCommitmentTests(fixture, env, otherEnv);
});
