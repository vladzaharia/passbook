import type { CSSProperties, ReactNode } from 'react';
import { PAPER_SPECS, type PaperDesign } from '../../passkit/template/paper.ts';
import type { PaperContent } from '../../passkit/template/paper-content.ts';
import type { BrandMark } from '../../shared/contracts/orgs.ts';
import { passbookCredit } from '../../shared/copy/passbook-credit.ts';
import { groupPrintCode, PAPER_COPY, PRINT_COPY } from '../../shared/copy/print.ts';
import { codeLabelOf } from '../../shared/copy/print-kinds.ts';
import type { PaperDrawing } from './drawing.ts';
import { buddyPose, TicketBuddy } from './ticket-buddy.tsx';
import { footMeta, type Issued } from './ticket-text.ts';
import { initialsOf } from './ticket-text-base.ts';

export interface TicketProps {
  content: PaperContent;
  design: PaperDesign;
  /** The print code; the page never gets the pass's own. */
  code: string;
  drawing: PaperDrawing | undefined;
  issued?: Issued | undefined;
  /** The org's footer choice (`orgBrandOf`). */
  mark: BrandMark;
  /** `test` adds the dashed outline, the strip and the watermark around the door panel. */
  mode?: 'live' | 'test' | undefined;
  /** A sandbox pass: the TEST PREVIEW band across the top of every page. */
  testBand?: boolean | undefined;
  /** URLs of the template's logo and the art slot `content.art` names. */
  assets?:
    | { logo?: string | undefined; art?: string | undefined; photo?: string | undefined }
    | undefined;
}

const LABEL = { qr: 'QR code', code128: 'Code 128 barcode' } as const;

export const codeLabel = (c: PaperContent): string =>
  codeLabelOf(c.kind, c.noun, Boolean(c.info.pack));

/** The code's size in mm: the symbol alone is `qrMm` (QR) or `barMm` (Code 128) wide. */
function codeStyle(design: PaperDesign, drawing: PaperDrawing): CSSProperties {
  const spec = PAPER_SPECS[design.size];
  const symbolMm = drawing.kind === 'qr' ? spec.qrMm : spec.barMm;
  const width = (symbolMm * drawing.whole) / drawing.symbol;
  const height = drawing.kind === 'qr' ? width : Math.max(13, symbolMm * 0.22);
  return {
    width: `calc(var(--mm) * ${width.toFixed(2)})`,
    height: `calc(var(--mm) * ${height.toFixed(2)})`,
  };
}

/** The symbol as vector paths, black on white with its quiet zone drawn in. */
export function CodeSvg({
  design,
  drawing,
  code,
  label,
}: {
  design: PaperDesign;
  drawing: PaperDrawing;
  code: string;
  label: string;
}) {
  const [x, y, w, h] = drawing.viewBox.split(' ');
  const spelled = groupPrintCode(code).replaceAll(' ', ', ');
  return (
    <svg
      className={drawing.kind === 'qr' ? 'pp-qr' : 'pp-bar'}
      viewBox={drawing.viewBox}
      style={codeStyle(design, drawing)}
      role="img"
      aria-label={`${LABEL[drawing.kind]}. ${label} ${spelled}`}
      preserveAspectRatio={drawing.kind === 'qr' ? 'xMidYMid meet' : 'none'}
      shapeRendering="crispEdges"
    >
      <rect x={x} y={y} width={w} height={h} fill="#fff" />
      {drawing.paths.map((path) => (
        <path
          key={path.d}
          d={path.d}
          {...(path.strokeWidth
            ? { fill: 'none', stroke: '#000', strokeWidth: path.strokeWidth }
            : { fill: '#000', ...(path.fillRule ? { fillRule: 'evenodd' as const } : {}) })}
        />
      ))}
    </svg>
  );
}

/** The symbol, or the notice that it cannot be drawn. */
export function CodeMark({ p }: { p: TicketProps }) {
  return p.drawing ? (
    <CodeSvg design={p.design} drawing={p.drawing} code={p.code} label={codeLabel(p.content)} />
  ) : (
    <p className="pp-missing" role="status">
      {PRINT_COPY.codeUnavailable}
    </p>
  );
}

/** "Ticket code" and the code in three groups: real text, so staff can read it out. */
export function Typed({ p }: { p: TicketProps }) {
  return (
    <div className="pp-typed">
      <span className="pp-lbl">{codeLabel(p.content)}</span>
      <span className="pp-mono">{groupPrintCode(p.code)}</span>
    </div>
  );
}

/** The org's logo on a plate in the pass colour (black in mono). Without a logo URL, its initial. */
export function Plate({ p, style }: { p: TicketProps; style?: CSSProperties }) {
  const { content: c, assets } = p;
  if (!c.logo) return null;
  const bg = c.ink === 'mono' ? '#000' : c.colors.bg;
  return (
    <span className="pp-plate" style={{ background: bg, ...style }}>
      {assets?.logo ? (
        <img src={assets.logo} alt="" />
      ) : (
        <svg viewBox="0 0 10 10" aria-hidden="true">
          <text
            x="5"
            y="7.7"
            textAnchor="middle"
            fontSize="7"
            fontWeight="700"
            fill={c.ink === 'mono' ? '#fff' : c.colors.fg}
          >
            {c.brand.slice(0, 1).toUpperCase()}
          </text>
        </svg>
      )}
    </span>
  );
}

/**
 * The holder's photo, cropped to a square from the upper middle (faces sit high); without one, the
 * holder's initials on the pass colour, so the badge never carries a stock silhouette.
 */
export function Photo({
  p,
  className = '',
  size,
}: {
  p: TicketProps;
  className?: string;
  size: number;
}) {
  const { content: c, assets } = p;
  const box = { width: `calc(var(--mm) * ${size})`, height: `calc(var(--mm) * ${size})` };
  return assets?.photo ? (
    <img className={`pp-photo ${className}`.trim()} src={assets.photo} alt="" style={box} />
  ) : (
    <span
      className={`pp-photo pp-initials ${className}`.trim()}
      style={{ ...box, fontSize: `calc(var(--mm) * ${size * 0.4})` }}
      aria-hidden="true"
    >
      {initialsOf(c.holder ?? c.title)}
    </span>
  );
}

/** The buddy cameo when the template turns it on and the class and size have a pose. */
export function BuddyCameo({ p }: { p: TicketProps }) {
  const { content: c, design } = p;
  const pose = design.buddy && design.size !== 'cr80' ? buddyPose(c.kind, c.noun) : null;
  return pose ? <TicketBuddy pose={pose} mono={c.ink === 'mono'} /> : null;
}

/** "Issued with PassBook" or "Powered by PassBook" by the org's footer choice; nothing at `none`. */
export function Credit({ mark }: { mark: BrandMark | undefined }) {
  const credit = passbookCredit(mark);
  return credit ? (
    <span className="pp-passbook">
      {credit.lead}
      {credit.name && (
        <>
          {' '}
          <b>{credit.name}</b>
        </>
      )}
    </span>
  ) : null;
}

/** Footer: print number and issue time, then "Issued with PassBook" with the optional buddy above. */
export function Foot({
  p,
  className = '',
  extra = '',
}: {
  p: TicketProps;
  className?: string;
  extra?: string;
}) {
  return (
    <div className={`pp-foot ${className}`.trim()}>
      <BuddyCameo p={p} />
      <span className="pp-meta">
        {[footMeta(p.content, p.issued), extra].filter(Boolean).join(' · ')}
      </span>
      <Credit mark={p.mark} />
    </div>
  );
}

/** Test prints: a hatched strip above the code, and the mark across everything but the door panel. */
export const TestStrip = () => <div className="pp-test-strip">{PAPER_COPY.testStrip}</div>;

export function Watermark() {
  return (
    <div className="pp-watermark" aria-hidden="true">
      {[0.2, 0.52, 0.84].map((t) => (
        <span key={t} style={{ top: `${t * 100}%` }}>
          {PAPER_COPY.testMark}
        </span>
      ))}
    </div>
  );
}

/** Wrapper classes and the colour variables every layout reads. */
export function sheetProps(p: TicketProps, extra: string, vars: CSSProperties = {}) {
  const { content: c, mode } = p;
  const cls = [
    'pp-sheet',
    'pp-page',
    `pp-${p.design.size}`,
    extra,
    c.ink === 'mono' ? 'pp-mono-ink' : '',
    mode === 'test' ? 'pp-test' : '',
  ]
    .filter(Boolean)
    .join(' ');
  const style = {
    '--org': c.colors.bg,
    '--org-fg': c.colors.fg,
    '--org-label': c.colors.label,
    ...vars,
  } as CSSProperties;
  return {
    className: cls,
    style,
    'aria-label': `${c.noun.charAt(0).toUpperCase()}${c.noun.slice(1)} for ${c.title}`,
    'data-kind': c.kind,
  } as const;
}

export const Rows = ({ rows }: { rows: { label: string; text: string }[] }): ReactNode =>
  rows.length ? (
    <div className="pp-door-rows">
      {rows.map((r) => (
        <div key={r.label}>
          <div className="pp-lbl">{r.label}</div>
          <div className="pp-v">{r.text}</div>
        </div>
      ))}
    </div>
  ) : null;
