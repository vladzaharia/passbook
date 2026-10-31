import { Bus, BusFront, Plane, Ship, TrainFront } from 'lucide-react';
import type { FieldView, ImageView, PassView, TransitView } from '../../shared/pass-view/index.ts';

export function Rich({ field }: { field: FieldView }) {
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
            {s.text}
          </a>
        ) : (
          // biome-ignore lint/suspicious/noArrayIndexKey: segments are positional and static
          <span key={i}>{s.text}</span>
        ),
      )}
    </>
  );
}

export function Field({ field, big }: { field: FieldView; big?: boolean }) {
  return (
    <div className="pc-field" data-align={field.align} data-big={big || undefined}>
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

export function Img({
  image,
  alt = '',
  className,
}: {
  image: ImageView | undefined;
  alt?: string;
  className?: string;
}) {
  if (!image) return null;
  return (
    <img
      className={className}
      src={image.src}
      {...(image.srcset ? { srcSet: image.srcset } : {})}
      alt={alt}
      decoding="async"
      draggable={false}
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
