import type { CSSProperties, ReactNode } from 'react';
import { PAPER_SPECS } from '../../passkit/template/paper.ts';
import { TestBand } from '../pass-card/test-band.tsx';
import { CardBack, CardFront } from './ticket-card.tsx';
import { TicketFull } from './ticket-full.tsx';
import type { TicketProps } from './ticket-parts.tsx';
import { TicketCoupon, TicketPermit } from './ticket-small.tsx';

export type { TicketProps } from './ticket-parts.tsx';

const pageWith = (
  key: string,
  size: { w: number; h: number },
  size_: string,
  children: ReactNode,
  band: boolean,
) => (
  <div
    key={key}
    className="pp-fit"
    data-size={size_}
    style={{ '--w': size.w, '--h': size.h } as CSSProperties}
  >
    {band ? <TestBand /> : null}
    {children}
  </div>
);

/**
 * One printed ticket: a drawn ticket (door panel with the code, holder panel with the pass colours)
 * on A4 or Letter with "before you go", a half sheet, or a card with its two faces. Server and
 * browser draw it from the same content, so the print page, the designer's preview and the channel
 * preview cannot drift. `code` is the print code; the page never gets the pass's own.
 */
export function PaperTicket(props: TicketProps) {
  const { design, content } = props;
  const pageOf = (...a: [string, { w: number; h: number }, string, ReactNode]) =>
    pageWith(...a, props.testBand === true);
  const spec = PAPER_SPECS[design.size];
  const size = { w: spec.widthMm, h: spec.heightMm };
  if (design.size === 'cr80')
    return (
      <>
        {pageOf('front', size, design.size, <CardFront p={props} />)}
        {pageOf('back', size, design.size, <CardBack p={props} />)}
      </>
    );
  const half = design.size === 'half';
  const small = content.kind === 'permit' || content.kind === 'coupon';
  if (small) {
    // A permit or coupon is a half-sheet design; on a full page it sits on the top half.
    const inner =
      content.kind === 'permit' ? <TicketPermit p={props} /> : <TicketCoupon p={props} />;
    if (half) return pageOf('sheet', size, design.size, inner);
    const top = {
      '--w': 210,
      '--h': 148,
      width: `${((210 / size.w) * 100).toFixed(3)}%`,
    } as CSSProperties;
    return pageOf(
      'sheet',
      size,
      design.size,
      <div className="pp-top-half" style={top}>
        {inner}
      </div>,
    );
  }
  return pageOf('sheet', size, design.size, <TicketFull p={props} half={half} />);
}
