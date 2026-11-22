import { describe, expect, it } from 'vitest';
import { todoCount } from '@/shared/org-setup-checks.ts';
import { newOrgFacts, readyFacts, viewOf } from '@/shared/pass-setup-test-fixtures.ts';
import { changeCount, draftChecks, draftErrors, draftPatch, facts } from './draft.ts';

const ready = () => viewOf(readyFacts());
const fresh = () => viewOf(newOrgFacts());
const SHA = 'b'.repeat(64);

describe('draft patch', () => {
  it('is empty until something differs from the view', () => {
    expect(draftPatch(ready(), {})).toBeNull();
    expect(draftPatch(ready(), { name: 'Acme Fitness', buddy: false })).toBeNull();
    expect(draftPatch(ready(), { channels: { mobile: 'allowed' } })).toBeNull();
  });

  it('carries the revision and only the fields that changed', () => {
    const patch = draftPatch(ready(), {
      name: ' Acme Gym ',
      accent: '#112233',
      supportEmail: 'desk@acme.test',
      buddy: true,
      channels: { mobile: 'blocked' },
    });
    expect(patch).toEqual({
      expectedRevision: 'r1',
      brand: {
        name: 'Acme Gym',
        accent: '#112233',
        support: { email: 'desk@acme.test' },
        email: { buddy: true },
      },
      channels: { mobile: 'blocked' },
    });
    expect(changeCount(patch)).toBe(5);
  });

  it('sends the three colours as one change, or null when all are cleared', () => {
    const set = draftPatch(ready(), { background: '#000000' });
    expect(set?.brand?.passColors).toEqual({
      background: '#000000',
      foreground: '#ffffff',
      label: '#fbbf24',
    });
    const cleared = draftPatch(ready(), { background: '', foreground: '', label: '' });
    expect(cleared?.brand?.passColors).toBeNull();
    expect(changeCount(set)).toBe(1);
  });

  it('names a staged image by its sha and clears a slot with null', () => {
    const staged = { sha: SHA, w: 480, h: 150, url: 'blob:x' };
    const patch = draftPatch(ready(), { images: { logo: staged, icon: null } });
    expect(patch?.brand).toEqual({ logo: { sha: SHA }, icon: null });
  });

  it('keeps the web logo on the logo until another is chosen', () => {
    expect(draftPatch(ready(), { sameAsLogo: false })?.brand).toEqual({ webLogoSameAsLogo: false });
  });
});

describe('draft errors', () => {
  it('asks for all three colours, a hex accent and a name', () => {
    const errors = draftErrors(ready(), { background: '#12', accent: 'red', name: ' ' });
    expect(errors.background).toMatch(/6-digit hex/);
    expect(errors.accent).toMatch(/6-digit hex/);
    expect(errors.name).toBe('Required.');
    expect(draftErrors(ready(), { background: '' }).background).toMatch(/all three/);
    expect(draftErrors(ready(), {})).toEqual({});
  });
});

describe('draft facts and checks', () => {
  it('resolves the logo check as soon as a logo is staged', () => {
    const before = fresh();
    expect(before.checks.some((c) => c.code === 'BRAND_LOGO')).toBe(true);
    const after = draftChecks(
      before,
      { images: { logo: { sha: SHA, w: 480, h: 150, url: 'x' } } },
      0,
    );
    expect(after.some((c) => c.code === 'BRAND_LOGO')).toBe(false);
    expect(after.some((c) => c.code === 'BRAND_ICON')).toBe(true);
  });

  it('counts three to do for a new org and none once logo, icon and support are set', () => {
    const view = fresh();
    expect(todoCount(view.checks)).toBe(3);
    const staged = { sha: SHA, w: 114, h: 114, url: 'x' };
    const done = draftChecks(
      view,
      { images: { logo: staged, icon: staged }, supportEmail: 'help@acme.test' },
      0,
    );
    expect(todoCount(done)).toBe(0);
  });

  it('a blocked channel stops at the Organization level and an allowed one opens it again', () => {
    const view = ready();
    const blocked = facts(view, { channels: { mobile: 'blocked' } }).channels.mobile;
    expect(blocked.on).toBe(false);
    expect(blocked.allowed).toBe(false);
    expect(blocked.levels.find((l) => l.level === 'org')).toMatchObject({
      state: 'off',
      reason: 'blocked',
    });
    const nfc = facts(viewOf(readyFacts()), { channels: { nfc: 'allowed' } }).channels.nfc;
    expect(nfc.on).toBe(true);
  });

  it('flags NO_CHANNEL when the draft blocks every open channel', () => {
    const view = ready();
    const checks = draftChecks(
      view,
      { channels: { apple: 'blocked', mobile: 'blocked', nfc: 'blocked' } },
      0,
    );
    expect(checks.find((c) => c.code === 'NO_CHANNEL')?.level).toBe('error');
  });
});
