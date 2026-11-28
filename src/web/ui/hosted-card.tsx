import type { ReactNode } from 'react';
import './art/scenes/common.css';
import './art/scenes/peek.css';
import './hosted-card.css';

export interface HostedCardProps {
  /** `main` on a page of its own (SSR); `div` inside the app shell. */
  as?: 'main' | 'div';
  /** A wider card (32 rem) for a page that shows a code. */
  wide?: boolean;
  /** Inside a page that already has a header (the console): no viewport-tall centring. */
  inline?: boolean;
  brand: ReactNode;
  /** The art seated on the card's top edge. */
  scene: ReactNode;
  /** Names the state on the card (`data-state`). */
  state: string;
  title: ReactNode;
  /** One short line under the title. */
  lede?: ReactNode;
  /** A callout above the body. */
  error?: ReactNode;
  /** Card body after the title: the one action. */
  children?: ReactNode;
  /** The line under the card body, split off by a divider. */
  footer?: ReactNode;
  /** After the card, inside the page column. */
  after?: ReactNode;
}

/**
 * The hosted card, one markup for the SPA's not-found and the worker's SSR pages
 * (worker/ssr/hosted.ts renders it to static markup): the band with the brand and the art, then
 * the card with its h1. Metrics: hosted-card.css, the same as /login.
 */
export function HostedCard({
  as: Root = 'div',
  wide,
  inline,
  brand,
  scene,
  state,
  title,
  lede,
  error,
  children,
  footer,
  after,
}: HostedCardProps) {
  return (
    <Root className={['hosted', wide && 'wide', inline && 'inline'].filter(Boolean).join(' ')}>
      <div className="band">
        <div className="brand">{brand}</div>
        <div className="scene" aria-hidden="true">
          {scene}
        </div>
      </div>
      <section className="card" data-state={state}>
        <div className="body">
          <div>
            <h1 tabIndex={Root === 'div' ? -1 : undefined}>{title}</h1>
            {lede ? <p className="lede">{lede}</p> : null}
          </div>
          {error}
          {children}
        </div>
        {footer}
      </section>
      {after}
    </Root>
  );
}
