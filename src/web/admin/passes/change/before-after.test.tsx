import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { BeforeAfter } from './before-after.tsx';

describe('the before and after stage', () => {
  it('says a sample pass is loading while the preview is on its way', () => {
    render(<BeforeAfter preview={undefined} empty="Pick what changes to see a pass." waiting />);
    expect(screen.getByRole('status', { name: 'Loading a sample pass' })).toBeInTheDocument();
    expect(screen.queryByText('Pick what changes to see a pass.')).not.toBeInTheDocument();
  });

  it('asks for a change when none is picked yet', () => {
    render(
      <BeforeAfter preview={undefined} empty="Pick what changes to see a pass." waiting={false} />,
    );
    expect(screen.getByText('Pick what changes to see a pass.')).toBeInTheDocument();
  });
});
