import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TAG_COPY, TAG_ERROR_COPY } from '@/shared/copy/tags.ts';
import { json, problem } from '@/web/lib/test-utils.tsx';
import { AddTagDialog } from './add-tag-dialog.tsx';
import {
  AXE_MATRIX,
  axeAt,
  calls,
  enrollmentFixture,
  page,
  renderTags,
  scannerFixture,
  tagFixture,
} from './test-fixtures.tsx';

const target = { passId: 'p1', orgId: 'o1', holderName: 'Maya Okafor', hasAccount: true };
const dialog = (onOpenChange = vi.fn()) => (
  <AddTagDialog open onOpenChange={onOpenChange} target={target} />
);

afterEach(() => vi.restoreAllMocks());

/** Next stays blocked until the default scanner is picked. */
async function next(user: ReturnType<typeof userEvent.setup>) {
  const button = await screen.findByRole('button', { name: 'Next' });
  await waitFor(() => expect(button).not.toHaveAttribute('aria-disabled'));
  await user.click(button);
}

function handlers(poll: () => Response = () => json(enrollmentFixture())) {
  return {
    '/api/v1/nfc/scanners': () =>
      page([
        scannerFixture(),
        scannerFixture({ id: 's2', name: 'Lobby kiosk', unavailable: 'offline', online: false }),
        scannerFixture({ id: 's3', name: "Ana's iPhone", unavailable: 'no_tags' }),
      ]),
    '/api/v1/nfc/passes/p1/enrollments': () => json(enrollmentFixture(), 201),
    '/api/v1/nfc/passes/p1/enrollments/e1': (_u: URL, init?: RequestInit) =>
      init?.method === 'DELETE' ? json(enrollmentFixture({ state: 'cancelled' })) : poll(),
    '/api/v1/nfc/tags/t1': () => json(tagFixture({ label: null })),
    '/api/v1/nfc/bindings/b1': () => json(tagFixture({ binding: null, state: 'spare' })),
    '/api/v1/nfc/tags/t1/x': () => json({}),
  };
}

describe('Assign tag dialog', () => {
  it('offers Works with, defaulting to the person, and lists scanners with reasons', async () => {
    renderTags(dialog(), handlers());
    await screen.findByRole('dialog', { name: TAG_COPY.dialog.title });
    // Checked state lands a tick after the dialog under coverage; wait for it, not the node.
    await waitFor(() =>
      expect(screen.getByRole('radio', { name: /All of Maya Okafor's passes/ })).toBeChecked(),
    );
    expect(screen.getByRole('radio', { name: /This pass/ })).not.toBeChecked();
    expect(await screen.findByRole('radio', { name: /Front desk iPad/ })).toBeChecked();
    expect(screen.getByRole('radio', { name: /Lobby kiosk/ })).toBeDisabled();
    expect(screen.getByText(TAG_COPY.dialog.rowDisabled.noTags)).toBeInTheDocument();
  });

  it('closes the person choice when the holder has no account', async () => {
    renderTags(
      <AddTagDialog open onOpenChange={vi.fn()} target={{ ...target, hasAccount: false }} />,
      handlers(),
    );
    const person = await screen.findByRole('radio', { name: /All of Maya Okafor's passes/ });
    expect(person).toBeDisabled();
    expect(screen.getByText(TAG_COPY.noAccount)).toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole('radio', { name: /This pass/ })).toBeChecked());
  });

  it('sends the request, waits for the tap, then shows the result with Undo', async () => {
    const user = userEvent.setup();
    let reads = 0;
    const { fetchMock } = renderTags(dialog(), {
      ...handlers(() =>
        json(
          ++reads < 2
            ? enrollmentFixture()
            : enrollmentFixture({
                state: 'done',
                hint: '7F3A',
                binding: {
                  id: 'b1',
                  tagId: 't1',
                  scope: 'user',
                  passId: 'p1',
                  passTitle: null,
                  userId: 'u9',
                  holderName: 'Maya Okafor',
                  source: 'remote',
                  lent: false,
                  boundAt: 1,
                  boundByName: null,
                  scannerName: null,
                  endedAt: null,
                  endCause: null,
                },
              }),
        ),
      ),
    });
    await next(user);
    expect(await screen.findByText('Tap the tag on Front desk iPad')).toBeInTheDocument();
    expect(screen.getByText("Works with all of Maya Okafor's passes")).toBeInTheDocument();
    const body = JSON.parse(String(calls(fetchMock, 'POST', '/enrollments')[0]?.[1]?.body));
    expect(body).toEqual({ scannerId: 's1', binding: 'user' });
    expect(
      await screen.findByText(TAG_COPY.dialog.done, {}, { timeout: 4000 }),
    ).toBeInTheDocument();
    expect(screen.getByText('ends 7 F 3 A')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Undo' }));
    await waitFor(() => expect(calls(fetchMock, 'DELETE', '/bindings/b1')).toHaveLength(1));
    expect(
      await screen.findByRole('heading', { name: 'Choose how to assign' }),
    ).toBeInTheDocument();
  }, 10_000);

  it('cancels an open request when the dialog closes', async () => {
    const user = userEvent.setup();
    const onOpenChange = vi.fn();
    const { fetchMock } = renderTags(dialog(onOpenChange), handlers());
    await next(user);
    await screen.findByText('Tap the tag on Front desk iPad');
    await waitFor(() => expect(screen.getByRole('button', { name: 'Cancel' })).toBeEnabled());
    await user.keyboard('{Escape}');
    await waitFor(() => expect(calls(fetchMock, 'DELETE', '/enrollments/e1')).toHaveLength(1));
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it('says why a request ended and offers Send again', async () => {
    const user = userEvent.setup();
    const { fetchMock } = renderTags(dialog(), {
      ...handlers(() => json(enrollmentFixture({ state: 'expired' }))),
    });
    await next(user);
    expect(await screen.findByText("Front desk iPad didn't read a tag.")).toBeInTheDocument();
    expect(screen.getByText(TAG_COPY.dialog.timeout.sub)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: TAG_COPY.dialog.sendAgain }));
    await waitFor(() => expect(calls(fetchMock, 'POST', '/enrollments')).toHaveLength(2));
  });

  it('cancels the request when Back leaves the Tap step', async () => {
    const user = userEvent.setup();
    const { fetchMock } = renderTags(dialog(), handlers());
    await next(user);
    await screen.findByText('Tap the tag on Front desk iPad');
    await user.click(screen.getByRole('button', { name: 'Back' }));
    await waitFor(() => expect(calls(fetchMock, 'DELETE', '/enrollments/e1')).toHaveLength(1));
    expect(
      await screen.findByRole('heading', { name: 'Choose how to assign' }),
    ).toBeInTheDocument();
  });

  it('shows the tag error and keeps waiting', async () => {
    const user = userEvent.setup();
    renderTags(dialog(), {
      ...handlers(() => json(enrollmentFixture({ errorCode: 'TAG_LOST' }))),
    });
    await next(user);
    expect(await screen.findByText(TAG_ERROR_COPY.TAG_LOST)).toBeInTheDocument();
    expect(screen.getByText('Tap the tag on Front desk iPad')).toBeInTheDocument();
  });

  it('says the pass changed hands when completion is refused', async () => {
    const user = userEvent.setup();
    renderTags(dialog(), {
      ...handlers(() =>
        json(enrollmentFixture({ state: 'failed', errorCode: 'TAG_HOLDER_CHANGED' })),
      ),
    });
    await next(user);
    expect(await screen.findByText(TAG_ERROR_COPY.TAG_HOLDER_CHANGED)).toBeInTheDocument();
  });

  it('reports a voided pass', async () => {
    const user = userEvent.setup();
    renderTags(dialog(), {
      ...handlers(() => problem(404, 'PASS_NOT_FOUND', 'Pass not found.')),
    });
    await next(user);
    expect(await screen.findByText(TAG_COPY.dialog.voided)).toBeInTheDocument();
  });

  it('stops polling when it unmounts', async () => {
    const user = userEvent.setup();
    let reads = 0;
    const { fetchMock, unmount } = renderTags(dialog(), {
      ...handlers(() => {
        reads++;
        return json(enrollmentFixture());
      }),
    });
    await next(user);
    await waitFor(() => expect(reads).toBeGreaterThan(0));
    unmount();
    const seen = reads;
    await new Promise((r) => setTimeout(r, 1800));
    expect(reads).toBe(seen);
    expect(fetchMock).toBeDefined();
  }, 10_000);

  it("assigns a typed tag ID without a scanner, and shows the server's refusal on the field", async () => {
    const user = userEvent.setup();
    const onOpenChange = vi.fn();
    let refuse = true;
    const { fetchMock } = renderTags(dialog(onOpenChange), {
      ...handlers(),
      '/api/v1/nfc/passes/p1/tags/assign': () =>
        refuse
          ? problem(422, 'TAG_ID_INVALID', 'A tag ID has 4, 7 or 10 bytes.')
          : json(tagFixture()),
    });
    await user.click(await screen.findByRole('radio', { name: TAG_COPY.assignMenu.type }));
    const send = screen.getByRole('button', { name: TAG_COPY.dialog.assign });
    expect(send).toHaveAttribute('aria-disabled', 'true');
    await user.type(screen.getByRole('textbox', { name: TAG_COPY.type.field }), '04:A1');
    await user.click(send);
    expect(await screen.findByText('A tag ID has 4, 7 or 10 bytes.')).toBeInTheDocument();
    expect(onOpenChange).not.toHaveBeenCalled();
    refuse = false;
    await user.click(screen.getByRole('button', { name: TAG_COPY.dialog.assign }));
    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
    const last = calls(fetchMock, 'POST', '/tags/assign').at(-1);
    expect(JSON.parse(String(last?.[1]?.body))).toEqual({ id: '04:A1', binding: 'user' });
  });

  it('assigns a spare tag picked from the unassigned ones', async () => {
    const user = userEvent.setup();
    const onOpenChange = vi.fn();
    const { fetchMock } = renderTags(dialog(onOpenChange), {
      ...handlers(),
      '/api/v1/nfc/tags': () =>
        page([
          tagFixture({ id: 't9', label: 'Green fob', hint: '2C4D', binding: null, state: 'spare' }),
        ]),
      '/api/v1/nfc/passes/p1/tags/assign': () => json(tagFixture({ id: 't9' })),
    });
    await user.click(await screen.findByRole('radio', { name: TAG_COPY.assignMenu.spare }));
    const send = screen.getByRole('button', { name: TAG_COPY.dialog.assign });
    expect(send).toHaveAttribute('aria-disabled', 'true');
    await user.click(await screen.findByRole('radio', { name: /Green fob/ }));
    await user.click(send);
    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
    const list = calls(fetchMock, 'GET', '/nfc/tags')[0]?.[0];
    expect(String(list)).toContain('status=spare');
    expect(String(list)).toContain('passId=p1');
    expect(String(list)).toContain('binding=user');
    const last = calls(fetchMock, 'POST', '/tags/assign').at(-1);
    expect(JSON.parse(String(last?.[1]?.body))).toEqual({ tagId: 't9', binding: 'user' });
  });

  it('says so when no tag is spare', async () => {
    const user = userEvent.setup();
    renderTags(dialog(), { ...handlers(), '/api/v1/nfc/tags': () => page([]) });
    await user.click(await screen.findByRole('radio', { name: TAG_COPY.assignMenu.spare }));
    expect(await screen.findByText(TAG_COPY.spare.empty)).toBeInTheDocument();
  });

  it.each(AXE_MATRIX)('has no axe violations at %i, %s', async (width, theme) => {
    renderTags(dialog(), handlers());
    const el = await screen.findByRole('dialog');
    await screen.findByRole('radio', { name: /Front desk iPad/ });
    expect(await axeAt(el, width, theme)).toEqual([]);
  });
});
