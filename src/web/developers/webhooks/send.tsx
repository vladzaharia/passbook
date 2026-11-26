import { ChevronDown, Send } from 'lucide-react';
import { BENCH_WEBHOOKS_COPY } from '../../../shared/copy/developers-bench-webhooks.ts';
import { BenchMenu } from '../bench/menu.tsx';

const C = BENCH_WEBHOOKS_COPY.send;
export const TEST_TYPE = 'webhook.test';

/**
 * The tool's one primary action: send a test event (⌘↵). The chevron beside it sends any other
 * event type once, so the title row keeps one line on a phone.
 */
export function SendButton({
  types,
  busy,
  onSend,
}: {
  types: readonly string[];
  busy: boolean;
  onSend: (type: string) => void;
}) {
  return (
    <span className="wh-send">
      <button
        type="button"
        className="btn"
        disabled={busy}
        aria-keyshortcuts="Meta+Enter Control+Enter"
        onClick={() => onSend(TEST_TYPE)}
      >
        <Send aria-hidden="true" />
        {C.action}
      </button>
      <BenchMenu
        label={C.as}
        trigger={<ChevronDown aria-hidden="true" />}
        items={types
          .filter((t) => t !== TEST_TYPE)
          .map((t) => ({ key: t, label: t, onSelect: () => onSend(t) }))}
      />
    </span>
  );
}
