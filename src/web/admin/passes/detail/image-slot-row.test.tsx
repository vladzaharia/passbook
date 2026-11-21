import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { ImageSlotRow } from './image-slot-row.tsx';

describe('ImageSlotRow', () => {
  it('puts the size text on its own line, not beside the buttons', () => {
    render(
      <ul>
        <ImageSlotRow
          label="Logo"
          thumb={{ url: null }}
          detail="@2x: 100 × 100 px"
          needs="needs up to 320 × 100 px (@2x)"
          onFile={() => {}}
          action="Replace"
        />
      </ul>,
    );
    const spec = screen.getByText(/@2x: 100 × 100 px/);
    expect(spec.parentElement).toHaveClass('basis-full');
    expect(screen.getByRole('button', { name: 'Replace Logo' }).closest('li')).toHaveClass(
      'flex-wrap',
    );
  });
});
