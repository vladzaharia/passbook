import {
  createMemoryHistory,
  createRootRoute,
  createRouter,
  RouterProvider,
} from '@tanstack/react-router';
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import '../../../../lib/test-utils.tsx';
import {
  adminHref,
  type DesignerHost,
  DesignerHostProvider,
  type DesignerPlace,
} from '../host.tsx';
import { AdminLink } from './host.tsx';

const PLACES: DesignerPlace[] = [
  { to: 'template', templateId: 'tpl 1' },
  { to: 'channels', templateId: 'tpl 1' },
  { to: 'zones' },
];

describe("admin's designer links", () => {
  it('go where adminHref says, for every place', async () => {
    const host = { kind: 'admin', orgId: 'org1' } as DesignerHost;
    const root = createRootRoute({
      component: () => (
        <DesignerHostProvider host={host}>
          {PLACES.map((place) => (
            <AdminLink key={place.to} place={place}>
              {place.to}
            </AdminLink>
          ))}
        </DesignerHostProvider>
      ),
    });
    const router = createRouter({
      routeTree: root,
      history: createMemoryHistory({ initialEntries: ['/'] }),
    });
    render(<RouterProvider router={router} />);
    for (const place of PLACES)
      expect(await screen.findByRole('link', { name: place.to })).toHaveAttribute(
        'href',
        adminHref(place, 'org1'),
      );
  });
});
