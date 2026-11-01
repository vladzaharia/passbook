import { render, renderHook, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { generic, posterGeneric } from '@/shared/pass-view/fixtures/index.ts';
import '../lib/test-utils.tsx';
import { PassSideToggle, PassTargetToggle, usePassFacesDiffer } from './pass-toggles.tsx';

const json = (p: unknown) => p as Record<string, unknown>;

describe('pass toggles', () => {
  it('reads Front / Details, never Back', async () => {
    const onChange = vi.fn();
    render(<PassSideToggle value="front" onChange={onChange} />);
    expect(screen.getByRole('radiogroup', { name: 'Side' })).toBeInTheDocument();
    expect(screen.queryByText('Back')).toBeNull();
    await userEvent.setup().click(screen.getByRole('radio', { name: 'Details' }));
    expect(onChange).toHaveBeenCalledWith('back');
  });

  it('names both iOS targets', () => {
    render(<PassTargetToggle value="27" onChange={() => {}} />);
    expect(screen.getByRole('radio', { name: 'iOS 27' })).toBeChecked();
    expect(screen.getByRole('radio', { name: 'iOS 26 and earlier' })).toBeInTheDocument();
  });

  it('offers the target toggle only when the faces differ', () => {
    expect(renderHook(() => usePassFacesDiffer(json(generic))).result.current).toBe(false);
    expect(renderHook(() => usePassFacesDiffer(json(posterGeneric))).result.current).toBe(true);
    expect(renderHook(() => usePassFacesDiffer({ junk: 1 })).result.current).toBe(false);
  });
});
