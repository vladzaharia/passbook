import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import type { TemplateReleaseState } from '@/shared/contracts/template-release-flow.ts';
import { ReleaseStrip } from './release-strip.tsx';

const name = (hash: string | null) => (hash ? `v${hash}` : '');
const base: TemplateReleaseState = {
  live: { version: '1', at: 1_700_000_000_000, by: 'Alex Kim' },
  test: { version: '1', at: 1_700_000_000_000, state: 'following' },
  draft: { version: '2', at: 1_700_000_100_000 },
  review: { state: 'none' },
  alone: true,
  next: 'release',
};

describe('ReleaseStrip', () => {
  it('shows Draft, Test and Live together', () => {
    render(
      <ReleaseStrip state={base} name={name} alt="try" onTry={() => {}} onRelease={() => {}} />,
    );
    const strip = screen.getByRole('region', { name: 'Release' });
    expect(strip).toHaveTextContent('Draftv2Saved');
    expect(strip).toHaveTextContent('Testv1Same as Live');
    expect(strip).toHaveTextContent('Livev1Since');
  });

  it('shows Test ahead of Live as Trying', () => {
    const ahead = { ...base, test: { version: '2', at: 1, state: 'ahead' as const } };
    render(
      <ReleaseStrip state={ahead} name={name} alt={null} onTry={() => {}} onRelease={() => {}} />,
    );
    expect(screen.getByRole('region', { name: 'Release' })).toHaveTextContent('Testv2Trying');
  });

  it('shows empty cells before any release and runs the alternative action', async () => {
    const onTry = vi.fn();
    const first = { ...base, live: null, test: null, next: 'try' as const };
    render(
      <ReleaseStrip state={first} name={name} alt="release" onTry={onTry} onRelease={vi.fn()} />,
    );
    expect(screen.getAllByText('Not released')).toHaveLength(2);
    expect(screen.getByRole('button', { name: 'Release' })).toBeInTheDocument();
    expect(onTry).not.toHaveBeenCalled();
  });

  it('offers Try as the alternative to Release', async () => {
    const onTry = vi.fn();
    render(<ReleaseStrip state={base} name={name} alt="try" onTry={onTry} onRelease={() => {}} />);
    await userEvent.click(screen.getByRole('button', { name: 'Try' }));
    expect(onTry).toHaveBeenCalledOnce();
  });
});
