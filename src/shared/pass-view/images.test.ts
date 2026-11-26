import { describe, expect, it } from 'vitest';
import { safeImageUrl } from './images.ts';

describe('safeImageUrl', () => {
  it.each([
    ['/api/v1/templates/t/versions/v/assets/logo%402x.png', true],
    ['https://cdn.example/logo.png', true],
    ['data:image/png;base64,AAAA', true],
    ['blob:https://passbook.mobile/0b9f2c1e-5d4a-4c7b-9a3e-1f2d3c4b5a6e', true],
    ['//evil.example/logo.png', false],
    ['http://evil.example/logo.png', false],
    ['javascript:alert(1)', false],
    ['data:text/html;base64,AAAA', false],
  ])('%s → %s', (url, ok) => {
    expect(safeImageUrl(url)).toBe(ok);
  });
});
