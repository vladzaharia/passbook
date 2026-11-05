import { Link } from '@tanstack/react-router';
import { ChevronDown, UserPlus } from 'lucide-react';
import { useState } from 'react';
import type { PassDetailDto } from '@/shared/contracts/passes.ts';
import { ACTION_ICON } from '../../../lib/action-icons.ts';
import { cn } from '../../../lib/cn.ts';
import { formatDateTime } from '../../../lib/format.ts';
import { setMode } from '../../../lib/mode.ts';
import { Button, Callout, ProgressBar } from '../../../ui/index.ts';
import { CreatedCallout } from '../created.tsx';
import type { PassActionRunner } from '../pass-actions.tsx';
import { REMOVAL_LIMIT, removedOnDevices } from './removal-copy.ts';
import { usePassDevices } from './sync-api.ts';

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
          className="inline-flex items-center gap-1 rounded-sm text-left focus-visible:outline-2 focus-visible:outline-focus pointer-coarse:-my-3 pointer-coarse:min-h-11"
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

/** After the wizard: what happened and the next steps (send, copy the link, another like it). */
export function PassCreatedCallout({
  pass,
  sent,
  runner,
  onSend,
  onDismiss,
}: {
  pass: PassDetailDto;
  /** The wizard emailed it. */
  sent: boolean;
  runner: PassActionRunner;
  onSend: () => void;
  onDismiss: () => void;
}) {
  return (
    <CreatedCallout
      title={
        sent && pass.holderEmail ? `Pass created and sent to ${pass.holderEmail}` : 'Pass created'
      }
      onDismiss={onDismiss}
      actions={
        <>
          {sent ? null : pass.holderEmail ? (
            <Button size="sm" iconStart={<ACTION_ICON.sendEmail aria-hidden />} onClick={onSend}>
              Send to holder
            </Button>
          ) : (
            <Button size="sm" iconStart={<UserPlus aria-hidden />} asChild>
              <Link to="." search={{ tab: 'holder' }}>
                Add holder
              </Link>
            </Button>
          )}
          <Button
            size="sm"
            variant="outline"
            iconStart={<ACTION_ICON.duplicate aria-hidden />}
            done={runner.done.copy}
            onClick={() => runner.run('copy')}
          >
            Copy link
          </Button>
          <Button size="sm" variant="ghost" iconStart={<ACTION_ICON.create aria-hidden />} asChild>
            <Link
              to="/admin/passes/new"
              search={{ orgId: pass.orgId, templateId: pass.templateId }}
            >
              Create another
            </Link>
          </Button>
        </>
      }
    />
  );
}

/**
 * Removed from Wallet, on every tab: when, how far the devices are (a device counts once it
 * fetched the final version or deleted the pass) and the one limit. Restore sits in the header.
 */
export function RemovedCallout({ pass, tab }: { pass: PassDetailDto; tab: string }) {
  const devices = usePassDevices(pass.id, true);
  const removal = devices.data?.removal;
  const done = removal?.done ?? 0;
  const total = removal?.total ?? 0;
  return (
    <Callout
      tone={total > 0 && done === total ? 'success' : 'warning'}
      icon={ACTION_ICON.removeFromWallet}
      title={`Removed from Wallet on ${formatDateTime(pass.removedAt ?? pass.modifiedAt)}`}
      actions={
        tab === 'devices' ? null : (
          <Button size="sm" variant="outline" asChild>
            <Link to="." search={{ tab: 'devices' }}>
              Devices
            </Link>
          </Button>
        )
      }
    >
      <div className="grid gap-2">
        {removal ? (
          <>
            <p className="font-medium text-fg-strong tabular-nums">
              {removedOnDevices(done, total)}
            </p>
            {total > 0 ? (
              <ProgressBar label="Devices updated" value={done} max={total} tone="success" />
            ) : null}
          </>
        ) : null}
        <p>{REMOVAL_LIMIT}</p>
      </div>
    </Callout>
  );
}

/** A pass of the other mode: its actions are off until the mode matches. */
export function ModeMismatchCallout({ pass }: { pass: PassDetailDto }) {
  const live = pass.mode === 'live';
  return (
    <Callout
      tone="warning"
      actions={
        <Button size="sm" variant="outline" onClick={() => setMode(pass.mode)}>
          Switch to {live ? 'Live' : 'Test'} mode
        </Button>
      }
    >
      {live
        ? 'Live pass. Changes reach holders. Switch to Live mode to edit.'
        : 'Test pass. Switch to Test mode to edit.'}
    </Callout>
  );
}
