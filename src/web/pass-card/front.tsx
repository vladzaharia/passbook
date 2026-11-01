import type { LayoutView, PassView } from '../../shared/pass-view/index.ts';
import { BarcodeSvg } from './barcode.tsx';
import { Field, FieldRow, Img, LogoLine, TransitGlyph } from './parts.tsx';

interface Props {
  view: PassView;
  layout: LayoutView;
}

function Top({ view, layout }: Props) {
  return (
    <div className="pc-top">
      <LogoLine view={view} poster={layout.poster} />
      <FieldRow fields={layout.header} className="pc-header" />
    </div>
  );
}

function Rows({ layout }: { layout: LayoutView }) {
  return (
    <>
      <FieldRow fields={layout.secondary} />
      {layout.auxiliary.map((row) => (
        <FieldRow key={row.map((f) => f.key).join()} fields={row} />
      ))}
    </>
  );
}

function Code({ layout }: { layout: LayoutView }) {
  return layout.barcode ? (
    <div className="pc-code">
      <BarcodeSvg barcode={layout.barcode} />
    </div>
  ) : null;
}

function Generic({ view, layout }: Props) {
  return (
    <>
      <Top view={view} layout={layout} />
      <div className="pc-main">
        <FieldRow fields={layout.primary} className="pc-primary" />
        <Img image={view.images.thumbnail} className="pc-thumb" />
      </div>
      <Rows layout={layout} />
      <Code layout={layout} />
    </>
  );
}

function Strip({ view, layout }: Props) {
  return (
    <div className="pc-strip" data-has-image={Boolean(view.images.strip) || undefined}>
      <Img image={view.images.strip} className="pc-strip-img" />
      <FieldRow fields={layout.primary} className="pc-primary" />
    </div>
  );
}

function StripCard({ view, layout }: Props) {
  return (
    <>
      <Top view={view} layout={layout} />
      <Strip view={view} layout={layout} />
      <Rows layout={layout} />
      <Code layout={layout} />
    </>
  );
}

function EventTicket({ view, layout }: Props) {
  const blurred = view.images.background && view.images.thumbnail && !view.images.strip;
  return (
    <>
      {blurred ? <Img image={view.images.background} className="pc-bg-blur" /> : null}
      <Top view={view} layout={layout} />
      {blurred ? (
        <div className="pc-main">
          <FieldRow fields={layout.primary} className="pc-primary" />
          <Img image={view.images.thumbnail} className="pc-thumb" />
        </div>
      ) : (
        <Strip view={view} layout={layout} />
      )}
      <Rows layout={layout} />
      <Code layout={layout} />
    </>
  );
}

function BoardingPass({ view, layout }: Props) {
  const [from, to] = layout.primary;
  return (
    <>
      <Top view={view} layout={layout} />
      <div className="pc-route">
        {from ? <Field field={from} big /> : <span />}
        {layout.transit ? <TransitGlyph transit={layout.transit} /> : <span />}
        {to ? <Field field={to} big /> : <span />}
      </div>
      {layout.auxiliary.map((row) => (
        <FieldRow key={row.map((f) => f.key).join()} fields={row} />
      ))}
      <FieldRow fields={layout.secondary} />
      <Img image={view.images.footer} className="pc-footer-img" />
      <Code layout={layout} />
    </>
  );
}

/** Apple's poster: art bleeds over the whole card; the lower area is a darkened blur of it. */
function Poster({ view, layout }: Props) {
  const [title, ...rest] = layout.primary;
  const heading = title && !title.label ? title : undefined;
  const fields = heading ? rest : layout.primary;
  const art = view.images.artwork ?? view.images.background;
  return (
    <>
      <Img image={art} className="pc-poster-blur" />
      <Img image={view.images.artwork} fallback={view.images.background} className="pc-art-img" />
      <div className="pc-poster-shade" data-darken={!view.suppressHeaderDarkening || undefined} />
      <div className="pc-poster-body">
        <div className="pc-art-top">
          <LogoLine view={view} poster={layout.poster} slot="primaryLogo" />
          <FieldRow fields={layout.header} className="pc-header" />
        </div>
        <div className="pc-poster-low">
          <Code layout={layout} />
          {heading || fields.length ? (
            <div className="pc-poster-primary">
              {heading ? <h2 className="pc-title">{heading.text}</h2> : null}
              <FieldRow fields={fields} className="pc-primary" />
            </div>
          ) : null}
          {layout.poster ? <Rows layout={layout} /> : null}
          <FieldRow fields={layout.footer.slice(0, 1)} className="pc-poster-footer" />
        </div>
      </div>
    </>
  );
}

export function Front({ view, layout }: Props) {
  if (layout.style === 'posterGeneric' || layout.poster)
    return <Poster view={view} layout={layout} />;
  switch (layout.style) {
    case 'storeCard':
    case 'coupon':
      return <StripCard view={view} layout={layout} />;
    case 'eventTicket':
      return <EventTicket view={view} layout={layout} />;
    case 'boardingPass':
      return <BoardingPass view={view} layout={layout} />;
    default:
      return <Generic view={view} layout={layout} />;
  }
}
