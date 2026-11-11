import { Fragment, type ReactNode } from 'react';
import { HOLDER_COPY } from '../../shared/copy/holder.ts';
import { NATIVE_WALLET_BADGES, type WalletChoice } from '../../shared/wallet-choice.ts';
import { OUTLINE_ACTION_CLASS } from './add/added.tsx';

/**
 * The one wallet choice, on the portal's pass page and on /p (static markup, plain links, no
 * script): the way that fits this device first, the others under Other ways, none hidden. Apple's
 * block is the page's own (QR, badge, buddy), passed in.
 */
export function WalletChoices({
  choices,
  apple,
}: {
  choices: readonly WalletChoice[];
  apple: ReactNode;
}) {
  const body = (choice: WalletChoice): ReactNode => {
    if (choice.id === 'apple') return apple;
    if (choice.id === 'browser') {
      return (
        <section className="wl-presentation" aria-label={HOLDER_COPY.browserTitle}>
          <h2>{HOLDER_COPY.browserTitle}</h2>
          <p>{HOLDER_COPY.browserLine}</p>
          <a className={OUTLINE_ACTION_CLASS} href={choice.href ?? undefined}>
            {HOLDER_COPY.showBarcode}
          </a>
        </section>
      );
    }
    const badge = NATIVE_WALLET_BADGES[choice.id];
    return (
      <div className="wl-native-wallets">
        <a href={choice.href ?? undefined}>
          <img src={badge.path} alt={badge.label} />
        </a>
      </div>
    );
  };
  const many = choices.length > 1;
  return (
    <>
      {choices.map((choice, index) => (
        <Fragment key={choice.id}>
          {many && labelAt(index) ? <p className="wl-choice-label">{labelAt(index)}</p> : null}
          {body(choice)}
        </Fragment>
      ))}
    </>
  );
}

const labelAt = (index: number): string | null =>
  index === 0 ? HOLDER_COPY.bestForDevice : index === 1 ? HOLDER_COPY.otherWays : null;
