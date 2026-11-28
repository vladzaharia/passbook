import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { ScanDeviceCapabilities } from '@/shared/contracts/scanning-sessions.ts';
import { SurfacePicker } from './surface-picker.tsx';

const caps = (posture: string) =>
  ({ native: { layout: { posture } } }) as unknown as ScanDeviceCapabilities;

describe('SurfacePicker Duo note', () => {
  it.each(['half-folded', 'unfolded'])('shows the note when %s', (posture) => {
    render(<SurfacePicker value="auto" onChange={() => {}} capabilities={caps(posture)} />);
    expect(screen.getByText('Customer display makes this Duo screen-only.')).toBeInTheDocument();
  });

  it('hides the note otherwise', () => {
    render(<SurfacePicker value="auto" onChange={() => {}} capabilities={caps('closed')} />);
    expect(screen.queryByText(/screen-only/)).toBeNull();
  });
});
