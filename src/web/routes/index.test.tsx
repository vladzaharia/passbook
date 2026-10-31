import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { axe } from 'vitest-axe';
import { Route } from './index.tsx';

describe('index route', () => {
  it('renders the title and has no a11y violations', async () => {
    const Component = Route.options.component as () => React.JSX.Element;
    const { container } = render(<Component />);
    expect(screen.getByRole('heading', { name: 'Wallet' })).toBeInTheDocument();
    expect((await axe(container)).violations).toEqual([]);
  });
});
