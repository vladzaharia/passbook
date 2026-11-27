import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { HOLDER_COPY } from '@/shared/copy/holder.ts';
import { announceSessionEnd } from '../lib/session-signal.ts';
import { json, problem, renderApp } from '../lib/test-utils.tsx';
import {
  fixtureOperation,
  HOLDER_LOST_PHONE,
  HOLDER_RESEND,
} from '../ui/operation/fixtures.test-support.ts';
import { cachedOperation, resetOperationCache, trackOperation } from '../ui/operation/store.ts';
import { passFixture } from './fixtures.ts';

afterEach(() => {
  sessionStorage.clear();
  vi.unstubAllGlobals();
  resetOperationCache();
  window.history.replaceState(null, '', '/');
});

const openMore = async (user: ReturnType<typeof userEvent.setup>, item: string) => {
  await user.click(await screen.findByRole('button', { name: /More/ }));
  await user.click(await screen.findByRole('menuitem', { name: item }));
};

describe('Send it again as an operation', () => {
  it('opens a sheet with the exact step, and ends with Done', async () => {
    const user = userEvent.setup();
    let status: 'running' | 'succeeded' = 'running';
    await renderApp('/passes/p1', {
      handlers: {
        '/api/v1/me/passes/p1': () => json(passFixture()),
        '/api/v1/me/passes/p1/resend': () => json({ ok: true, operationId: 'op-s1' }, 202),
        '/api/v1/operations/op-s1': () =>
          json(fixtureOperation(HOLDER_RESEND, { status, at: 'mail', id: 'op-s1' })),
      },
    });
    await openMore(user, HOLDER_COPY.sendAgain);
    const sheet = await screen.findByRole('dialog', { name: 'Email my pass' });
    expect(await within(sheet).findAllByText('Sending the email')).not.toHaveLength(0);
    expect(within(sheet).getByText('Check the pass')).toBeVisible();
    // The old toast claimed "Sent" before anything was: it is gone.
    expect(screen.queryByText(HOLDER_COPY.sendAgainSent)).toBeNull();
    status = 'succeeded';
    expect(
      await within(sheet).findAllByText('Email on its way', {}, { timeout: 4000 }),
    ).not.toHaveLength(0);
  });

  it('a failure offers Retry, which sends it again', async () => {
    const user = userEvent.setup();
    let posts = 0;
    await renderApp('/passes/p1', {
      handlers: {
        '/api/v1/me/passes/p1': () => json(passFixture()),
        '/api/v1/me/passes/p1/resend': () => {
          posts++;
          return json({ ok: true, operationId: posts === 1 ? 'op-s1' : 'op-s2' }, 202);
        },
        '/api/v1/operations/op-s1': () =>
          json({
            ...fixtureOperation(HOLDER_RESEND, {
              status: 'failed',
              at: 'mail',
              id: 'op-s1',
              error: 'Too many emails to this address. Try again in an hour.',
            }),
            target: { type: 'pass', id: 'p1' },
          }),
        '/api/v1/operations/op-s2': () =>
          json(fixtureOperation(HOLDER_RESEND, { status: 'running', at: 'mail', id: 'op-s2' })),
      },
    });
    await openMore(user, HOLDER_COPY.sendAgain);
    const sheet = await screen.findByRole('dialog', { name: 'Email my pass' });
    expect(
      await within(sheet).findByText('Too many emails to this address. Try again in an hour.'),
    ).toBeVisible();
    await user.click(within(sheet).getByRole('button', { name: 'Retry' }));
    expect(posts).toBe(2);
    expect(
      await within(await screen.findByRole('dialog')).findAllByText('Sending the email'),
    ).not.toHaveLength(0);
  });

  it('a second tap while one runs shows the running one, not an error', async () => {
    const user = userEvent.setup();
    await renderApp('/passes/p1', {
      handlers: {
        '/api/v1/me/passes/p1': () => json(passFixture()),
        '/api/v1/me/passes/p1/resend': () =>
          new Response(
            JSON.stringify({
              type: 'about:blank#OPERATION_RUNNING',
              title: 'OPERATION_RUNNING',
              status: 409,
              code: 'OPERATION_RUNNING',
              detail: 'This is already running.',
              operationId: 'op-s1',
            }),
            { status: 409, headers: { 'content-type': 'application/problem+json' } },
          ),
        '/api/v1/operations/op-s1': () =>
          json(fixtureOperation(HOLDER_RESEND, { status: 'running', at: 'mail', id: 'op-s1' })),
      },
    });
    await openMore(user, HOLDER_COPY.sendAgain);
    const sheet = await screen.findByRole('dialog', { name: 'Email my pass' });
    expect(await within(sheet).findAllByText('Sending the email')).not.toHaveLength(0);
    expect(screen.queryByText('This is already running.')).toBeNull();
  });
});

describe('I lost my phone as an operation', () => {
  it('shows the four steps in the sheet', async () => {
    const user = userEvent.setup();
    await renderApp('/passes/p1', {
      handlers: {
        '/api/v1/me/passes/p1': () => json(passFixture()),
        '/api/v1/me/passes/p1/lost-phone': () =>
          json({ transferId: 't1', state: 'completed', operationId: 'op-l1' }, 202),
        '/api/v1/operations/op-l1': () =>
          json(
            fixtureOperation(HOLDER_LOST_PHONE, { status: 'running', at: 'wallets', id: 'op-l1' }),
          ),
      },
    });
    await openMore(user, HOLDER_COPY.lostPhone);
    await user.click(
      within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Replace pass' }),
    );
    const sheet = await screen.findByRole('dialog', { name: 'Lost phone' });
    for (const label of [
      'Replace code and link',
      'Sign out other devices',
      'Update your wallets',
      'Email the new pass',
    ])
      expect(within(sheet).getByText(label)).toBeVisible();
    expect(screen.queryByText(HOLDER_COPY.lostPhoneDone)).toBeNull();
  });
});

describe('lost phone asks for a fresh email confirmation', () => {
  it('sends one link, and a second tap inside the minute only says to look in the inbox', async () => {
    sessionStorage.clear();
    const user = userEvent.setup();
    let links = 0;
    await renderApp('/passes/p1', {
      handlers: {
        '/api/v1/me/passes/p1': () => json(passFixture()),
        '/api/v1/me/passes/p1/lost-phone': () =>
          problem(409, 'EMAIL_CONFIRMATION_REQUIRED', 'Confirm by email first.'),
        '/api/v1/me/passes/p1/lost-phone/confirmation': () => {
          links++;
          return json({ ok: true }, 202);
        },
      },
    });
    for (let i = 0; i < 2; i++) {
      await openMore(user, HOLDER_COPY.lostPhone);
      await user.click(
        within(await screen.findByRole('alertdialog')).getByRole('button', {
          name: 'Replace pass',
        }),
      );
      await waitFor(() =>
        expect(screen.getAllByText(HOLDER_COPY.lostPhoneConfirm).length).toBeGreaterThan(0),
      );
    }
    expect(links).toBe(1);
  });

  it('sends the link when the session is not fresh, and says so', async () => {
    const user = userEvent.setup();
    const calls: string[] = [];
    await renderApp('/passes/p1', {
      handlers: {
        '/api/v1/me/passes/p1': () => json(passFixture()),
        '/api/v1/me/passes/p1/lost-phone': () => {
          calls.push('lost');
          return problem(409, 'EMAIL_CONFIRMATION_REQUIRED', 'Confirm by email first.');
        },
        '/api/v1/me/passes/p1/lost-phone/confirmation': () => {
          calls.push('confirmation');
          return json({ ok: true }, 202);
        },
      },
    });
    await openMore(user, HOLDER_COPY.lostPhone);
    await user.click(
      within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Replace pass' }),
    );
    expect((await screen.findAllByText(HOLDER_COPY.lostPhoneConfirm))[0]).toBeVisible();
    expect(calls).toEqual(['lost', 'confirmation']);
  });

  it('the link lands with the question open again, once', async () => {
    window.history.replaceState(null, '', '/passes/p1?lostPhone=p1');
    await renderApp('/passes/p1?lostPhone=p1', {
      handlers: { '/api/v1/me/passes/p1': () => json(passFixture()) },
    });
    expect(await screen.findByRole('alertdialog')).toBeVisible();
    expect(window.location.search).not.toContain('lostPhone');
  });
});

describe('a sheet restored from the URL still offers Retry', () => {
  it('a lost phone that failed after the code was replaced sends the pass again, not a second replacement', async () => {
    const user = userEvent.setup();
    const calls: string[] = [];
    window.history.replaceState(null, '', '/?op=op-l1');
    await renderApp('/', {
      handlers: {
        '/api/v1/me/passes': () => json({ items: [passFixture()], nextCursor: null }),
        '/api/v1/me/passes/p1/lost-phone': () => {
          calls.push('lost');
          return json({ transferId: 't', state: 'completed', operationId: 'op-x' }, 202);
        },
        '/api/v1/me/passes/p1/resend': () => {
          calls.push('resend');
          return json({ ok: true, operationId: 'op-x' }, 202);
        },
        '/api/v1/operations/op-x': () =>
          json(fixtureOperation(HOLDER_RESEND, { status: 'running', at: 'mail', id: 'op-x' })),
        '/api/v1/operations/op-l1': () =>
          json({
            ...fixtureOperation(HOLDER_LOST_PHONE, { status: 'failed', at: 'mail', id: 'op-l1' }),
            target: { type: 'pass', id: 'p1' },
          }),
      },
    });
    const sheet = await screen.findByRole('dialog', { name: 'Lost phone' });
    await user.click(await within(sheet).findByRole('button', { name: 'Retry' }));
    await waitFor(() => expect(calls).toEqual(['resend']));
    expect(await screen.findByRole('dialog', { name: 'Email my pass' })).toBeVisible();
    // One sheet only: the tray does not reopen the one that was restored.
    expect(screen.getAllByRole('dialog')).toHaveLength(1);
  });
});

describe('another tab', () => {
  it('a sign-out or account switch there empties this tab of the operations it held', async () => {
    // jsdom has no BroadcastChannel: a small bus between channels of one name stands in for the browser's.
    const channels = new Set<{ onmessage: (() => void) | null }>();
    class Bus {
      onmessage: (() => void) | null = null;
      constructor() {
        channels.add(this);
      }
      postMessage() {
        for (const other of channels) if (other !== this) other.onmessage?.();
      }
      close() {
        channels.delete(this);
      }
    }
    vi.stubGlobal('BroadcastChannel', Bus);
    await renderApp('/', {
      handlers: { '/api/v1/me/passes': () => json({ items: [passFixture()], nextCursor: null }) },
    });
    // The portal layout is lazy: wait until it has mounted and is listening.
    await screen.findByRole('button', { name: 'More actions' });
    trackOperation(fixtureOperation(HOLDER_RESEND, { status: 'running', at: 'mail', id: 'op-a' }));
    expect(cachedOperation('op-a')).toBeDefined();
    announceSessionEnd();
    await waitFor(() => expect(cachedOperation('op-a')).toBeUndefined());
  });
});
