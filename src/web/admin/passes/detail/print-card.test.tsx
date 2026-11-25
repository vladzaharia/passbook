import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PassDetailDto } from '@/shared/contracts/passes.ts';
import { PRINT_COPY } from '@/shared/copy/print.ts';
import { json } from '@/web/lib/test-utils.tsx';
import { calls, renderTags } from '../../tags/test-fixtures.tsx';
import { PrintCard } from './print-card.tsx';

const pass = (over: Record<string, unknown> = {}) =>
  ({
    id: 'p1',
    orgId: 'o1',
    status: 'active',
    removedAt: null,
    ...over,
  }) as unknown as PassDetailDto;

const status = (on: boolean, reason?: string) => ({
  on,
  source: 'template',
  ...(reason ? { reason } : {}),
});
const channels = (paper: ReturnType<typeof status>) => () => {
  const on = { on: true, source: 'template' };
  return json({
    effective: { mobile: on, apple: on, google: on, samsung: on, nfc: on, paper },
    levels: Object.fromEntries(
      ['mobile', 'apple', 'google', 'samsung', 'paper', 'nfc'].map((c) => [c, []]),
    ),
    overrides: {},
    replace: { supported: true, owed: false, blocked: null, lastDigital: [], windows: [] },
  });
};
const print = (over: Record<string, unknown> = {}) => ({
  id: 'pr1',
  passId: 'p1',
  generation: 2,
  status: 'active',
  passVersion: 1,
  stale: false,
  createdAt: 1_800_000_000_000,
  voidedAt: null,
  voidCause: null,
  ...over,
});
const handlers = (paper: ReturnType<typeof status>, prints: unknown[]) => ({
  '/api/v1/passes/p1/channels': channels(paper),
  '/api/v1/passes/p1/prints/pr1/void': () => json(print({ status: 'voided', voidCause: 'manual' })),
  '/api/v1/passes/p1/prints': (_u: URL, init?: RequestInit) =>
    init?.method === 'POST'
      ? json({ ...print({ id: 'pr2' }), code: 'P'.padEnd(27, 'A') })
      : json({ prints }),
});

afterEach(() => vi.restoreAllMocks());

describe('Print card', () => {
  it('stays out of the way when paper is off and nothing was printed', async () => {
    const { container, fetchMock } = renderTags(
      <PrintCard pass={pass()} readOnly={false} />,
      handlers(status(false, 'template_off'), []),
    );
    await waitFor(() => expect(calls(fetchMock, 'GET', '/prints')).toHaveLength(1));
    await waitFor(() => expect(calls(fetchMock, 'GET', '/channels')).toHaveLength(1));
    expect(container.querySelector('h2')).toBeNull();
  });

  it('prints when paper is on: makes the print, opens the page, says so', async () => {
    const open = vi.spyOn(window, 'open').mockReturnValue(null);
    const user = userEvent.setup();
    const { fetchMock } = renderTags(
      <PrintCard pass={pass()} readOnly={false} />,
      handlers(status(true), []),
    );
    await user.click(await screen.findByRole('button', { name: PRINT_COPY.print }));
    await waitFor(() => expect(calls(fetchMock, 'POST', '/passes/p1/prints')).toHaveLength(1));
    expect(await screen.findByText(PRINT_COPY.made)).toBeInTheDocument();
    expect(open).toHaveBeenLastCalledWith(
      '/api/v1/passes/p1/print',
      '_blank',
      'noopener,noreferrer',
    );
  });

  it('opens the existing print without making another; reprint asks first', async () => {
    vi.spyOn(window, 'open').mockReturnValue(null);
    const user = userEvent.setup();
    const { fetchMock } = renderTags(
      <PrintCard pass={pass()} readOnly={false} />,
      handlers(status(true), [print()]),
    );
    expect(await screen.findByText(PRINT_COPY.printed(2))).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: PRINT_COPY.print }));
    expect(calls(fetchMock, 'POST', '/passes/p1/prints')).toHaveLength(0);

    await user.click(screen.getByRole('button', { name: PRINT_COPY.reprint }));
    expect(await screen.findByRole('alertdialog')).toHaveTextContent(
      PRINT_COPY.reprintConfirmTitle,
    );
    await user.click(screen.getByRole('button', { name: PRINT_COPY.reprint, hidden: false }));
    await waitFor(() => expect(calls(fetchMock, 'POST', '/passes/p1/prints')).toHaveLength(1));
  });

  it('says so when the pass changed since the print', async () => {
    renderTags(
      <PrintCard pass={pass()} readOnly={false} />,
      handlers(status(true), [print({ stale: true })]),
    );
    expect(await screen.findByText(PRINT_COPY.stale)).toBeInTheDocument();
  });

  it('asks to print again when the print ended with the pass', async () => {
    renderTags(
      <PrintCard pass={pass()} readOnly={false} />,
      handlers(status(true), [print({ status: 'voided', voidCause: 'pass_voided', voidedAt: 1 })]),
    );
    expect(await screen.findByText(PRINT_COPY.againNote)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: PRINT_COPY.again })).toBeInTheDocument();
  });

  it.each(['transfer', 'new_code'])('asks to print again after a %s void', async (cause) => {
    renderTags(
      <PrintCard pass={pass()} readOnly={false} />,
      handlers(status(true), [print({ status: 'voided', voidCause: cause, voidedAt: 1 })]),
    );
    expect(await screen.findByText(PRINT_COPY.againNote)).toBeInTheDocument();
  });

  it.each(['holder_change', 'manual'])('does not after a %s void', async (cause) => {
    renderTags(
      <PrintCard pass={pass()} readOnly={false} />,
      handlers(status(true), [print({ status: 'voided', voidCause: cause, voidedAt: 1 })]),
    );
    expect(await screen.findByText(PRINT_COPY.cardEmpty)).toBeInTheDocument();
    expect(screen.queryByText(PRINT_COPY.againNote)).toBeNull();
  });

  it('does not offer print again on a voided pass', async () => {
    renderTags(
      <PrintCard pass={pass({ status: 'voided' })} readOnly={false} />,
      handlers(status(true), [print({ status: 'voided', voidCause: 'pass_voided', voidedAt: 1 })]),
    );
    expect(await screen.findByText(PRINT_COPY.cardEmpty)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: PRINT_COPY.again })).toBeNull();
  });

  it('voids after a confirm and says so', async () => {
    const user = userEvent.setup();
    const { fetchMock } = renderTags(
      <PrintCard pass={pass()} readOnly={false} />,
      handlers(status(true), [print()]),
    );
    await user.click(await screen.findByRole('button', { name: PRINT_COPY.void }));
    expect(await screen.findByRole('alertdialog')).toHaveTextContent(PRINT_COPY.voidConfirmTitle);
    await user.click(
      screen.getAllByRole('button', { name: PRINT_COPY.void }).at(-1) as HTMLElement,
    );
    await waitFor(() => expect(calls(fetchMock, 'POST', '/prints/pr1/void')).toHaveLength(1));
    expect(await screen.findByText(PRINT_COPY.voided)).toBeInTheDocument();
  });

  it('offers no change when read-only', async () => {
    renderTags(<PrintCard pass={pass()} readOnly />, handlers(status(true), [print()]));
    expect(await screen.findByText(PRINT_COPY.printed(2))).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: PRINT_COPY.print })).toBeNull();
    expect(screen.queryByRole('button', { name: PRINT_COPY.void })).toBeNull();
  });

  it('disables Print and Reprint, keeps Void, when paper is off but a print exists', async () => {
    renderTags(
      <PrintCard pass={pass()} readOnly={false} />,
      handlers(status(false, 'printing_off'), [print()]),
    );
    expect(
      await screen.findByText('Paper: printing off for all organizations'),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: PRINT_COPY.print })).toBeDisabled();
    expect(screen.getByRole('button', { name: PRINT_COPY.reprint })).toBeDisabled();
    expect(screen.getByRole('button', { name: PRINT_COPY.void })).toBeEnabled();
  });
});
