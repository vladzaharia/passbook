import { BROADCAST_MESSAGE_MAX } from '@/shared/contracts/broadcasts.ts';
import { QUICK_MESSAGES } from '@/shared/copy/quick-messages.ts';
import { Button } from '../../ui/index.ts';

/** Starter messages as chips: a tap puts the text in the editor. */
export function QuickMessages({
  value,
  onPick,
}: {
  value: string;
  onPick: (text: string) => void;
}) {
  return (
    <fieldset className="m-0 flex min-w-0 flex-wrap gap-2 border-0 p-0">
      <legend className="sr-only">Quick messages</legend>
      {QUICK_MESSAGES.map((q) => (
        <Button
          key={q.id}
          type="button"
          size="sm"
          variant="outline"
          className="aria-pressed:border-accent aria-pressed:bg-state-hover-tint aria-pressed:text-fg-strong"
          aria-pressed={value === q.text}
          onClick={() => onPick(q.text.slice(0, BROADCAST_MESSAGE_MAX))}
        >
          {q.label}
        </Button>
      ))}
    </fieldset>
  );
}
