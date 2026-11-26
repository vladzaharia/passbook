import { statusLabel } from '@/passkit/wallets/fidelity.ts';
import type { FidelityReportDto, WalletReportsDto } from '@/shared/contracts/wallet-fidelity.ts';
import { Callout, type CalloutTone } from '../../ui/index.ts';

const TARGETS = [
  ['google', 'Google Wallet'],
  ['samsung', 'Samsung Wallet'],
] as const;

const TONE: Record<FidelityReportDto['status']['kind'], CalloutTone> = {
  off: 'info',
  ready: 'success',
  omissions: 'warning',
  blocked: 'danger',
};

/**
 * One target's report: its status and what is dropped or blocked, each with the capability and
 * path. The import report and the Wallets tab render this from the same `FidelityReportDto`.
 */
export function WalletReport({ report, label }: { report: FidelityReportDto; label: string }) {
  const shown = report.items.filter((i) => i.severity !== 'difference');
  return (
    <Callout
      tone={TONE[report.status.kind]}
      title={`${label}: ${statusLabel(report.status)}`}
      items={shown.map((i) => (
        <>
          {i.message}
          {i.path ? <span className="ml-1.5 font-mono text-xs text-fg-muted">{i.path}</span> : null}
        </>
      ))}
    />
  );
}

/** Both targets of a version, in a fixed order. */
export function WalletReports({ reports }: { reports: WalletReportsDto }) {
  return (
    <div className="flex flex-col gap-3">
      {TARGETS.map(([target, label]) => (
        <WalletReport key={target} report={reports[target]} label={label} />
      ))}
    </div>
  );
}
