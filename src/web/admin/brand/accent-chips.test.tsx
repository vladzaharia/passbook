import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ACCENT_PRESETS } from '@/shared/accent-presets.ts';
import { PRESETS } from '../blueprints/quick-fields.tsx';
import { toHex } from '../templates/designer/contrast.ts';
import { AccentChips } from './accent-chips.tsx';

afterEach(cleanup);

describe('AccentChips', () => {
  it('shows the nine presets and picks one by hex', async () => {
    const onPick = vi.fn();
    render(<AccentChips value="" onPick={onPick} />);
    expect(screen.getAllByRole('button')).toHaveLength(9);
    await userEvent.click(screen.getByRole('button', { name: 'Green' }));
    expect(onPick).toHaveBeenCalledWith('#15803d');
  });

  it('rings the preset that is the current accent, whatever its case', () => {
    render(<AccentChips value="#A21CAF" onPick={() => {}} />);
    expect(screen.getByRole('button', { name: 'Magenta' }).getAttribute('aria-pressed')).toBe(
      'true',
    );
    expect(screen.getByRole('button', { name: 'Teal' }).getAttribute('aria-pressed')).toBe('false');
  });

  it('is the same set the blueprint quick setup offers', () => {
    expect(PRESETS.map((p) => [p.name, toHex(p.rgb)])).toEqual(
      ACCENT_PRESETS.map((p) => [p.name, p.hex]),
    );
  });
});
