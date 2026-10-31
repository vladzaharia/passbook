import { screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { axe } from 'vitest-axe';
import { renderApp } from '../lib/test-utils.tsx';

describe('index route', () => {
  it('renders the portal home for a signed-in user without a11y violations', async () => {
    const { container } = await renderApp('/', { session: 'user' });
    expect(await screen.findByRole('heading', { name: 'My passes', level: 1 })).toBeInTheDocument();
    expect((await axe(container)).violations).toEqual([]);
  });
});
