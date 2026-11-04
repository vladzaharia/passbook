import '@testing-library/jest-dom/vitest';
import { render, screen, within } from '@testing-library/react';
import { renderToString } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { axe } from 'vitest-axe';
import { assets, eventTicket, seasonTicket } from '../../shared/pass-view/fixtures/index.ts';
import { normalize } from '../../shared/pass-view/index.ts';
import './sync-barcode.ts';
import { PassCard } from './index.tsx';

const now = new Date('2026-10-31T12:00:00Z');
const view = (p = seasonTicket) => normalize(p, { assets, now, timeZone: 'UTC' });

describe('upcoming events on the back', () => {
  it('lists date, name and venue, and passes axe', async () => {
    const { container } = render(<PassCard view={view()} face="back" />);
    const list = screen.getByRole('region', { name: 'Upcoming events' });
    expect(within(list).getAllByRole('listitem')).toHaveLength(3);
    const first = within(list).getAllByRole('listitem')[0] as HTMLElement;
    expect(first).toHaveTextContent('Opening night');
    expect(first).toHaveTextContent('Sat, 11:00 AM · Main Park');
    expect(first.querySelector('time')).toHaveAttribute('datetime', '2026-10-31T11:00:00-07:00');
    expect(first).toHaveTextContent('Now');
    expect(within(list).getAllByRole('listitem')[2]).toHaveTextContent('Date to be announced');
    expect((await axe(container)).violations).toEqual([]);
  });

  it('renders on the server with the same markup', () => {
    const html = renderToString(<PassCard view={view()} face="back" />);
    expect(html).toContain('pc-upcoming');
    expect(html).toContain('Encore');
  });

  it('leaves the back alone without events', () => {
    const { container } = render(<PassCard view={view(eventTicket)} face="back" />);
    expect(container.querySelector('.pc-upcoming')).toBeNull();
  });
});
