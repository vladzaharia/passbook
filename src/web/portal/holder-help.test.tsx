import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { axe } from 'vitest-axe';
import { HOLDER_COPY } from '@/shared/copy/holder.ts';
import type { DeviceInfo } from '@/shared/device.ts';
import { json, renderApp } from '../lib/test-utils.tsx';
import { passFixture } from './fixtures.ts';
import { HolderPassView, type HolderPassViewProps } from './holder-pass-view.tsx';

afterEach(() => vi.unstubAllGlobals());

const iphone: DeviceInfo = { device: 'iphone', inApp: false };
const android: DeviceInfo = { device: 'android', inApp: false };

const view = (over: Partial<HolderPassViewProps> = {}) =>
  render(
    <main>
      <h1>Membership</h1>
      <HolderPassView
        pass={<div role="img" aria-label="Pass card" />}
        passTitle="Membership"
        orgName="Gym"
        state="active"
        device={iphone}
        downloadHref="/p/t/pass.pkpass"
        walletOffers={[]}
        publicUrl="https://wallet.test/p/t"
        support={{ email: 'help@gym.test', url: null }}
        {...over}
      />
    </main>,
  );

describe('holder help copy', () => {
  it('explains Apple Wallet once, and a wallet generally on Android', () => {
    const first = view();
    expect(screen.getAllByText(HOLDER_COPY.walletApple)).toHaveLength(1);
    first.unmount();
    view({ device: android });
    expect(screen.getByText(HOLDER_COPY.walletGeneric)).toBeInTheDocument();
    expect(screen.queryByText(HOLDER_COPY.walletApple)).toBeNull();
  });

  it('matches the copy snapshot', () => {
    expect({
      apple: HOLDER_COPY.walletApple,
      generic: HOLDER_COPY.walletGeneric,
      again: [HOLDER_COPY.sendAgain, HOLDER_COPY.sendAgainSent, HOLDER_COPY.sendAgainWait],
      lost: [HOLDER_COPY.lostPhone, HOLDER_COPY.lostPhoneDone],
      ended: [HOLDER_COPY.voidedOn('3 November 2026'), HOLDER_COPY.expiredOn('3 November 2026')],
    }).toMatchInlineSnapshot(`
      {
        "again": [
          "Send it again",
          "Sent. Check your email.",
          "Sent a few already. Try again in an hour.",
        ],
        "apple": "Apple Wallet is the app on your iPhone that keeps cards and tickets.",
        "ended": [
          "This pass was voided on 3 November 2026.",
          "This pass expired on 3 November 2026.",
        ],
        "generic": "A wallet is the app on your phone that keeps cards and tickets.",
        "lost": [
          "I lost my phone",
          "Done. The old copies stop working. Check your email for the new pass.",
        ],
      }
    `);
  });
});

describe('the pass page', () => {
  it('posts Send it again to the pass link and says when it was sent', async () => {
    const { container } = view({ resend: { action: '/p/t/resend', again: 'sent' } });
    const button = screen.getByRole('button', { name: HOLDER_COPY.sendAgain });
    expect(button.closest('form')).toHaveAttribute('action', '/p/t/resend');
    expect(button.closest('form')).toHaveAttribute('method', 'post');
    expect(screen.getByRole('status')).toHaveTextContent(HOLDER_COPY.sendAgainSent);
    expect((await axe(container)).violations).toEqual([]);
  });

  it.each([
    ['voided', 'This pass was voided on 3 November 2026.'],
    ['expired', 'This pass expired on 3 November 2026.'],
  ] as const)('a %s pass shows the date and the org contact', async (state, line) => {
    const { container } = view({ state, endedOn: '3 November 2026' });
    const note = screen.getByRole('status');
    expect(note).toHaveTextContent(line);
    expect(within(note).getByRole('link', { name: 'Contact Gym' })).toHaveAttribute(
      'href',
      'mailto:help@gym.test',
    );
    expect(screen.queryByRole('button', { name: HOLDER_COPY.sendAgain })).toBeNull();
    expect((await axe(container)).violations).toEqual([]);
  });
});

describe('I lost my phone in the portal', () => {
  it('asks first, then replaces the pass', async () => {
    const user = userEvent.setup();
    const calls: string[] = [];
    await renderApp('/passes/p1', {
      handlers: {
        '/api/v1/me/passes/p1': () => json(passFixture()),
        '/api/v1/me/passes/p1/lost-phone': () => {
          calls.push('lost');
          return json({ transferId: 't1', state: 'completed' }, 202);
        },
        '/api/v1/me/passes/p1/resend': () => {
          calls.push('resend');
          return json({ ok: true }, 202);
        },
      },
    });
    await user.click(await screen.findByRole('button', { name: /More/ }));
    await user.click(await screen.findByRole('menuitem', { name: HOLDER_COPY.lostPhone }));
    expect(calls).toEqual([]);
    await user.click(
      within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Replace pass' }),
    );
    expect(await screen.findByText(HOLDER_COPY.lostPhoneDone)).toBeInTheDocument();
    expect(calls).toEqual(['lost']);
    await user.click(await screen.findByRole('button', { name: /More/ }));
    await user.click(await screen.findByRole('menuitem', { name: HOLDER_COPY.sendAgain }));
    expect(await screen.findByText(HOLDER_COPY.sendAgainSent)).toBeInTheDocument();
    expect(calls).toEqual(['lost', 'resend']);
  });
});
