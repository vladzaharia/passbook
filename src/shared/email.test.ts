import { describe, expect, it } from 'vitest';
import { maskEmail, normalizeEmail, strictEmail } from './email.ts';

describe('normalizeEmail', () => {
  it('trims, lower-cases and applies NFC', () => {
    expect(normalizeEmail('  Alex.Morgan+Gym@Example.COM ')).toBe('alex.morgan+gym@example.com');
    expect(normalizeEmail('é@example.com')).toBe('é@example.com');
  });
});

describe('strictEmail', () => {
  it('accepts bare addr-specs', () => {
    expect(strictEmail(' A@Example.com ')).toBe('a@example.com');
  });
  it.each([
    '',
    'a',
    'a@b',
    'Name <a@b.co>',
    '"a b"@example.com',
    'a@b.co, c@d.co',
    'a@@b.co',
    42,
    null,
  ])('rejects %j', (value) => {
    expect(strictEmail(value)).toBeNull();
  });
  it('enforces length limits', () => {
    expect(strictEmail(`${'a'.repeat(65)}@example.com`)).toBeNull();
    expect(strictEmail(`a@${'b'.repeat(250)}.com`)).toBeNull();
  });
});

describe('maskEmail', () => {
  it('keeps the first letter of the name and the host and the ending', () => {
    expect(maskEmail('anna@gmail.com')).toBe('a•••@g•••.com');
    expect(maskEmail(' Anna@Mail.Example.CO.uk ')).toBe('a•••@m•••.example.co.uk');
  });
  it('masks everything when there is no address to split', () => {
    expect(maskEmail('nope')).toBe('•••');
    expect(maskEmail('@x.co')).toBe('•••');
  });
});
