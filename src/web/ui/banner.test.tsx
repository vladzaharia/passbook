import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { Banner, type BannerTone } from './banner.tsx';

const TONES: [BannerTone, string][] = [
  ['offline', 'status'],
  ['read-only', 'status'],
  ['restricted', 'alert'],
  ['suspended', 'status'],
  ['test', 'status'],
  ['past-due', 'status'],
  ['grace', 'status'],
  ['reconnect', 'status'],
];

describe('Banner', () => {
  it.each(TONES)('%s: one line, an icon and the %s role', (tone, role) => {
    render(<Banner tone={tone}>Line</Banner>);
    const banner = screen.getByRole(role);
    expect(banner).toHaveAttribute('data-banner', tone);
    expect(banner.querySelector('svg')).not.toBeNull();
    expect(banner).toHaveTextContent('Line');
  });

  it('draws offline and suspended slate, not refused red', () => {
    for (const tone of ['offline', 'suspended'] as const) {
      const { unmount } = render(<Banner tone={tone}>Line</Banner>);
      expect(screen.getByRole('status')).toHaveAttribute('data-look', 'system');
      unmount();
    }
    render(<Banner tone="restricted">Line</Banner>);
    expect(screen.getByRole('alert')).toHaveAttribute('data-look', 'refused');
  });

  it('carries at most one action', () => {
    render(
      <Banner tone="grace" action={<a href="/x">Fix</a>}>
        Pay by Jan 20.
      </Banner>,
    );
    expect(screen.getAllByRole('link')).toHaveLength(1);
  });
});
