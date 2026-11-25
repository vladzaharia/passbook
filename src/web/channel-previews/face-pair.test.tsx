import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FacePair } from './face-pair.tsx';

afterEach(cleanup);

const faces = { front: <p>card</p>, back: <p>details</p> };

describe('FacePair', () => {
  it('has both faces in the markup and a Front / Back toggle, front first', async () => {
    const { container } = render(<FacePair {...faces} />);
    await screen.findByRole('radio', { name: 'Front' });
    expect(screen.getByText('card')).toBeInTheDocument();
    expect(screen.getByText('details')).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: 'Front' })).toBeChecked();
    expect(container.querySelector('.fp')).toHaveAttribute('data-face', 'front');
  });

  it('flips on its own, and tells the page when it keeps the choice', async () => {
    const user = userEvent.setup();
    const onFace = vi.fn();
    const { container } = render(<FacePair {...faces} onFace={onFace} />);
    await user.click(await screen.findByRole('radio', { name: 'Back' }));
    expect(container.querySelector('.fp')).toHaveAttribute('data-face', 'back');
    expect(onFace).toHaveBeenCalledWith('back');
  });

  it('follows the page when it controls the face', async () => {
    const { container } = render(<FacePair {...faces} face="back" />);
    await screen.findByRole('radio', { name: 'Back' });
    expect(container.querySelector('.fp')).toHaveAttribute('data-face', 'back');
    expect(screen.getByRole('radio', { name: 'Back' })).toBeChecked();
  });
});
