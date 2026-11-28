import { describe, expect, it } from 'vitest';
import { JOIN_COPY, joinIssueLine } from '../copy/join.ts';
import { EMAIL_INVALID_MESSAGE } from '../email.ts';
import {
  JOIN_NAME_MESSAGE,
  JoinLinkSchema,
  JoinLinkStateSchema,
  JoinLinkUpdateSchema,
  JoinNameSchema,
  JoinReadinessCodeSchema,
  JoinSubmitSchema,
} from './join.ts';
import { PlatformSettingsSchema } from './settings.ts';

describe('JoinNameSchema', () => {
  it('normalizes: NFC, trim, collapsed spaces', () => {
    expect(JoinNameSchema.parse('  Ana   Maria ')).toBe('Ana Maria');
    expect(JoinNameSchema.parse('Café')).toBe('Café');
  });

  it.each([
    ['empty', ''],
    ['blank', '   '],
    ['41 characters', 'a'.repeat(41)],
    ['bell', 'Ana\u0007'],
    ['NUL', 'A\u0000a'],
    ['bidi override', 'Ana\u202eevil'],
    ['bidi isolate', '\u2066Ana'],
    ['zero width space', 'A\u200bna'],
    ['zero width joiner', 'A\u200dna'],
    ['word joiner', 'A\u2060na'],
    ['full-width www', '\uff57\uff57\uff57\uff0eevil\uff0ecom'],
    ['full-width at', 'ana\uff20x'],
    ['full-width scheme', 'http\uff1a\uff0f\uff0fx'],
    ['arabic letter mark', 'A\u061cna'],
    ['soft hyphen', 'A\u00adna'],
    ['tag character', 'A\u{e0041}na'],
    ['private use', 'A\ue000na'],
    ['unassigned', 'A\u0378na'],
    ['url', 'http://x.io'],
    ['www', 'www.x.io'],
    ['at sign', 'ana@x.io'],
  ])('refuses %s', (_label, value) => {
    const r = JoinNameSchema.safeParse(value);
    expect(r.success).toBe(false);
    if (!r.success) expect(r.error.issues[0]?.message).toBe(JOIN_NAME_MESSAGE);
  });

  it('strips a byte order mark at the edge, as any space', () => {
    expect(JoinNameSchema.parse('\ufeffAna')).toBe('Ana');
  });

  it('keeps 40 characters', () => {
    expect(JoinNameSchema.parse('a'.repeat(40))).toHaveLength(40);
  });
});

describe('JoinSubmitSchema', () => {
  const ok = { 'cf-turnstile-response': 'tok' };

  it('takes a name, a normalized email and the token', () => {
    expect(JoinSubmitSchema.parse({ ...ok, name: ' Ana ', email: ' Ana@Example.COM ' })).toEqual({
      ...ok,
      name: 'Ana',
      email: 'ana@example.com',
    });
  });

  it('treats an empty email box as no email', () => {
    expect(JoinSubmitSchema.parse({ ...ok, email: '' })).toEqual(ok);
  });

  it('refuses a bad email with the shared message', () => {
    const r = JoinSubmitSchema.safeParse({ ...ok, email: 'not an email' });
    expect(r.success).toBe(false);
    if (!r.success) expect(r.error.issues[0]?.message).toBe(EMAIL_INVALID_MESSAGE);
  });

  it('refuses extra fields, a missing or oversized token, and an oversized email', () => {
    expect(JoinSubmitSchema.safeParse({ ...ok, template: 'x' }).success).toBe(false);
    expect(JoinSubmitSchema.safeParse({ name: 'Ana' }).success).toBe(false);
    expect(JoinSubmitSchema.safeParse({ 'cf-turnstile-response': '' }).success).toBe(false);
    expect(JoinSubmitSchema.safeParse({ 'cf-turnstile-response': 'a'.repeat(2049) }).success).toBe(
      false,
    );
    expect(JoinSubmitSchema.safeParse({ ...ok, email: `${'a'.repeat(250)}@x.io` }).success).toBe(
      false,
    );
  });
});

describe('JoinLinkUpdateSchema', () => {
  it('needs a revision and bounds the limit', () => {
    expect(JoinLinkUpdateSchema.parse({ revision: 0, enabled: true, dailyLimit: 5000 })).toEqual({
      revision: 0,
      enabled: true,
      dailyLimit: 5000,
    });
    expect(JoinLinkUpdateSchema.safeParse({ enabled: true }).success).toBe(false);
    expect(JoinLinkUpdateSchema.safeParse({ revision: -1 }).success).toBe(false);
    expect(JoinLinkUpdateSchema.safeParse({ revision: 1, dailyLimit: 0 }).success).toBe(false);
    expect(JoinLinkUpdateSchema.safeParse({ revision: 1, dailyLimit: 5001 }).success).toBe(false);
    expect(JoinLinkUpdateSchema.safeParse({ revision: 1, mode: 'live' }).success).toBe(false);
    expect(JoinLinkUpdateSchema.parse({ revision: 1, nameInput: null }).nameInput).toBeNull();
  });
});

describe('link state', () => {
  const link = {
    id: 'l1',
    templateId: 't1',
    mode: 'live',
    enabled: true,
    nameInput: 'memberName',
    nameInputs: [{ key: 'memberName', label: 'Member' }],
    askEmail: false,
    generated: [{ key: 'cardNumber', label: 'Card number' }],
    dailyLimit: 200,
    issuedToday: 3,
    limitReached: false,
    url: 'https://passbook.mobile/j/abc',
    ready: true,
    issues: [],
    revision: 1,
    createdAt: 1,
    rotatedAt: null,
  };

  it('parses a link, a null url and an empty state', () => {
    expect(JoinLinkSchema.parse(link)).toEqual(link);
    expect(JoinLinkSchema.parse({ ...link, url: null }).url).toBeNull();
    expect(
      JoinLinkStateSchema.parse({
        link: null,
        ready: false,
        issues: [{ code: 'barcode_input', input: 'cardNumber' }],
      }).issues,
    ).toEqual([{ code: 'barcode_input', input: 'cardNumber' }]);
    expect(JoinLinkSchema.safeParse({ ...link, mode: 'staging' }).success).toBe(false);
  });
});

describe('copy', () => {
  it('has a line for every readiness code, with its values filled', () => {
    for (const code of JoinReadinessCodeSchema.options) {
      const line = joinIssueLine({ code, input: 'cardNumber' }, { label: 'Card number' });
      expect(line, code).toMatch(/^[A-Z].*\.$/);
      expect(line, code).not.toMatch(/[{}]/);
    }
    expect(joinIssueLine({ code: 'no_release' }, { mode: 'Test' })).toBe(
      'Release this template in Test to turn on the join link.',
    );
  });

  it('keeps the words of the design', () => {
    expect(JOIN_COPY.refusal.expired).toBe('This link does not work.');
    expect(JOIN_COPY.refusal.turnstile).toBe('Verification failed. Try again.');
    expect(JOIN_COPY.rotateConfirm.confirm).toBe('Make new link');
  });
});

describe('platform settings', () => {
  it('has the four join keys with their defaults and bounds', () => {
    const d = PlatformSettingsSchema.parse({});
    expect([
      d['join.enabled'],
      d['join.orgDailyCap'],
      d['join.platformDailyCap'],
      d['join.unusedDays'],
    ]).toEqual([true, 1000, 20000, 30]);
    expect(PlatformSettingsSchema.safeParse({ 'join.orgDailyCap': 50001 }).success).toBe(false);
    expect(PlatformSettingsSchema.safeParse({ 'join.orgDailyCap': 0 }).success).toBe(false);
  });
});
