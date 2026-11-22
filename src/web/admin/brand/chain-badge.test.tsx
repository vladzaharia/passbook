import { render, screen } from '@testing-library/react';
import { expect, it } from 'vitest';
import type { ChannelLevel } from '@/shared/contracts/channels.ts';
import { ChainBadge } from './chain-badge.tsx';

const level = (l: ChannelLevel['level'], state: ChannelLevel['state']): ChannelLevel => ({
  level: l,
  state,
  canChange: false,
});

it('quiets the levels past the stop to an outline, not a faded colour', () => {
  render(
    <ChainBadge
      levels={[
        level('passbook', 'locked'),
        level('plan', 'ok'),
        level('org', 'ok'),
        level('template', 'ok'),
      ]}
    />,
  );
  const chain = screen.getByRole('list', { name: 'Chain' });
  const pills = [...chain.querySelectorAll<HTMLElement>('[data-level]')];
  expect(pills.map((p) => p.dataset.after)).toEqual([undefined, 'true', 'true', 'true']);
  for (const p of pills) expect(p.className).not.toMatch(/opacity-/);
});
