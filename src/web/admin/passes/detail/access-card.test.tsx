import { render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { axe } from 'vitest-axe';
import '../../../lib/test-utils.tsx';
import type { PassDetailDto } from '@/shared/contracts/passes.ts';
import { TooltipProvider } from '../../../ui/index.ts';
import { AccessCard } from './access-card.tsx';

vi.mock('../../scanning/zones-query.ts', () => ({
  useZones: () => ({
    isSuccess: true,
    data: {
      items: [
        { key: 'gym', name: 'Gym floor', effectiveTimeZone: 'America/Chicago' },
        { key: 'pool', name: 'Pool', effectiveTimeZone: 'America/Chicago' },
      ],
    },
  }),
}));

const manifest = {
  scan: {
    access: {
      input: { plan: 'plan', zones: 'zones' },
      plans: [
        {
          id: 'offpeak',
          label: 'Off-peak',
          kind: 'timed',
          hours: { mon: ['06:00-16:00'], sat: ['08:00-20:00'] },
          zones: [{ zone: 'gym' }],
        },
      ],
    },
  },
};
const pass = (personalization: Record<string, unknown>) =>
  ({ id: 'p1', personalization }) as unknown as PassDetailDto;
const view = (p: PassDetailDto, m: unknown = manifest) =>
  render(
    <TooltipProvider>
      <AccessCard pass={p} manifest={m} />
    </TooltipProvider>,
  );

describe('Access card', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
  });
  afterEach(() => vi.useRealTimers());

  it('shows plan, hours, zones and that the door is open now', () => {
    vi.setSystemTime(new Date('2026-11-16T16:00:00Z'));
    view(pass({ plan: 'offpeak', zones: ['pool'] }));
    expect(screen.getByRole('heading', { name: 'Access' })).toBeInTheDocument();
    expect(screen.getByText('Off-peak')).toBeInTheDocument();
    expect(screen.getByText('Mon 6 AM–4 PM · Sat 8 AM–8 PM')).toBeInTheDocument();
    expect(screen.getByRole('list', { name: 'Zones' })).toHaveTextContent('Gym floor');
    expect(screen.getByRole('list', { name: 'Zones' })).toHaveTextContent('Pool');
    expect(screen.getByText('Open now')).toBeInTheDocument();
  });

  it('says when it opens next', () => {
    vi.setSystemTime(new Date('2026-11-17T16:00:00Z'));
    view(pass({ plan: 'offpeak' }));
    expect(screen.getByText(/Opens Sat 8:00 AM/)).toBeInTheDocument();
  });

  it('flags a plan the template no longer has', () => {
    view(pass({ plan: 'retired' }));
    expect(screen.getByRole('alert')).toHaveTextContent('retired');
  });

  it('renders nothing for a template without access', () => {
    const { container } = view(pass({}), { scan: {} });
    expect(container).toBeEmptyDOMElement();
  });

  it('has no accessibility violations', async () => {
    vi.setSystemTime(new Date('2026-11-16T16:00:00Z'));
    const { container } = view(pass({ plan: 'offpeak', zones: ['pool'] }));
    expect((await axe(container)).violations).toEqual([]);
  });
});
