import { Link } from '@tanstack/react-router';
import type { WalletReportsDto } from '@/shared/contracts/wallet-fidelity.ts';
import { typeLabel, WALLETS_COPY } from '@/shared/copy/wallets.ts';
import { Button } from '../ui/button.tsx';
import { WalletReport } from './wallet-report.tsx';
import { WalletTile } from './wallet-tile.tsx';

const TARGETS = ['google', 'samsung'] as const;

/** The import report's wallets: a tile per wallet, then its compact report and a way into the designer. */
export function ImportWallets({
  reports,
  templateId,
  orgId,
}: {
  reports: WalletReportsDto;
  templateId: string;
  orgId: string | undefined;
}) {
  return (
    <div className="wt-host @container flex flex-col gap-3">
      <div className="grid grid-cols-1 gap-3 @md:grid-cols-2">
        {TARGETS.map((target) => (
          <WalletTile
            key={target}
            target={target}
            meta={typeLabel(target, reports[target].type)}
            status={reports[target].status}
          />
        ))}
      </div>
      <div className="grid grid-cols-1 gap-3 @3xl:grid-cols-2 items-start">
        {TARGETS.map((target) => (
          <WalletReport
            key={target}
            report={reports[target]}
            host="import"
            footerAction={
              <Button asChild variant="outline" size="sm" className="self-start">
                <Link
                  to="/admin/templates/$templateId/design"
                  params={{ templateId }}
                  search={{ orgId, mode: 'wallets', wallet: target }}
                >
                  {WALLETS_COPY.report.editInDesigner}
                </Link>
              </Button>
            }
          />
        ))}
      </div>
    </div>
  );
}
