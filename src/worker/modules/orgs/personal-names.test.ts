import { describe, expect, it } from 'vitest';
import { personalOrgName, personalOrgSlug, viewerOrgName } from './personal-names.ts';

const id = '0191a2b3-c4d5-7e6f-8a9b-0c1d2e3f4a5b';

describe('personalOrgName', () => {
  it('prefers the user name', () => {
    expect(personalOrgName({ id, name: ' Ada Lovelace ', email: 'ada@x.test' })).toBe(
      'Ada Lovelace',
    );
  });
  it('falls back to the email local part, then to the id prefix', () => {
    expect(personalOrgName({ id, name: '  ', email: 'ada.l@x.test' })).toBe('ada.l');
    expect(personalOrgName({ id, name: null, email: null })).toBe('User 0191a2b3');
  });
  it('skips a name that is not plain text and caps at 120', () => {
    expect(personalOrgName({ id, name: 'a\nb', email: 'ok@x.test' })).toBe('ok');
    expect(personalOrgName({ id, name: 'n'.repeat(300), email: null })).toHaveLength(120);
  });
});

describe('personalOrgSlug', () => {
  it('slugifies to the CHECK shape', () => {
    expect(personalOrgSlug('Zoë  O’Neil--Smith!', id)).toBe('personal-zoe-o-neil-smith');
    expect(personalOrgSlug('ada.l', id)).toBe('personal-ada-l');
  });
  it('suffixes from the second attempt', () => {
    expect(personalOrgSlug('Ada', id, 1)).toBe('personal-ada');
    expect(personalOrgSlug('Ada', id, 3)).toBe('personal-ada-3');
  });
  it('ends in the user id on the last attempt, within the limit', () => {
    const slug = personalOrgSlug('a '.repeat(100), id, 8, true);
    expect(slug.length).toBeLessThanOrEqual(64);
    expect(slug.endsWith('0c1d2e3f4a5b')).toBe(true);
  });
  it('falls back to the id prefix when the body is empty', () => {
    expect(personalOrgSlug('日本語', id)).toBe('personal-0191a2b3');
  });
  it('stays within 64 characters with a suffix and no trailing hyphen', () => {
    const slug = personalOrgSlug('a '.repeat(100), id, 12);
    expect(slug.length).toBeLessThanOrEqual(64);
    expect(slug).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/);
  });
});

describe('viewerOrgName', () => {
  const org = { name: 'Ada Lovelace', personal_user_id: 'u1' };
  it('labels only the owner', () => {
    expect(viewerOrgName(org, 'u1')).toBe('Personal');
    expect(viewerOrgName(org, 'u2')).toBe('Ada Lovelace');
    expect(viewerOrgName({ name: 'Acme', personal_user_id: null }, 'u1')).toBe('Acme');
  });
});
