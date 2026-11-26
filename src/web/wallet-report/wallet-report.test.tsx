import { act, render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { FidelityReportDto } from '@/shared/contracts/wallet-fidelity.ts';
import '../lib/test-utils.tsx';
import { describeItem } from './describe.ts';
import { WalletReport } from './wallet-report.tsx';

type Item = FidelityReportDto['items'][number];
const item = (over: Partial<Item>): Item => ({
  capability: 'sharing',
  path: '',
  support: 'omitted',
  severity: 'omission',
  group: 'holder',
  chosen: false,
  message: 'Sharing is not restricted.',
  ...over,
});
const base = { schema: 1, compilerRevision: 2, type: 'loyalty' } as const;
const report = (over: Partial<FidelityReportDto>): FidelityReportDto => ({
  ...base,
  target: 'samsung',
  status: { kind: 'ready' },
  items: [],
  ...over,
});

describe('WalletReport', () => {
  it('says Everything shows when nothing is dropped', () => {
    render(<WalletReport report={report({ target: 'google' })} host="author" />);
    expect(screen.getByText('Ready')).toBeInTheDocument();
    expect(screen.getByText('Everything shows.')).toBeInTheDocument();
    expect(screen.getByText('Sample values. Each pass shows its own.')).toBeInTheDocument();
  });

  it('groups what is not shown, what looks different and what the wallet lacks, with counts', () => {
    const r = report({
      status: { kind: 'omissions', count: 2 },
      items: [
        item({}),
        item({ capability: 'nfc', group: 'door', message: 'No NFC.' }),
        item({
          capability: 'colors.label',
          support: 'difference',
          severity: 'difference',
          group: 'look',
          message: 'Label colour is picked.',
        }),
        item({
          capability: 'relevance.beacons',
          support: 'unsupported',
          group: 'absent',
          message: 'No beacons.',
        }),
      ],
    });
    render(<WalletReport report={r} host="author" />);
    expect(screen.getByText('Ready with omissions (2)')).toBeInTheDocument();
    expect(screen.getByText('Each is approved at release.')).toBeInTheDocument();
    const notShown = screen.getByRole('list', { name: 'Not shown' });
    expect(within(notShown).getAllByRole('listitem')).toHaveLength(2);
    expect(within(notShown).getByText('Holders notice')).toBeInTheDocument();
    expect(within(notShown).getByText('Staff at the door notice')).toBeInTheDocument();
    expect(
      within(screen.getByRole('list', { name: 'Shown differently' })).getByText('Label colour'),
    ).toBeInTheDocument();
    expect(
      within(screen.getByRole('list', { name: 'Not in Samsung Wallet' })).getByText('Beacons'),
    ).toBeInTheDocument();
  });

  it('shows the reason when blocked, with the fixes', () => {
    render(
      <WalletReport
        report={report({ status: { kind: 'blocked', reason: 'An event ticket needs a name.' } })}
        host="author"
        blockedActions={<button type="button">Go to Event name</button>}
      />,
    );
    expect(screen.getByText('Blocked')).toBeInTheDocument();
    expect(screen.getByText('Samsung Wallet cannot show this pass.')).toBeInTheDocument();
    expect(screen.getByText('An event ticket needs a name.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Go to Event name' })).toBeInTheDocument();
  });

  it('marks a choice, and shows the approval key and checkbox in the review host', () => {
    render(
      <WalletReport
        report={report({
          status: { kind: 'omissions', count: 1 },
          items: [item({ chosen: true, capability: 'field.back', path: 'backFields.terms' })],
        })}
        host="review"
        itemAction={() => <input type="checkbox" aria-label="Approve" />}
      />,
    );
    expect(screen.getByText('Left out by you')).toBeInTheDocument();
    expect(screen.getByText('field.back@backFields.terms')).toBeInTheDocument();
    expect(screen.getByRole('checkbox', { name: 'Approve' })).toBeInTheDocument();
    expect(screen.queryByText('Each is approved at release.')).toBeNull();
  });

  it('collapses long groups in the pane host and shows every row in the author host', () => {
    const items = Array.from({ length: 5 }, (_, i) =>
      item({ path: `backFields.f${i}`, capability: 'field.back', message: `Row ${i}` }),
    );
    const r = report({ status: { kind: 'omissions', count: 5 }, items });
    const { unmount } = render(<WalletReport report={r} host="pane" />);
    expect(screen.getAllByRole('listitem')).toHaveLength(3);
    expect(screen.getByRole('button', { name: 'Show 2 more' })).toBeInTheDocument();
    unmount();
    render(<WalletReport report={r} host="author" />);
    expect(screen.getAllByRole('listitem')).toHaveLength(5);
  });

  it('names a field by group and label, and a capability by its name', () => {
    expect(
      describeItem(
        { capability: 'field.back', path: 'backFields.terms' },
        { 'backFields.terms': 'Terms' },
      ),
    ).toBe('Back · Terms');
    expect(describeItem({ capability: 'colors.label', path: '' })).toBe('Label colour');
    expect(describeItem({ capability: 'nfc', path: '' })).toBe('NFC');
  });

  it('announces a status change politely, once edits settle', () => {
    vi.useFakeTimers();
    try {
      const { rerender } = render(<WalletReport report={report({})} host="author" />);
      const live = screen.getByRole('status');
      expect(live).toHaveAttribute('aria-live', 'polite');
      rerender(
        <WalletReport
          report={report({ status: { kind: 'omissions', count: 1 }, items: [item({})] })}
          host="author"
        />,
      );
      act(() => {
        vi.advanceTimersByTime(1000);
      });
      expect(live).toHaveTextContent('Samsung Wallet: Ready with omissions (1)');
    } finally {
      vi.useRealTimers();
    }
  });
});
