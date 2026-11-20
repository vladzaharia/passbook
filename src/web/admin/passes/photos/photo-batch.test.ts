import { describe, expect, it } from 'vitest';
import { entriesOf, keyOf } from './photo-batch.ts';

const file = (name: string) => new File(['x'], name, { type: 'image/jpeg' });

describe('photo batch', () => {
  it('names the key from the file name without its extension', () => {
    expect(keyOf('M-100.jpg')).toBe('M-100');
    expect(keyOf('a.b.png')).toBe('a.b');
    expect(keyOf('plain')).toBe('plain');
  });
  it('refuses the second file with the same key', () => {
    const [first, second] = entriesOf([file('M-1.jpg'), file('M-1.png')]);
    expect(first?.state).toBe('matching');
    expect(second).toMatchObject({ state: 'failed', error: 'Another file has this name.' });
  });
});
