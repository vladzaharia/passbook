/**
 * The hosted card as static markup: the app's own HostedCard (web/ui/hosted-card.tsx, also the
 * SPA's not-found) with this page's already-escaped HTML swapped in for each slot, so the markup
 * is one definition and the escaping stays the caller's.
 */
import { renderToStaticMarkup } from 'react-dom/server';
import { HostedCard } from '../../web/ui/hosted-card.tsx';

export interface HostedCardSlots {
  wide?: boolean;
  state: string;
  title: string;
  brand: string;
  scene: string;
  lede?: string;
  error?: string;
  body: string;
  footer?: string;
  after: string;
}

type Slot = 'title' | 'brand' | 'scene' | 'lede' | 'error' | 'body' | 'footer' | 'after';

const OPEN = String.fromCharCode(0xe000);
const CLOSE = String.fromCharCode(0xe001);
const mark = (slot: Slot) => `${OPEN}${slot}${CLOSE}`;

export function hostedCardHtml(s: HostedCardSlots): string {
  const has = (slot: Slot) => (s[slot] ? mark(slot) : undefined);
  return renderToStaticMarkup(
    <HostedCard
      as="main"
      wide={s.wide}
      state={s.state}
      brand={mark('brand')}
      scene={mark('scene')}
      title={mark('title')}
      lede={has('lede')}
      error={has('error')}
      footer={has('footer')}
      after={mark('after')}
    >
      {mark('body')}
    </HostedCard>,
  ).replace(new RegExp(`${OPEN}(\\w+)${CLOSE}`, 'g'), (_m, slot: Slot) => s[slot] ?? '');
}
