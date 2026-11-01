import { Link } from '@tanstack/react-router';
import { ChevronDown, X } from 'lucide-react';
import { useState } from 'react';
import type { PassDetailDto } from '@/shared/contracts/passes.ts';
import { ACTION_ICON } from '../../../lib/action-icons.ts';
import { cn } from '../../../lib/cn.ts';
import { formatDateTime } from '../../../lib/format.ts';
import { Button, Callout, IconButton } from '../../../ui/index.ts';
import type { PassActionRunner } from '../pass-actions.tsx';

/** Voided: when and by whom; Unvoid sits in the header. The Ban stamps when it just happened. */
export function VoidedCallout({ pass, stamp }: { pass: PassDetailDto; stamp: boolean }) {
  const v = pass.voided;
  const by = v?.actorLabel ?? (v?.actorType === 'connection' ? 'its connection' : null);
  return (
    <div data-stamp={stamp || undefined}>
      <Callout tone="warning" icon={ACTION_ICON.void}>
        Voided on {formatDateTime(v?.at ?? pass.modifiedAt)}
        {by ? ` by ${by}` : ''}. Holders see it as void.
      </Callout>
    </div>
  );
}

const IMAGE_CODES = /^(IMAGE_|THUMBNAIL_|PLATFORM_BRANDING|UNUSED_IMAGE|MISSING_IMAGE)/;

/** This pass's own warnings, collapsed: one line each, linking to the tab that fixes it. */
export function PassWarnings({ pass }: { pass: PassDetailDto }) {
  const [open, setOpen] = useState(false);
  const list = pass.warnings.filter((w) => w.severity !== 'info');
  if (list.length === 0) return null;
  return (
    <Callout
      tone="warning"
      title={
        <button
          type="button"
          aria-expanded={open}
          onClick={() => setOpen((o) => !o)}
          className="inline-flex items-center gap-1 rounded-sm text-left focus-visible:outline-2 focus-visible:outline-focus"
        >
          Pass warnings ({list.length})
          <ChevronDown
            aria-hidden
            className={cn('wl-chevron size-4 text-fg-muted', open && 'rotate-180')}
          />
        </button>
      }
      items={
        open
          ? list.map((w) => (
              <Link
                key={`${w.code}${w.path ?? ''}`}
                to="."
                search={{ tab: IMAGE_CODES.test(w.code) ? 'images' : 'fields' }}
                className="underline-offset-2 hover:underline"
              >
                {w.message}
              </Link>
            ))
          : []
      }
    />
  );
}

/** After a create without sending: the next steps, until dismissed. */
export function CreatedCallout({
  pass,
  runner,
  onSend,
  onDismiss,
}: {
  pass: PassDetailDto;
  runner: PassActionRunner;
  onSend: () => void;
  onDismiss: () => void;
}) {
  return (
    <div className="relative">
      <Callout
        tone="success"
        title="Pass created"
        actions={
          <>
            {pass.holderEmail ? (
              <Button size="sm" iconStart={<ACTION_ICON.sendEmail aria-hidden />} onClick={onSend}>
                Send to holder
              </Button>
            ) : null}
            <Button
              size="sm"
              variant="outline"
              iconStart={<ACTION_ICON.duplicate aria-hidden />}
              done={runner.done.copy}
              onClick={() => runner.run('copy')}
            >
              Copy link
            </Button>
            <Button
              size="sm"
              variant="ghost"
              iconStart={<ACTION_ICON.create aria-hidden />}
              asChild
            >
              <Link to="/admin/passes/new">Create another</Link>
            </Button>
          </>
        }
      />
      <IconButton
        label="Dismiss"
        size="sm"
        icon={<X aria-hidden />}
        onClick={onDismiss}
        className="absolute top-2 right-2"
      />
    </div>
  );
}
