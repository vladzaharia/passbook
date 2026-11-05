import { type CSSProperties, useState } from 'react';
import type { PassTarget, PassView } from '../../shared/pass-view/index.ts';
import { Back } from './back.tsx';
import { Front } from './front.tsx';
import './pass-card-base.css';
import './pass-card-poster.css';
import './pass-card-text.css';

/** Workstream b owns this module. Keep `PassCard` and `PassCardProps` exported; must be SSR-safe. */
export interface PassCardProps {
  view: PassView;
  face?: 'front' | 'back';
  className?: string;
  /** Draw the layout for this OS generation instead of `view.target`. */
  target?: PassTarget;
  /** Removed from Wallet by the org: dimmed, with no Voided stamp (the page says why). */
  removed?: boolean;
}

export function PassCard({ view, face = 'front', className, target, removed }: PassCardProps) {
  const layout = view.layouts[target ?? view.target];
  const c = view.colors;
  const vars = {
    '--pc-bg': c.background,
    '--pc-fg': c.foreground,
    '--pc-label': c.label,
    ...(c.strip ? { '--pc-strip': c.strip } : {}),
    ...(c.footerBackground ? { '--pc-footer': c.footerBackground } : {}),
  } as CSSProperties;
  const name = view.description || view.organizationName || 'Pass';
  return (
    <div
      className={className ? `pc-root ${className}` : 'pc-root'}
      data-face={face}
      data-style={layout.style}
      data-poster={layout.poster || undefined}
      data-semantic={layout.semantic?.kind}
      data-approximate={layout.approximate || undefined}
      data-dark={c.dark || undefined}
      data-removed={removed || undefined}
    >
      {/* biome-ignore lint/a11y/useSemanticElements: fieldset adds form semantics; a landmark per card is noise */}
      <div
        className="pc-card"
        style={vars}
        data-voided={view.invalid && !removed ? '' : undefined}
        role="group"
        aria-label={`${name}, ${face === 'front' ? 'front' : 'back'}`}
      >
        {face === 'front' ? (
          <Front view={view} layout={layout} />
        ) : (
          <Back view={view} layout={layout} />
        )}
        {view.invalid && !removed ? (
          <div className="pc-void" role="status">
            <span>{view.invalid === 'voided' ? 'Voided' : 'Expired'}</span>
          </div>
        ) : null}
      </div>
    </div>
  );
}

export interface PassCardFlipProps extends Omit<PassCardProps, 'face'> {
  defaultFace?: 'front' | 'back';
}

export function PassCardFlip({ defaultFace = 'front', ...props }: PassCardFlipProps) {
  const [face, setFace] = useState(defaultFace);
  return (
    <div className="pc-flip">
      <PassCard {...props} face={face} />
      <button
        type="button"
        className="pc-flip-btn"
        onClick={() => setFace(face === 'front' ? 'back' : 'front')}
      >
        {face === 'front' ? 'Details' : 'Front'}
      </button>
    </div>
  );
}
