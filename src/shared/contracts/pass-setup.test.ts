import { describe, expect, it } from 'vitest';
import { NOW, newOrgFacts, viewOf } from '../pass-setup-test-fixtures.ts';
import {
  BrandAssetSlotSchema,
  BrandPartSchema,
  PASS_SETUP_FIELDS,
  PassSetupFieldSchema,
  PassSetupImpactSchema,
  PassSetupPatchQuerySchema,
  PassSetupPatchSchema,
  PassSetupResultSchema,
  SETUP_FIX_ACTIONS,
  SetupCheckSchema,
  SetupFixActionSchema,
  StageBrandAssetSchema,
  StagedBrandAssetSchema,
} from './pass-setup.ts';

const SHA = 'b'.repeat(64);

describe('PassSetupPatchSchema', () => {
  it('takes every field, with null clearing', () => {
    const body = {
      expectedRevision: 'r1',
      brand: {
        name: 'Acme Fitness',
        logo: { sha: SHA },
        icon: null,
        webLogo: null,
        webLogoSameAsLogo: true,
        passColors: { background: '#0f172a', foreground: '#ffffff', label: '#fbbf24' },
        logoHasName: true,
        accent: null,
        mark: 'small',
        support: { email: 'help@acme.test', url: null },
        email: { fromName: null, buddy: true },
      },
      channels: { paper: 'blocked', google: 'allowed' },
    };
    expect(PassSetupPatchSchema.parse(body)).toEqual(body);
  });

  it('takes a channels-only body', () => {
    expect(
      PassSetupPatchSchema.safeParse({ expectedRevision: 'r1', channels: { nfc: 'blocked' } })
        .success,
    ).toBe(true);
  });

  it.each([
    ['no revision', { brand: { name: 'Acme' } }],
    ['an unknown key', { expectedRevision: 'r1', branding: {} }],
    ['an unknown brand key', { expectedRevision: 'r1', brand: { colour: '#000000' } }],
    ['a raw image', { expectedRevision: 'r1', brand: { logo: { sha: SHA, png: 'AA==' } } }],
    ['a bad sha', { expectedRevision: 'r1', brand: { logo: { sha: 'abc' } } }],
    ['a bad colour', { expectedRevision: 'r1', brand: { accent: 'blue' } }],
    ['a bad support email', { expectedRevision: 'r1', brand: { support: { email: 'nope' } } }],
    ['an http support link', { expectedRevision: 'r1', brand: { support: { url: 'http://a.b' } } }],
    ['a channel state', { expectedRevision: 'r1', channels: { apple: 'on' } }],
    ['an unknown channel', { expectedRevision: 'r1', channels: { fax: 'blocked' } }],
    ['a two-line name', { expectedRevision: 'r1', brand: { name: 'Acme\nFitness' } }],
  ])('refuses %s', (_name, body) => {
    expect(PassSetupPatchSchema.safeParse(body).success).toBe(false);
  });

  it('reads dryRun as the strings true and false', () => {
    expect(PassSetupPatchQuerySchema.parse({ dryRun: 'true' })).toEqual({ dryRun: 'true' });
    expect(PassSetupPatchQuerySchema.safeParse({ dryRun: '1' }).success).toBe(false);
  });
});

describe('PassSetupResultSchema', () => {
  it('carries the view after the change, the diff and the impact', () => {
    const result = {
      dryRun: true,
      view: viewOf(newOrgFacts(), NOW),
      diff: [
        {
          field: 'brand.passColors',
          before: null,
          after: { background: '#0f172a', foreground: '#ffffff', label: '#fbbf24' },
        },
        { field: 'channels.mobile', before: 'allowed', after: 'blocked' },
      ],
      impact: {
        passesToUpdate: 412,
        channelStops: [{ channel: 'mobile', templates: 3, passes: 412 }],
        enrolments: [],
      },
    };
    expect(PassSetupResultSchema.parse(result)).toEqual(result);
    expect(
      PassSetupImpactSchema.safeParse({ ...result.impact, enrolments: ['apple'] }).success,
    ).toBe(false);
  });

  it('names a diff field per brand value and per channel', () => {
    expect(PASS_SETUP_FIELDS).toHaveLength(19);
    expect(PassSetupFieldSchema.safeParse('channels.fax').success).toBe(false);
  });
});

describe('staged brand assets', () => {
  it('stages a logo, icon or web logo and answers with its sha and expiry', () => {
    expect(StageBrandAssetSchema.parse({ slot: 'webLogo', png: 'iVBORw0K' }).slot).toBe('webLogo');
    expect(StageBrandAssetSchema.safeParse({ slot: 'banner', png: 'iVBORw0K' }).success).toBe(
      false,
    );
    expect(StageBrandAssetSchema.safeParse({ slot: 'logo', png: 'not base64!' }).success).toBe(
      false,
    );
    expect(BrandAssetSlotSchema.options).toEqual(['logo', 'icon', 'webLogo']);
    const staged = { slot: 'logo', sha: SHA, version: SHA, w: 480, h: 150, expiresAt: NOW };
    expect(StagedBrandAssetSchema.parse(staged)).toEqual(staged);
  });
});

describe('checks', () => {
  it('every fix action and brand part is stable', () => {
    expect(SetupFixActionSchema.options).toEqual([...SETUP_FIX_ACTIONS]);
    expect(BrandPartSchema.options).toEqual(['colors', 'logo', 'icon']);
  });

  it('a check needs a fix', () => {
    const row = { code: 'BRAND_LOGO', level: 'warn', area: 'brand', message: 'No logo.' };
    expect(SetupCheckSchema.safeParse(row).success).toBe(false);
    expect(SetupCheckSchema.safeParse({ ...row, fix: { action: 'upload_logo' } }).success).toBe(
      true,
    );
  });
});
