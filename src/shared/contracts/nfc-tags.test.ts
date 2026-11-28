import { describe, expect, it } from 'vitest';
import { OffboardRequestSchema, SignOutRequestSchema } from './access-business.ts';
import {
  AdminBindTagSchema,
  CreateSpareTagsSchema,
  CreateTagTypeSchema,
  UpdateTagTypeSchema,
} from './nfc-tag-admin.ts';
import {
  CreateTagKeysetSchema,
  ScanTagBindRequestSchema,
  TAG_ERROR_CODES,
  TagEndCauseSchema,
  TagReadSchema,
  TagSchema,
} from './nfc-tags.ts';
import {
  SCAN_HEADS_UP_REASONS,
  SCAN_REFUSED_REASONS,
  ScanInputSchema,
  ScannerSettingsSchema,
  ScanOutcomeSchema,
} from './scan.ts';
import { ScanLiveMessageSchema } from './scan-setups.ts';
import {
  NativeScannerCapabilitiesSchema,
  ScanningSessionSettingsSchema,
} from './scanning-sessions.ts';

const read = { uid: '04A1B2C3D4E5F6', tech: 'a', source: 'native' } as const;
const key = '01890f47-0000-7000-8000-000000000001';

describe('TagRead', () => {
  it('takes a UID of 4, 7 or 10 bytes, or an NDEF record', () => {
    for (const uid of ['04A1B2C3', '04A1B2C3D4E5F6', '04A1B2C3D4E5F6A7B8C9']) {
      expect(TagReadSchema.safeParse({ ...read, uid }).success).toBe(true);
    }
    const ndef = { type: 'U', value: 'https://x.test/t/abcd2345?p=00&m=00' };
    expect(TagReadSchema.safeParse({ tech: 'isodep', source: 'webnfc', ndef }).success).toBe(true);
  });

  it('takes the reader and keyboard sources, and a typed UID carries no NDEF', () => {
    for (const source of ['reader', 'keyboard'] as const)
      expect(TagReadSchema.safeParse({ ...read, source }).success).toBe(true);
    expect(TagReadSchema.safeParse({ ...read, source: 'other' }).success).toBe(false);
    const ndef = { type: 'U', value: 'https://x.test/t/abcd2345?p=00&m=00' };
    expect(TagReadSchema.safeParse({ ...read, source: 'reader', ndef }).success).toBe(true);
    expect(TagReadSchema.safeParse({ ...read, source: 'keyboard', ndef }).success).toBe(false);
    expect(TagReadSchema.safeParse({ tech: 'unknown', source: 'keyboard', ndef }).success).toBe(
      false,
    );
  });

  it('refuses an empty read', () => {
    expect(TagReadSchema.safeParse({ tech: 'a', source: 'native' }).success).toBe(false);
    expect(TagReadSchema.safeParse({ tech: 'a', source: 'native', uidRandom: true }).success).toBe(
      false,
    );
  });

  it('refuses a bad UID length or a non-hex UID', () => {
    for (const uid of ['', '04A1', '04A1B2C3D4', '04A1B2C3D4E5F6A7B8C9D0', '04A1B2CZ'])
      expect(TagReadSchema.safeParse({ ...read, uid }).success).toBe(false);
  });

  it('refuses NDEF over 1024 bytes and counts bytes, not characters', () => {
    const ndef = (value: string) => ({ tech: 'a', source: 'native', ndef: { type: 'T', value } });
    expect(TagReadSchema.safeParse(ndef('a'.repeat(1024))).success).toBe(true);
    expect(TagReadSchema.safeParse(ndef('a'.repeat(1025))).success).toBe(false);
    expect(TagReadSchema.safeParse(ndef('é'.repeat(513))).success).toBe(false);
    expect(TagReadSchema.safeParse(ndef('')).success).toBe(false);
  });

  it('refuses unknown keys', () => {
    expect(TagReadSchema.safeParse({ ...read, extra: 1 }).success).toBe(false);
  });
});

describe('scan input', () => {
  it('still takes a code and a pass id', () => {
    expect(ScanInputSchema.safeParse({ code: 'abc', method: 'camera' }).success).toBe(true);
    expect(ScanInputSchema.safeParse({ passId: 'p1', method: 'manual' }).success).toBe(true);
  });

  it('takes a tag read, with an optional pass pin', () => {
    expect(ScanInputSchema.safeParse({ tag: read, method: 'nfc' }).success).toBe(true);
    expect(ScanInputSchema.safeParse({ tag: read, method: 'nfc', passId: 'p1' }).success).toBe(
      true,
    );
    expect(ScanInputSchema.safeParse({ tag: read, method: 'camera' }).success).toBe(false);
    expect(ScanInputSchema.safeParse({ tag: {}, method: 'nfc' }).success).toBe(false);
  });
});

describe('old fixtures and stored settings parse', () => {
  const settings = {
    flow: 'auto',
    defaultActionId: null,
    roleWithoutSignIn: 'door',
    staffSignIn: false,
    letInAgain: 'never',
    reader: 'barcode',
    lookup: true,
    offline: false,
    dailyAmount: null,
  };

  it('scanner and session settings without tags', () => {
    expect(ScannerSettingsSchema.parse(settings).tags).toBeUndefined();
    expect(ScanningSessionSettingsSchema.parse(settings).tags).toBeUndefined();
  });

  it('tags settings default to desk for a pass and manager for a person', () => {
    expect(ScannerSettingsSchema.parse({ ...settings, tags: {} }).tags).toEqual({
      assign: 'desk',
      assignAll: 'manager',
    });
    const session = ScanningSessionSettingsSchema.parse({ ...settings, tags: { level: 'secure' } });
    expect(session.tags?.level).toBe('secure');
    expect(
      ScanningSessionSettingsSchema.safeParse({ ...settings, tags: { level: 'x' } }).success,
    ).toBe(false);
  });

  it('device NFC formats, with the new tag formats and no continuous flag', () => {
    const nfc = { available: true, reading: false, formats: ['ndef', 'wallet-vas'] };
    const base = NativeScannerCapabilitiesSchema.shape.nfc;
    expect(base.safeParse(nfc).success).toBe(true);
    expect(
      base.safeParse({
        ...nfc,
        formats: ['ndef', 'wallet-vas', 'tag-uid', 'tag-sun'],
        continuous: true,
      }).success,
    ).toBe(true);
    expect(
      base.safeParse({ ...nfc, formats: ['ndef', 'wallet-vas', 'tag-uid', 'tag-sun', 'x'] })
        .success,
    ).toBe(false);
  });

  it('an outcome without a tag', () => {
    expect(ScanOutcomeSchema.shape.tag.safeParse(undefined).success).toBe(true);
    expect(ScanOutcomeSchema.shape.tag.safeParse(null).success).toBe(true);
    expect(
      ScanOutcomeSchema.shape.tag.safeParse({ hint: '3FA1', assurance: 'secure', scope: 'user' })
        .success,
    ).toBe(true);
    expect(
      ScanOutcomeSchema.shape.tag.safeParse({ hint: '3fa1', assurance: 'secure', scope: 'user' })
        .success,
    ).toBe(false);
  });
});

describe('reasons', () => {
  it('lists the tag reasons as refusals', () => {
    for (const r of ['tag_lost', 'tag_not_allowed', 'tag_invalid'])
      expect(SCAN_REFUSED_REASONS).toContain(r);
    expect(SCAN_HEADS_UP_REASONS).not.toContain('tag_lost');
  });
});

describe('live messages', () => {
  it('carries a tag request and its cancellation to a device', () => {
    expect(ScanLiveMessageSchema.safeParse({ enroll: { id: 'e1', expiresAt: 5 } }).success).toBe(
      true,
    );
    expect(ScanLiveMessageSchema.safeParse({ enroll: { id: 'e1', cancelled: true } }).success).toBe(
      true,
    );
    expect(ScanLiveMessageSchema.safeParse({ enroll: { id: 'e1' } }).success).toBe(false);
    expect(ScanLiveMessageSchema.safeParse({ control: 'reset' }).success).toBe(true);
  });
});

describe('tag requests', () => {
  it('binds to a pass by default and refuses a bad PIN', () => {
    const bind = { idempotencyKey: key, tag: read, card: { code: 'abc', method: 'camera' } };
    expect(ScanTagBindRequestSchema.parse(bind)).toMatchObject({ binding: 'pass', preview: false });
    expect(ScanTagBindRequestSchema.safeParse({ ...bind, approval: { pin: '12' } }).success).toBe(
      false,
    );
    expect(ScanTagBindRequestSchema.safeParse({ ...bind, binding: 'org' }).success).toBe(false);
  });

  it('keysets take entered keys or generate', () => {
    const k = '0123456789abcdef0123456789abcdef';
    expect(CreateTagKeysetSchema.safeParse({ name: 'Door', generate: true }).success).toBe(true);
    expect(CreateTagKeysetSchema.safeParse({ name: 'Door', metaKey: k, fileKey: k }).success).toBe(
      true,
    );
    expect(CreateTagKeysetSchema.safeParse({ name: 'Door', metaKey: k }).success).toBe(false);
    expect(
      CreateTagKeysetSchema.safeParse({ name: 'Door', metaKey: 'x', fileKey: k }).success,
    ).toBe(false);
  });

  it('has one code list', () => {
    expect(new Set(TAG_ERROR_CODES).size).toBe(TAG_ERROR_CODES.length);
  });
});

describe('access business', () => {
  it('offboards by email or external id, not both and not neither', () => {
    expect(OffboardRequestSchema.parse({ holderEmail: 'A@x.test' })).toMatchObject({
      holderEmail: 'a@x.test',
      passes: 'void',
      tags: 'spare',
      dryRun: false,
    });
    expect(OffboardRequestSchema.safeParse({ externalId: 'e-1', passes: 'remove' }).success).toBe(
      true,
    );
    expect(OffboardRequestSchema.safeParse({}).success).toBe(false);
    expect(
      OffboardRequestSchema.safeParse({ holderEmail: 'a@x.test', externalId: 'e' }).success,
    ).toBe(false);
  });

  it('signs out by pass or by a tapped tag, not both or neither', () => {
    expect(SignOutRequestSchema.safeParse({ idempotencyKey: key, passId: 'p' }).success).toBe(true);
    const read = { uid: '04a1b2c3', tech: 'a', source: 'native' };
    expect(SignOutRequestSchema.safeParse({ idempotencyKey: key, read }).success).toBe(true);
    expect(SignOutRequestSchema.safeParse({ idempotencyKey: key }).success).toBe(false);
    expect(SignOutRequestSchema.safeParse({ idempotencyKey: key, passId: 'p', read }).success).toBe(
      false,
    );
    expect(SignOutRequestSchema.safeParse({ idempotencyKey: key, read, tag: 'none' }).success).toBe(
      false,
    );
  });
});

describe('tag systems and types', () => {
  const oldTag = {
    id: 't1',
    mode: 'live',
    kind: 'uid',
    assurance: 'basic',
    hint: '3FA1',
    label: null,
    pool: false,
    status: 'active',
    state: 'spare',
    createdAt: 1,
    lastSeenAt: null,
    keysetId: null,
    binding: null,
  };

  it('a tag from before systems and types still parses', () => {
    expect(TagSchema.safeParse(oldTag).success).toBe(true);
    const next = {
      ...oldTag,
      system: 'uid',
      type: { id: 'ty1', name: 'Wristband', use: 'member' },
    };
    expect(TagSchema.safeParse(next).success).toBe(true);
    expect(TagSchema.safeParse({ ...next, system: 'nfc' }).success).toBe(false);
    expect(
      TagSchema.safeParse({ ...next, type: { id: 'ty1', name: 'x', use: 'asset' } }).success,
    ).toBe(false);
  });

  it('ends a binding for the new causes', () => {
    for (const c of ['channel_off', 'expired', 'type_changed', 'visitor_out'])
      expect(TagEndCauseSchema.safeParse(c).success).toBe(true);
  });

  it('a type takes the design defaults, and a Secure type cannot be typed', () => {
    expect(CreateTagTypeSchema.parse({ name: 'Member wristband', use: 'member' })).toEqual({
      name: 'Member wristband',
      system: 'uid',
      use: 'member',
      scopes: 'both',
      perPass: 1,
      bindingDays: null,
      confirm: 'none',
      typed: true,
      templateIds: [],
    });
    expect(
      CreateTagTypeSchema.safeParse({ name: 'Badge', use: 'staff', system: 'sun' }).success,
    ).toBe(false);
    expect(
      CreateTagTypeSchema.safeParse({ name: 'Badge', use: 'staff', system: 'sun', typed: false })
        .success,
    ).toBe(true);
    expect(CreateTagTypeSchema.safeParse({ name: 'x', use: 'member', perPass: 5 }).success).toBe(
      false,
    );
    expect(
      CreateTagTypeSchema.safeParse({ name: 'x', use: 'member', bindingDays: 0 }).success,
    ).toBe(false);
  });

  it('an update needs the version and never changes the system', () => {
    expect(UpdateTagTypeSchema.safeParse({ name: 'x' }).success).toBe(false);
    expect(UpdateTagTypeSchema.safeParse({ version: 1, name: 'x' }).success).toBe(true);
    expect(UpdateTagTypeSchema.safeParse({ version: 1, system: 'sun' }).success).toBe(false);
  });

  it('an admin binds a spare by id or a typed ID, and adds spares in bulk', () => {
    expect(AdminBindTagSchema.safeParse({ tagId: 't1', binding: 'pass' }).success).toBe(true);
    expect(
      AdminBindTagSchema.safeParse({ uid: '04 A1 B2 C3', format: 'reversed', binding: 'user' })
        .success,
    ).toBe(true);
    expect(AdminBindTagSchema.safeParse({ tagId: 't1', uid: 'AA', binding: 'pass' }).success).toBe(
      false,
    );
    expect(
      AdminBindTagSchema.safeParse({ uid: 'AA', format: 'octal', binding: 'pass' }).success,
    ).toBe(false);
    expect(CreateSpareTagsSchema.safeParse({ ids: ['04A1B2C3'] }).success).toBe(true);
    expect(CreateSpareTagsSchema.safeParse({ ids: [] }).success).toBe(false);
    expect(
      CreateSpareTagsSchema.safeParse({ ids: Array.from({ length: 201 }, (_, i) => `${i}`) })
        .success,
    ).toBe(false);
  });

  it('a session names at most 12 types and a Basic-tag confirm', () => {
    const base = {
      flow: 'auto',
      defaultActionId: null,
      roleWithoutSignIn: 'door',
      staffSignIn: false,
      letInAgain: 'never',
      reader: 'nfc',
      lookup: true,
      offline: false,
      dailyAmount: null,
    };
    const tags = (t: object) => ScanningSessionSettingsSchema.safeParse({ ...base, tags: t });
    expect(tags({ types: ['standard', 'ty1'], confirmBasic: 'staff' }).success).toBe(true);
    expect(tags({ confirmBasic: 'everyone' }).success).toBe(false);
    expect(tags({ types: Array.from({ length: 13 }, (_, i) => `t${i}`) }).success).toBe(false);
  });

  it('a scan outcome tag carries the system and type name, and tag_expired is a refusal', () => {
    expect(
      ScanOutcomeSchema.shape.tag.safeParse({
        hint: '3FA1',
        assurance: 'basic',
        scope: 'pass',
        system: 'uid',
        typeName: 'Visitor tag',
      }).success,
    ).toBe(true);
    expect(SCAN_REFUSED_REASONS).toContain('tag_expired');
  });
});
