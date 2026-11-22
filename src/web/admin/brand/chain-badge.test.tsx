import { render, screen } from '@testing-library/react';
import { expect, it } from 'vitest';
import type { ChannelLevel } from '@/shared/contracts/channels.ts';
import { ChainBadge } from './chain-badge.tsx';

const levels = [
  { level: 'platform', state: 'ok' },
  { level: 'plan', state: 'off' },
  { level: 'org', state: 'ok' },
  { level: 'template', state: 'ok' },
] as unknown as ChannelLevel[];

it('quiets the levels after the stopping one without opacity', () => {
  render(<ChainBadge levels={levels} />);
  const items = screen.getAllByRole('listitem');
  const after = items.slice(2).map((li) => li.querySelector('[data-level]') as HTMLElement);
  for (const pill of after) {
    expect(pill).toHaveAttribute('data-after');
    expect(pill.className).not.toMatch(/opacity/);
    expect(pill.className).toContain('text-fg-muted');
  }
  expect(items[0]?.querySelector('[data-level]')).not.toHaveAttribute('data-after');
  expect(document.body.innerHTML).not.toMatch(/opacity-45/);
});
