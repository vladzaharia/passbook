import {
  createMemoryHistory,
  createRootRoute,
  createRouter,
  RouterProvider,
} from '@tanstack/react-router';
import { render, screen } from '@testing-library/react';
import { ScrollText, Ticket } from 'lucide-react';
import type { ReactNode } from 'react';
import { describe, expect, it } from 'vitest';
import { axe } from 'vitest-axe';
import '../lib/test-utils.tsx';
import { CountLink, MetaLink, RowLink } from './row-link.tsx';

function withRouter(node: ReactNode) {
  const root = createRootRoute({ component: () => <>{node}</> });
  const router = createRouter({ routeTree: root, history: createMemoryHistory() });
  return render(<RouterProvider router={router} />);
}

describe('RowLink, CountLink, MetaLink', () => {
  it('styles a row title as strong text that turns teal on hover', async () => {
    const { container } = withRouter(
      <ul>
        <li>
          <RowLink to="/admin/users/$userId" params={{ userId: 'u1' }}>
            Maya Chen
          </RowLink>
        </li>
        <li>
          <RowLink to="/admin/passes/$passId" params={{ passId: 'p1' }} inactive>
            Retired offer
          </RowLink>
        </li>
      </ul>,
    );
    const maya = await screen.findByRole('link', { name: 'Maya Chen' });
    expect(maya).toHaveAttribute('href', '/admin/users/u1');
    expect(maya.className).toContain('text-fg-strong');
    expect(maya.className).toContain('hover:text-accent-fg');
    expect(maya.className).not.toMatch(/(^|\s)text-accent-fg/);
    const voided = screen.getByRole('link', { name: 'Retired offer' });
    expect(voided.className).toContain('line-through');
    expect(voided.className).toContain('text-fg-muted');
    expect((await axe(container)).violations).toEqual([]);
  });

  it('links a count to its filtered list and leaves zero as text', async () => {
    withRouter(
      <dl>
        <dt>Table</dt>
        <dd>
          <CountLink
            count={1204}
            to="/admin/passes"
            search={{ q: 'maya@example.com' }}
            aria-label="1,204 passes held by maya@example.com"
          />
        </dd>
        <dt>Key value</dt>
        <dd>
          <CountLink count={1} noun={['pass', 'passes']} icon={Ticket} to="/admin/passes" />
        </dd>
        <dt>None</dt>
        <dd data-testid="zero">
          <CountLink count={0} noun={['pass', 'passes']} to="/admin/passes" />
        </dd>
      </dl>,
    );
    const many = await screen.findByRole('link', { name: '1,204 passes held by maya@example.com' });
    expect(many).toHaveTextContent('1,204');
    expect(many.getAttribute('href')).toContain('q=maya%40example.com');
    expect(many.className).toContain('text-accent-fg');
    const one = screen.getByRole('link', { name: '1 pass' });
    expect(one.querySelector('svg')).not.toBeNull();
    expect(screen.getByTestId('zero')).toHaveTextContent('None');
    expect(screen.getAllByRole('link')).toHaveLength(2);
  });

  it('renders a muted meta link with its icon', async () => {
    withRouter(
      <p>
        <MetaLink to="/admin/audit" icon={ScrollText}>
          Audit log
        </MetaLink>
      </p>,
    );
    const link = await screen.findByRole('link', { name: 'Audit log' });
    expect(link.className).toContain('text-fg-muted');
    expect(link.className).toContain('hover:underline');
    expect(link.querySelector('svg[aria-hidden]')).not.toBeNull();
  });
});
