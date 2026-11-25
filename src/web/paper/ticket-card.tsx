import { PAPER_COPY } from '../../shared/copy/print.ts';
import { CodeMark, Credit, Plate, sheetProps, type TicketProps, Typed } from './ticket-parts.tsx';
import { footMeta, paperAt } from './ticket-text.ts';

/** Front: the pass colour (white in mono), the member, the QR on a white tile. */
export function CardFront({ p }: { p: TicketProps }) {
  const { content: c, assets } = p;
  const member = c.kind === 'membership';
  const art = assets?.art && c.art && c.ink !== 'mono';
  const tier = member
    ? [c.type, c.venue]
    : [c.start ? paperAt(c, c.start, 'short') : undefined, c.venue, c.holder];
  return (
    <article {...sheetProps(p, 'pp-card pp-cd-front')} data-face="front">
      {art ? (
        <>
          <img className="pp-cd-bgart" src={assets.art} alt="" />
          <span className="pp-cd-shade" />
        </>
      ) : null}
      <div className="pp-cd-l">
        {c.logo && assets?.logo && c.ink !== 'mono' ? (
          <img className="pp-cd-logo" src={assets.logo} alt={c.brand} />
        ) : (
          <Plate p={p} style={{ width: 'calc(var(--mm) * 9)', height: 'calc(var(--mm) * 9)' }} />
        )}
        <span className="pp-cd-grow" />
        <span className="pp-cd-k">{member ? 'Member' : c.kicker}</span>
        <div className="pp-cd-name">{member ? (c.holder ?? c.title) : c.title}</div>
        <div className="pp-cd-tier">{tier.filter(Boolean).join(' · ')}</div>
      </div>
      <div className="pp-cd-tile">
        <CodeMark p={p} />
      </div>
    </article>
  );
}

/** Back: white. Logo, class word, the typed code, one line on what the card is, help, footer. */
export function CardBack({ p }: { p: TicketProps }) {
  const { content: c, assets } = p;
  const label = c.kind === 'membership' ? 'Membership card' : c.kicker;
  const [, line] = PAPER_COPY.oneTicket(c.noun, c.once);
  return (
    <article {...sheetProps(p, 'pp-card pp-cd-back')} data-face="back">
      <div className="pp-cd-in">
        <div className="pp-cd-row">
          {c.logo && assets?.logo && c.ink !== 'mono' ? (
            <img src={assets.logo} alt="" />
          ) : (
            <Plate p={p} style={{ width: 'calc(var(--mm) * 6)', height: 'calc(var(--mm) * 6)' }} />
          )}
          <span className="pp-cd-org">{label}</span>
        </div>
        <Typed p={p} />
        <p>{line}</p>
        <p>{PAPER_COPY.reprints[1]}</p>
        {c.help.length ? <p>{c.help.slice(0, 2).join(' · ')}</p> : null}
        <div className="pp-cd-meta">
          <span>{footMeta(c, p.issued)}</span>
          <Credit mark={p.mark} />
        </div>
      </div>
    </article>
  );
}
