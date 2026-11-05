import { Bus, BusFront, Plane, Ship, TrainFront } from 'lucide-react';
import { useState } from 'react';
import type { FieldView, ImageView, PassView, TransitView } from '../../shared/pass-view/index.ts';

const BREAKABLE = /^(?:https?:\/\/\S+|[^\s@]+@[^\s@]+\.[^\s@]+|www\.\S+)$/i;

/** URLs and emails break only after "@", "." or "/" (a <wbr> after each); other text as usual. */
export function Breakable({ text }: { text: string }) {
  return (
    <>
      {text.split(/(\s+)/).map((word, w) =>
        BREAKABLE.test(word)
          ? word.split(/(?<=[@./])/).map((piece, i, all) =>
              i < all.length - 1 ? (
                // biome-ignore lint/suspicious/noArrayIndexKey: positional pieces of one string
                <span key={`${w}-${i}`}>
                  {piece}
                  <wbr />
                </span>
              ) : (
                piece
              ),
            )
          : word,
      )}
    </>
  );
}

export function Rich({ field, wrap }: { field: FieldView; wrap?: boolean }) {
  if (field.dateTime) return <time dateTime={field.dateTime}>{field.text}</time>;
  return (
    <>
      {field.segments.map((s, i) =>
        s.href ? (
          <a
            // biome-ignore lint/suspicious/noArrayIndexKey: segments are positional and static
            key={i}
            href={s.href}
            {...(s.href.startsWith('https:') ? { target: '_blank' } : {})}
            rel="noopener noreferrer nofollow"
          >
            {wrap ? <Breakable text={s.text} /> : s.text}
          </a>
        ) : (
          // biome-ignore lint/suspicious/noArrayIndexKey: segments are positional and static
          <span key={i}>{wrap ? <Breakable text={s.text} /> : s.text}</span>
        ),
      )}
    </>
  );
}

/** Front values are one line; a long primary value steps its size down once before truncating. */
export function Field({ field, big }: { field: FieldView; big?: boolean }) {
  return (
    <div
      className="pc-field"
      data-fk={field.key}
      data-align={field.align}
      data-big={big || undefined}
      data-long={field.text.length > 12 || undefined}
      data-mid={field.text.length > 8 || undefined}
    >
      {field.label ? <span className="pc-label">{field.label}</span> : null}
      <span className="pc-value">
        <Rich field={field} />
      </span>
    </div>
  );
}

export function FieldRow({ fields, className }: { fields: FieldView[]; className?: string }) {
  if (!fields.length) return null;
  return (
    <div className={`pc-row${className ? ` ${className}` : ''}`}>
      {fields.map((f) => (
        <Field key={f.key} field={f} />
      ))}
    </div>
  );
}

/** Hides itself if the file fails to load; `fallback` is tried next. */
export function Img({
  image,
  fallback,
  alt = '',
  className,
}: {
  image: ImageView | undefined;
  fallback?: ImageView | undefined;
  alt?: string;
  className?: string;
}) {
  const [failed, setFailed] = useState<string[]>([]);
  const shown = [image, fallback].find((i) => i && !failed.includes(i.src));
  if (!shown) return null;
  return (
    <img
      className={className}
      src={shown.src}
      {...(shown.srcset ? { srcSet: shown.srcset } : {})}
      alt={alt}
      decoding="async"
      draggable={false}
      onError={() => setFailed((f) => [...f, shown.src])}
    />
  );
}

export function LogoLine({
  view,
  slot = 'logo',
  poster,
}: {
  view: PassView;
  poster: boolean;
  slot?: 'logo' | 'primaryLogo';
}) {
  const image = view.images[slot] ?? view.images.logo;
  const text = poster ? (view.eventLogoText ?? view.logoText) : view.logoText;
  return (
    <div className="pc-logo">
      <Img image={image} alt={text ? '' : view.organizationName} className="pc-logo-img" />
      {text ? <span className="pc-logo-text">{text}</span> : null}
      {!image && !text ? <span className="pc-logo-text">{view.organizationName}</span> : null}
    </div>
  );
}

const GLYPHS = { air: Plane, boat: Ship, bus: BusFront, train: TrainFront, generic: Bus };

export function TransitGlyph({ transit }: { transit: TransitView }) {
  const Icon = GLYPHS[transit.kind];
  return (
    <span className="pc-transit" role="img" aria-label={transit.label}>
      <Icon aria-hidden="true" focusable="false" />
    </span>
  );
}
