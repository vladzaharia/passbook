import { Check } from 'lucide-react';
import type { ConnectionSetup } from '@/shared/contracts/connection-setup.ts';
import { Button } from '../../ui/index.ts';
import {
  HeldSecret,
  OVERLAP_CHOICES,
  type RotateSecretState,
} from '../../ui/webhook-setup/index.ts';
import { groupParts, SetupPartView } from '../../ui/webhook-setup/setup-part.tsx';
import { SigningSecretField } from './recipe-picker.tsx';

/** Inbound deliveries accept these overlaps; 3 days is outbound's. */
export const INBOUND_CHOICES = OVERLAP_CHOICES.filter((c) => c.value !== '72');

/**
 * The Secret step. A sender's own secret is pasted from its screen (the guide's where-step shows
 * where); PassBook's is shown once and copied, or made again when it was not kept.
 */
export function SecretStep({
  setup,
  held,
  hasSecret,
  replacing,
  onReplace,
  pasted,
  onPaste,
  pasteError,
  rotate,
  saved,
  onSaved,
  onRotated,
}: {
  setup: ConnectionSetup;
  /** The secret PassBook made at Create, until it is copied. */
  held: string | undefined;
  hasSecret: boolean;
  replacing: boolean;
  onReplace: () => void;
  pasted: string;
  onPaste: (value: string) => void;
  pasteError: string | undefined;
  rotate: RotateSecretState;
  /** The held secret was copied: the bar's Next waits on it. */
  saved: boolean;
  onSaved: (saved: boolean) => void;
  onRotated: () => void;
}) {
  const { origin } = setup.secret;
  const where = setup.steps.find((s) => s.id === setup.secret.whereStep);
  if (origin === 'provider') {
    if (hasSecret && !replacing)
      return (
        <div className="flex flex-wrap items-center gap-3">
          <p className="inline-flex items-center gap-2 text-sm text-fg">
            <Check aria-hidden className="size-4 text-success" />
            Secret saved
          </p>
          <Button variant="outline" size="sm" onClick={onReplace}>
            Replace secret
          </Button>
        </div>
      );
    return (
      <div className="flex min-w-0 flex-col gap-4">
        {where ? (
          <div className="flex flex-col gap-3">
            {groupParts(where.parts).map((part, k) => (
              <SetupPartView
                // biome-ignore lint/suspicious/noArrayIndexKey: static guide data
                key={k}
                part={part}
                values={{}}
                topics={setup.subscriptions.topics}
              />
            ))}
          </div>
        ) : null}
        <SigningSecretField
          value={pasted}
          onChange={onPaste}
          error={pasted ? pasteError : undefined}
        />
      </div>
    );
  }
  return (
    <HeldSecret
      held={held}
      saved={saved}
      onSaved={onSaved}
      rotate={rotate}
      onRotated={onRotated}
      choices={INBOUND_CHOICES}
    />
  );
}
