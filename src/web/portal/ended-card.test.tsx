import { render, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { axe } from 'vitest-axe';
import { HOLDER_COPY } from '@/shared/copy/holder.ts';
import { EndedCard } from './ended-card.tsx';

const signin = { action: '/p/t/sign-in', state: null } as const;
const help = { email: 'help@gym.test', url: null };

const card = (over: Partial<Parameters<typeof EndedCard>[0]> = {}) =>
  render(<EndedCard state="voided" orgName="Gym" endedOn="Nov 21" {...over} />);

describe('EndedCard', () => {
  it('voided with a contact: contact leads, email me my passes follows', async () => {
    const { container } = card({ support: help, signin });
    const note = screen.getByRole('status');
    expect(note).toHaveTextContent('This pass was voided on Nov 21.');
    const [first, second] = [...container.querySelectorAll('a, button')];
    expect(first).toHaveTextContent('Contact Gym');
    expect(first).toHaveAttribute('href', 'mailto:help@gym.test');
    expect(second).toHaveTextContent(HOLDER_COPY.emailMyPasses);
    expect(second?.closest('form')).toHaveAttribute('method', 'post');
    expect(second?.closest('form')).toHaveAttribute('action', '/p/t/sign-in');
    expect((await axe(container)).violations).toEqual([]);
  });

  it('voided without a contact: email me my passes alone', () => {
    card({ signin });
    expect(screen.queryByRole('link')).toBeNull();
    expect(screen.getByRole('button', { name: HOLDER_COPY.emailMyPasses })).toBeInTheDocument();
  });

  it('expired: the date, the contact, then email me my passes', () => {
    card({ state: 'expired', endedOn: 'Sep 30, 2025', support: help, signin });
    expect(screen.getByRole('status')).toHaveTextContent('This pass expired on Sep 30, 2025.');
    expect(screen.getByRole('link', { name: 'Contact Gym' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: HOLDER_COPY.emailMyPasses })).toBeInTheDocument();
  });

  it('removed: the org note and email only, no contact', () => {
    card({ state: 'removed', support: help, message: 'Season ended.', signin });
    const note = screen.getByRole('status');
    expect(note).toHaveTextContent('This pass was removed.');
    expect(note).toHaveTextContent('Season ended.');
    expect(within(note).queryByRole('link')).toBeNull();
    expect(screen.getByRole('button', { name: HOLDER_COPY.emailMyPasses })).toBeInTheDocument();
  });

  it('no contact and no email: asks the org for a new pass', () => {
    card();
    expect(screen.queryByRole('button')).toBeNull();
    expect(screen.getByRole('status')).toHaveTextContent('Ask Gym for a new pass.');
  });

  it('never offers the platform inbox', () => {
    card({ support: { ...help, platform: true } });
    expect(screen.queryByRole('link')).toBeNull();
  });

  it.each([
    ['sent', HOLDER_COPY.sendAgainSent],
    ['wait', HOLDER_COPY.sendAgainWait],
  ] as const)('answers ?signin=%s in place of the button', (state, line) => {
    card({ signin: { ...signin, state } });
    expect(screen.getByRole('status')).toHaveTextContent(line);
    expect(screen.queryByRole('button')).toBeNull();
  });
});
