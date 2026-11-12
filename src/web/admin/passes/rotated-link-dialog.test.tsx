import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { toast as sonner } from 'sonner';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AppProviders } from '../../lib/providers.tsx';
import { createQueryClient } from '../../lib/query-client.ts';
import { sessionQuery } from '../../lib/session.ts';
import { sessionFixture } from '../../lib/test-utils.tsx';
import { toast } from '../../ui/index.ts';
import { RotatedLinkDialog, RotateLink } from './rotated-link-dialog.tsx';

afterEach(() => {
  act(() => {
    sonner.dismiss();
  });
  vi.restoreAllMocks();
});

function sessionClient() {
  const client = createQueryClient();
  client.setQueryData(sessionQuery.queryKey, sessionFixture('admin'));
  return client;
}

describe('rotated link email', () => {
  it.each([
    ['live', 'Email queued to holder@example.com'],
    ['test', 'Test email queued. Check the Test inbox for capture.'],
  ] as const)('reports the %s request as queued, not delivered', async (mode, message) => {
    const user = userEvent.setup();
    const sendEmail = vi.fn().mockResolvedValue({ ok: true });
    const onClose = vi.fn();
    render(
      <AppProviders queryClient={sessionClient()}>
        <RotatedLinkDialog
          url="/p/new"
          holderEmail="holder@example.com"
          sendEmail={sendEmail}
          mode={mode}
          onClose={onClose}
        />
      </AppProviders>,
    );
    const dialog = screen.getByRole('dialog', { name: 'Link rotated' });
    await user.click(within(dialog).getByRole('button', { name: 'Email new link to holder' }));
    await waitFor(() => expect(sendEmail).toHaveBeenCalledOnce());
    expect(sendEmail).toHaveBeenCalledWith(expect.any(String));
    expect(await screen.findByText(message)).toBeInTheDocument();
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('keeps the new link available when the email request is not confirmed', async () => {
    const user = userEvent.setup();
    const sendEmail = vi.fn().mockRejectedValue(new Error('Network unavailable'));
    const onClose = vi.fn();
    render(
      <AppProviders queryClient={sessionClient()}>
        <RotatedLinkDialog
          url="/p/new"
          holderEmail="holder@example.com"
          sendEmail={sendEmail}
          mode="live"
          onClose={onClose}
        />
      </AppProviders>,
    );
    const dialog = screen.getByRole('dialog', { name: 'Link rotated' });
    await user.click(within(dialog).getByRole('button', { name: 'Email new link to holder' }));
    expect(
      await screen.findByText('Email status unknown. Check the Delivery tab before sending again.'),
    ).toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: 'Copy link' })).toBeInTheDocument();
    expect(onClose).not.toHaveBeenCalled();
  });

  it.each(['success', 'failure'] as const)(
    'does not notify or close for a new principal when an earlier email finishes with %s',
    async (outcome) => {
      const deferred = Promise as PromiseConstructor & {
        withResolvers<T>(): {
          promise: Promise<T>;
          resolve: (value: T) => void;
          reject: (reason: unknown) => void;
        };
      };
      const response = deferred.withResolvers<unknown>();
      const user = userEvent.setup();
      const sendEmail = vi.fn(() => response.promise);
      const onClose = vi.fn();
      const info = vi.spyOn(toast, 'info');
      const error = vi.spyOn(toast, 'error');
      const client = sessionClient();
      const next = sessionFixture('admin');
      if (!next.authenticated) throw new Error('Expected an authenticated fixture.');
      render(
        <AppProviders queryClient={client}>
          <RotatedLinkDialog
            url="/p/new"
            holderEmail="holder@example.com"
            sendEmail={sendEmail}
            mode="live"
            onClose={onClose}
          />
        </AppProviders>,
      );
      await user.click(screen.getByRole('button', { name: 'Email new link to holder' }));
      expect(sendEmail).toHaveBeenCalledOnce();
      act(() => {
        const updatedSession: typeof next = { ...next, user: { ...next.user, id: 'u2' } };
        client.setQueryData(sessionQuery.queryKey, updatedSession);
      });
      await act(async () => {
        if (outcome === 'success') response.resolve({ ok: true });
        else response.reject(new Error('Network unavailable'));
        await response.promise.catch(() => undefined);
      });
      expect(info).not.toHaveBeenCalled();
      expect(error).not.toHaveBeenCalled();
      expect(onClose).not.toHaveBeenCalled();
    },
  );
});

describe('rotating a link', () => {
  it('does not expose a link when the initiating principal changes before completion', async () => {
    const deferred = Promise as PromiseConstructor & {
      withResolvers<T>(): { promise: Promise<T>; resolve: (value: T) => void };
    };
    const response = deferred.withResolvers<string>();
    const client = sessionClient();
    const next = sessionFixture('admin');
    if (!next.authenticated) throw new Error('Expected an authenticated fixture.');
    render(
      <AppProviders queryClient={client}>
        <RotateLink
          open
          onOpenChange={() => {}}
          description="Rotate"
          rotate={() => response.promise}
          holderEmail={null}
          sendEmail={async () => ({ ok: true })}
        />
      </AppProviders>,
    );
    await userEvent.setup().click(screen.getByRole('button', { name: 'Rotate' }));
    act(() => {
      const updatedSession: typeof next = { ...next, user: { ...next.user, id: 'u2' } };
      client.setQueryData(sessionQuery.queryKey, updatedSession);
    });
    await act(async () => {
      response.resolve('/p/new');
      await response.promise;
    });
    expect(screen.queryByRole('dialog', { name: 'Link rotated' })).toBeNull();
  });
});
