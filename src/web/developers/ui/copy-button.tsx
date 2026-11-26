import { WrapText } from 'lucide-react';
import { useEffect, useRef } from 'react';
import { CODE_COPY } from '../../../shared/copy/developers-code.ts';
import { copyWithFeedback } from '../shell/copy.ts';
import { CopyIcons } from './copy-icons.tsx';

/** Copy for an island's block: the text is the sample on screen. The state and the announcement come from shell/copy. */
export function CopyBtn({
  text,
  label = 'Copy sample',
  onCopied,
}: {
  text: string;
  label?: string;
  onCopied?: () => void;
}) {
  const ref = useRef<HTMLButtonElement>(null);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  return (
    <button
      type="button"
      ref={ref}
      className="iconbtn copy"
      aria-label={label}
      onClick={() =>
        void copyWithFeedback(text, ref.current).then((ok) => {
          if (ok && mounted.current) onCopied?.();
        })
      }
    >
      <CopyIcons />
    </button>
  );
}

/** Phones only (CSS): long lines wrap instead of scrolling. The page's click handler flips it. */
export function WrapToggle() {
  return (
    <button type="button" className="wrapbtn" data-wrap-toggle aria-pressed="false">
      <WrapText className="lucide" aria-hidden="true" />
      {CODE_COPY.wrap}
    </button>
  );
}
