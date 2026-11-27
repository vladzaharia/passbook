import { render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { RunApp } from './run-app.tsx';

vi.mock('../data.ts', () => ({
  loadIndex: vi.fn(async () => ({ codes: [] })),
  loadFile: vi.fn(),
}));
vi.mock('../turnstile.ts', () => ({ verify: vi.fn() }));

afterEach(() => vi.unstubAllGlobals());

describe('RunApp without a ready sandbox', () => {
  it('sends an operation page to the console to make one', async () => {
    render(<RunApp session={{ kind: 'none', csrf: 'c', siteKey: 's' }} mode="op" />);
    expect(
      (await screen.findByRole('link', { name: 'Create sandbox' })).getAttribute('href'),
    ).toContain('console');
  });
});
