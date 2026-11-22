import { TagArt } from './tag-art.tsx';
import './tag-prop.css';

/**
 * The tag beside the violet pass (BM link beat). Once the tag is on the pass it flies to the pass's
 * top edge and clicks in; a chain glyph pops at the join. A refused tag is grey and struck.
 */
export function TagProp({ struck = false }: { struck?: boolean }) {
  return (
    <span className="scan-tag-prop" data-struck={struck || undefined}>
      <span className="scan-tag-fob">
        <TagArt size={64} struck={struck} />
      </span>
      <svg aria-hidden className="scan-tag-chain" viewBox="0 0 24 24" width={28} height={28}>
        <rect x="2" y="8" width="11" height="8" rx="4" />
        <rect x="11" y="8" width="11" height="8" rx="4" />
      </svg>
    </span>
  );
}
