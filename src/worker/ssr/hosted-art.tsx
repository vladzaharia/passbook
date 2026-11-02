/**
 * The auth pages' art: the kit wallet plus each state's extra parts, rendered static. Their
 * motion is CSS on load (hosted-art.css, after ART_CSS); only these pages use these states, so
 * none of it ships in the app bundle.
 */
import { renderToStaticMarkup } from 'react-dom/server';
import { TornArt } from '../../web/ui/art/torn.tsx';
import { UnpluggedArt } from '../../web/ui/art/unplugged.tsx';
import { WalletArt, type WalletState } from '../../web/ui/art/wallet.tsx';
import css from './hosted-art.css?raw';

export const HOSTED_ART_CSS = css;

/** The mascot's states, a tired mascot (flat eyes) for rate limits, or an error art. */
export type HostedArt = WalletState | 'tired' | 'torn' | 'unplugged';

const CHECK = <path data-part="ck" className="ck" d="M43.5 20l3 3 6-6.5" />;

const LOCK = (
  <g data-part="lk">
    <path data-part="sh" className="m" d="M44 16v-3.5a4 4 0 0 1 8 0V16" />
    <rect className="o m" x="40.5" y="15.5" width="15" height="11" rx="2.5" />
    <circle className="e" cx="48" cy="20.5" r="1.4" />
  </g>
);

/** A keyhole right of the clasp; the key slides in along its shaft, then turns. */
const KEY = (
  <>
    <circle className="e" cx="67" cy="46.5" r="1.7" />
    <rect className="e" x="66.25" y="46.5" width="1.5" height="4" rx=".75" />
    <g data-part="key">
      <g data-part="kt">
        <path className="m" d="M68 48h8M70.5 48v2.6M73 48v1.8" />
        <circle className="o m" cx="79.8" cy="48" r="3.8" />
      </g>
    </g>
  </>
);

export function artHtml(art: HostedArt): string {
  const size = 'xl' as const;
  if (art === 'torn') return renderToStaticMarkup(<TornArt size={size} beat={false} />);
  if (art === 'unplugged') return renderToStaticMarkup(<UnpluggedArt size={size} beat={false} />);
  const state = art === 'tired' ? 'login' : art;
  return renderToStaticMarkup(
    <WalletArt
      state={state}
      size={size}
      beat={false}
      {...(art === 'tired' ? { mood: 'flat' as const } : {})}
      onCard={art === 'confirm' ? CHECK : art === 'no-access' ? LOCK : undefined}
      front={art === 'break-glass' ? KEY : undefined}
    />,
  );
}
