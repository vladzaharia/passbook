import { useEffect, useRef } from 'react';
import { SCAN_COPY } from '../../../shared/copy/scan.ts';
import { Button } from '../../ui/button.tsx';
import { BootCard } from '../ui/boot-card.tsx';
import { UI_COPY } from '../ui/copy.ts';

export type BlockKind = 'removed' | 'expired' | 'suspended' | 'unassigned' | 'signed_out';

const b = SCAN_COPY.boot;
const BLOCKS: Record<BlockKind, { title: string; line: string; action: string }> = {
  removed: { title: b.removedTitle, line: b.removedLine, action: SCAN_COPY.actions.pairAgain },
  expired: { title: b.expiredTitle, line: b.removedLine, action: SCAN_COPY.actions.pairAgain },
  suspended: { title: b.suspendedTitle, line: b.suspendedLine, action: SCAN_COPY.actions.tryAgain },
  unassigned: {
    title: b.unassignedTitle,
    line: b.unassignedLine,
    action: SCAN_COPY.actions.tryAgain,
  },
  signed_out: { title: b.signedOutTitle, line: b.signedOutLine, action: UI_COPY.signIn },
};

/**
 * A slate card for a scanner that cannot scan: removed, expired, suspended, not set up, signed
 * out. The camera and wake lock are released by the machine. The card is an alert, and focus
 * lands on its one action.
 */
export function BlockPanel({
  kind,
  onAction,
  href,
}: {
  kind: BlockKind;
  onAction?: () => void;
  /** Signed out links to `/login?next=/scan`. */
  href?: string;
}) {
  const t = BLOCKS[kind];
  const body = useRef<HTMLDivElement>(null);
  useEffect(() => {
    body.current?.querySelector<HTMLElement>('a, button')?.focus();
  }, []);
  return (
    <BootCard title={t.title} line={t.line} tone="slate" testId={`scan-block-${kind}`}>
      <div role="alert" className="scan-sr">
        {t.title}. {t.line}
      </div>
      <div ref={body}>
        {href ? (
          <Button asChild size="lg" className="w-full">
            <a href={href}>{t.action}</a>
          </Button>
        ) : (
          <Button size="lg" className="w-full" onClick={onAction}>
            {t.action}
          </Button>
        )}
      </div>
    </BootCard>
  );
}
