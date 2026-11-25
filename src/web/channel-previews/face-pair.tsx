import { type KeyboardEvent, type ReactNode, useRef, useState } from 'react';
import './face-pair.css';

export type PreviewFace = 'front' | 'back';

const SIDES = [
  { value: 'front', label: 'Front' },
  { value: 'back', label: 'Back' },
] as const;

/** A two-option radiogroup: arrows move and select, one tab stop. No kit imports, so every bundle can carry it. */
function SideToggle({
  label,
  value,
  onChange,
}: {
  label: string;
  value: PreviewFace;
  onChange: (face: PreviewFace) => void;
}) {
  const group = useRef<HTMLDivElement>(null);
  const move = (e: KeyboardEvent) => {
    if (!['ArrowRight', 'ArrowDown', 'ArrowLeft', 'ArrowUp'].includes(e.key)) return;
    e.preventDefault();
    const next = value === 'front' ? 'back' : 'front';
    onChange(next);
    group.current?.querySelector<HTMLElement>(`[data-value="${next}"]`)?.focus();
  };
  return (
    <div ref={group} className="fp-seg" role="radiogroup" aria-label={label} onKeyDown={move}>
      {SIDES.map((o) => (
        // biome-ignore lint/a11y/useSemanticElements: a segmented radiogroup, as the kit's
        <button
          key={o.value}
          type="button"
          role="radio"
          data-value={o.value}
          aria-checked={value === o.value}
          tabIndex={value === o.value ? 0 : -1}
          onClick={() => onChange(o.value)}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

/**
 * A card's two faces: side by side when the container has room for both (face-pair.css, a
 * container query, so a narrow pane decides the same as a phone), else one face with a
 * Front / Back toggle. Both faces are always in the markup; the stylesheet shows one or both.
 * Controlled with `face` and `onFace`, or self-managed when omitted. `label` names the toggle
 * where a page has several ("Apple side").
 */
export function FacePair({
  front,
  back,
  face,
  onFace,
  label = 'Side',
  className,
}: {
  front: ReactNode;
  back: ReactNode;
  face?: PreviewFace | undefined;
  onFace?: ((face: PreviewFace) => void) | undefined;
  label?: string | undefined;
  className?: string | undefined;
}) {
  const [own, setOwn] = useState<PreviewFace>('front');
  const shown = face ?? own;
  const pick = (next: PreviewFace) => {
    setOwn(next);
    onFace?.(next);
  };
  return (
    <div className={className ? `fp ${className}` : 'fp'} data-face={shown}>
      <div className="fp-faces">
        <div className="fp-face" data-side="front">
          {front}
        </div>
        <div className="fp-face" data-side="back">
          {back}
        </div>
      </div>
      <SideToggle label={label} value={shown} onChange={pick} />
    </div>
  );
}
