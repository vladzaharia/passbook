import { describe, expect, it } from 'vitest';
import { normalizeEmail, strictEmail } from './email.ts';

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
