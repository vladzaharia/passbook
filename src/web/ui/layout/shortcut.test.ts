import { describe, expect, it } from 'vitest';
import { shortcutHint } from './admin-layout.tsx';

describe('shortcutHint', () => {
  it('reads ⌘K on Apple platforms and Ctrl K elsewhere', () => {
    expect(shortcutHint('Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) Safari/605')).toBe('⌘K');
    expect(shortcutHint('Mozilla/5.0 (iPad; CPU OS 18_0 like Mac OS X) Safari/604')).toBe('⌘K');
    expect(shortcutHint('Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/130')).toBe('Ctrl K');
    expect(shortcutHint('Mozilla/5.0 (X11; Linux x86_64) Firefox/130')).toBe('Ctrl K');
  });
});
