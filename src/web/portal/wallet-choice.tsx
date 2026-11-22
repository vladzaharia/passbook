import { ChevronRight, LayoutGrid, Printer, ScanLine, Smartphone } from 'lucide-react';
import type { ReactNode } from 'react';
import { HOLDER_COPY } from '../../shared/copy/holder.ts';
import { NATIVE_WALLET_BADGES, type WalletChoice } from '../../shared/wallet-choice.ts';
import type { RenderBuddy } from './add/scan.tsx';

type NativeChoice = WalletChoice & { id: 'google' | 'samsung' };
const isNative = (c: WalletChoice): c is NativeChoice => c.id === 'google' || c.id === 'samsung';

/** Provider artwork, unmodified, at its own proportions. */
function NativeBadge({ choice }: { choice: NativeChoice }) {
  const badge = NATIVE_WALLET_BADGES[choice.id];
  return (
    <a className="wl-native-badge" href={choice.href ?? undefined}>
      <img src={badge.path} alt={badge.label} />
    </a>
  );
}

/**
 * The page's one lead, the way that fits this device (shared/wallet-choice.ts): Apple's add block
 * (passed in: QR, badge, buddy), a native wallet's badge, or the browser barcode, on one card the
 * buddy sits on; Print when paper is the only way. The same markup on the portal and /p (static, plain links, no script).
 */
export function WalletLead({
  choice,
  apple,
  buddy,
  printHref,
}: {
  choice: WalletChoice | undefined;
  apple: ReactNode;
  buddy: RenderBuddy;
  /** Paper only: Print leads. */
  printHref?: string | undefined;
}) {
  if (choice?.id === 'apple' && apple) return apple;
  // Apple without its block (no area) cannot lead: Print does, when it is there.
  const way = choice?.id === 'apple' ? undefined : choice;
  if (!way && !printHref) return null;
  return (
    <div className="wl-hero wl-hero-phone">
      {buddy({ size: 'sm', scene: 'nudge', at: 'end', className: 'wl-hero-buddy' })}
      {way && isNative(way) ? (
        <NativeBadge choice={way} />
      ) : way ? (
        <a className="wl-hero-action" href={way.href ?? undefined}>
          <ScanLine aria-hidden />
          {way.id === 'phone' ? HOLDER_COPY.saveToPhone : HOLDER_COPY.showBarcode}
        </a>
      ) : (
        <a className="wl-hero-action" href={printHref}>
          <Printer aria-hidden />
          {HOLDER_COPY.print}
        </a>
      )}
    </div>
  );
}

/** A quiet row that goes somewhere: icon, label, chevron. */
function OtherLink({ href, icon, label }: { href: string; icon: ReactNode; label: string }) {
  return (
    <a className="wl-other" href={href}>
      {icon}
      <span>{label}</span>
      <ChevronRight aria-hidden className="wl-other-go" />
    </a>
  );
}

interface Row {
  key: string;
  className?: string;
  body: ReactNode;
}

/**
 * Everything after the lead, as one quiet list with no visible label: the browser barcode, the
 * other wallets' badges side by side, Apple's line where it cannot add, print, My passes (/p, a
 * pass with a holder email), then the caller's row (Email me this pass again on /p).
 * walletChoices orders the wallets; nothing is hidden.
 */
export function OtherWays({
  choices,
  apple,
  printHref,
  portalHref,
  extra,
}: {
  choices: readonly WalletChoice[];
  apple: ReactNode;
  printHref?: string | undefined;
  portalHref?: string | undefined;
  extra?: ReactNode;
}) {
  const native = choices.filter(isNative);
  const rows: Row[] = [];
  for (const choice of choices) {
    if ((choice.id === 'browser' || choice.id === 'phone') && choice.href) {
      rows.push({
        key: choice.id,
        body: (
          <OtherLink
            href={choice.href}
            icon={<ScanLine aria-hidden />}
            label={choice.id === 'phone' ? HOLDER_COPY.saveToPhone : HOLDER_COPY.showBarcode}
          />
        ),
      });
    } else if (isNative(choice) && choice === native[0]) {
      rows.push({
        key: 'native',
        className: 'wl-other-badges',
        body: native.map((n) => <NativeBadge key={n.id} choice={n} />),
      });
    } else if (choice.id === 'apple' && apple) {
      rows.push({
        key: 'apple',
        className: 'wl-other-text',
        body: (
          <>
            <Smartphone aria-hidden />
            {apple}
          </>
        ),
      });
    }
  }
  if (printHref) {
    rows.push({
      key: 'print',
      body: <OtherLink href={printHref} icon={<Printer aria-hidden />} label={HOLDER_COPY.print} />,
    });
  }
  if (portalHref) {
    rows.push({
      key: 'portal',
      body: (
        <OtherLink
          href={portalHref}
          icon={<LayoutGrid aria-hidden />}
          label={HOLDER_COPY.myPassesRow}
        />
      ),
    });
  }
  if (extra) rows.push({ key: 'extra', body: extra });
  if (rows.length === 0) return null;
  return (
    <ul className="wl-others" aria-label={HOLDER_COPY.otherWays}>
      {rows.map((row) => (
        <li key={row.key} className={row.className}>
          {row.body}
        </li>
      ))}
    </ul>
  );
}
