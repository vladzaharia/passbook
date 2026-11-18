import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { Capsule } from './capsule.tsx';

describe('Capsule', () => {
  it('says offline only in the offline state', () => {
    const { rerender } = render(<Capsule name="Front" state="scanning" />);
    expect(screen.queryByText('Scanning offline')).toBeNull();
    expect(screen.getByText('Scanning')).toBeInTheDocument();
    rerender(<Capsule name="Front" state="offline" />);
    expect(screen.getByText('Scanning offline')).toBeInTheDocument();
  });
});
