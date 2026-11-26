import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { FidelityReportDto } from '@/shared/contracts/wallet-fidelity.ts';
import '../../lib/test-utils.tsx';
import { WalletReport, WalletReports } from './wallet-report.tsx';

const base = { schema: 1, compilerRevision: 2, type: 'generic' } as const;
const google: FidelityReportDto = {
  ...base,
  target: 'google',
  status: { kind: 'ready' },
  items: [],
};
const samsung: FidelityReportDto = {
  ...base,
  target: 'samsung',
  status: { kind: 'omissions', count: 1 },
  items: [
    {
      capability: 'barcode.format',
      path: 'barcode',
      support: 'omitted',
      severity: 'omission',
      group: 'holder',
      chosen: false,
      message: 'PDF417 is not supported.',
    },
  ],
};

describe('WalletReport', () => {
  it('shows each target status and its omissions', () => {
    render(<WalletReports reports={{ google, samsung }} />);
    expect(screen.getByText('Google Wallet: Ready')).toBeInTheDocument();
    expect(screen.getByText('Samsung Wallet: Ready with omissions (1)')).toBeInTheDocument();
    expect(screen.getByText('PDF417 is not supported.')).toBeInTheDocument();
    expect(screen.getByText('barcode')).toBeInTheDocument();
  });

  it('shows the reason a target is blocked', () => {
    render(
      <WalletReport
        label="Google Wallet"
        report={{ ...google, status: { kind: 'blocked', reason: 'No type fits.' } }}
      />,
    );
    expect(screen.getByText('Google Wallet: Blocked: No type fits.')).toBeInTheDocument();
  });
});
