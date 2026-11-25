import { PAPER_COPY } from '../../shared/copy/print.ts';
import {
  BuddyCameo,
  CodeMark,
  Credit,
  Plate,
  sheetProps,
  type TicketProps,
  Typed,
} from './ticket-parts.tsx';
import { endsText, footMeta, paperAt, rangeText } from './ticket-text.ts';

/** Parking permit, half sheet, dashboard-facing: zone tile, plate, validity, code. No buddy: the dashboard face is the council's. */
export function TicketPermit({ p }: { p: TicketProps }) {
  const { content: c } = p;
  const zone = c.hero?.zone;
  const ends = endsText(c);
  const bay = c.facts.find((f) => f.label === 'Bay');
  const range = rangeText(c);
  const small = [c.terms, c.help.length ? `Questions: ${c.help.join(', ')}` : undefined]
    .filter(Boolean)
    .join(' ');
  return (
    <article {...sheetProps(p, 'pp-pm')}>
      <header className="pp-pm-band">
        <Plate p={p} style={{ width: 'calc(var(--mm) * 12)', height: 'calc(var(--mm) * 12)' }} />
        <span className="pp-pm-org">{c.brand}</span>
        <div className="pp-pm-kind">
          <div className="pp-pm-k">{[c.kicker, c.venue].filter(Boolean).join(' · ')}</div>
          {c.type ? <div className="pp-pm-t">{c.type}</div> : null}
        </div>
      </header>
      <div className={`pp-pm-main${zone ? '' : ' pp-pm-nozone'}`}>
        {zone ? (
          <div className="pp-pm-zone">
            <div className="pp-pm-k">ZONE</div>
            <div className="pp-pm-v">{zone}</div>
          </div>
        ) : null}
        <div className="pp-pm-mid">
          {c.hero?.plate ? (
            <div>
              <div className="pp-lbl">Vehicle</div>
              <div className="pp-pm-plate-no" style={{ marginTop: 'calc(var(--mm) * 1)' }}>
                {c.hero.plate}
              </div>
            </div>
          ) : null}
          {range ? (
            <div>
              <div className="pp-lbl">Valid</div>
              <div className="pp-pm-until">{range}</div>
            </div>
          ) : null}
          <div className="pp-pm-row">
            {bay ? (
              <div>
                <div className="pp-lbl">Bay</div>
                <div className="pp-pm-v">{bay.text}</div>
              </div>
            ) : null}
            {ends ? (
              <div>
                <div className="pp-lbl">Ends</div>
                <div className="pp-pm-v">{ends}</div>
              </div>
            ) : null}
          </div>
        </div>
        <div className="pp-pm-side">
          <CodeMark p={p} />
          <Typed p={p} />
        </div>
      </div>
      <footer className="pp-pm-foot">
        <div className="pp-pm-how">
          {PAPER_COPY.permitHow}
          {small ? <span>{small}</span> : null}
        </div>
        <div className="pp-pm-meta">
          <span>{[c.holder, footMeta(c, p.issued)].filter(Boolean).join(' · ')}</span>
          <Credit mark={p.mark} />
        </div>
      </footer>
    </article>
  );
}

const SCISSORS = (
  <svg
    className="pp-cp-scissors"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.6"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
  >
    <circle cx="6" cy="6" r="3" />
    <path d="M8.12 8.12 12 12" />
    <path d="M20 4 8.12 15.88" />
    <circle cx="6" cy="18" r="3" />
    <path d="M14.8 14.8 20 20" />
  </svg>
);

/** Coupon, half sheet: the offer large, the use-by date boxed, Code 128 by default for a till scanner. */
export function TicketCoupon({ p }: { p: TicketProps }) {
  const { content: c, assets } = p;
  const art = assets?.art && c.art && c.ink !== 'mono';
  const small = [c.terms, PAPER_COPY.reprints[1].split('. ')[0]].filter(Boolean).join('. ');
  return (
    <article {...sheetProps(p, 'pp-cp')}>
      <div className="pp-cp-cut" />
      {SCISSORS}
      <div className="pp-cp-inner">
        <header className="pp-cp-band">
          {art ? <img className="pp-cp-bg" src={assets.art} alt="" /> : null}
          <Plate p={p} style={{ width: 'calc(var(--mm) * 9)', height: 'calc(var(--mm) * 9)' }} />
          <div>
            <div className="pp-cp-org">{c.brand}</div>
            <div className="pp-cp-kind">{c.kicker}</div>
          </div>
        </header>
        <div className="pp-cp-body">
          <div className="pp-cp-offer">
            {c.hero?.offer ? <div className="pp-cp-v">{c.hero.offer}</div> : null}
            {c.hero?.offerNote ? <div className="pp-cp-s">{c.hero.offerNote}</div> : null}
            {c.validUntil ? (
              <div className="pp-cp-use">
                <span className="pp-lbl">Use by</span>
                {paperAt(c, c.validUntil, 'short')}
              </div>
            ) : null}
          </div>
          <div className="pp-cp-code">
            <CodeMark p={p} />
            <Typed p={p} />
          </div>
        </div>
        <footer className="pp-cp-bottom">
          <BuddyCameo p={p} />
          <p>{small}.</p>
          <div className="pp-cp-meta">
            {footMeta(c, p.issued)}
            <br />
            <Credit mark={p.mark} />
          </div>
        </footer>
      </div>
    </article>
  );
}
