import { Nfc, Search } from 'lucide-react';
import { SCAN_COPY } from '../../../shared/copy/scan.ts';
import { SCAN_TAG_COPY } from '../../../shared/copy/scan-tags.ts';
import type { AssignState } from '../machine/assign-state.ts';
import { DockButton } from '../ui/dock.tsx';
import { TAG_EXTRA_COPY } from './copy.ts';
import type { TagReader } from './tag-reader.ts';
import { useRetryWait } from './use-retry-wait.ts';

export interface AssignDockHandlers {
  cancel(): void;
  back(): void;
  done(): void;
  again(keepPass: boolean): void;
  bind(move?: boolean): void;
  askManager(): void;
  retry(): void;
  readTag(): void;
  startNfc(): void;
  lookUp(): void;
}

/** The dock's pair for each step: Cancel (gray) and the step's primary. */
export function AssignDock({
  a,
  reader,
  manager,
  webStatus,
  on,
}: {
  a: AssignState;
  reader: TagReader;
  manager: boolean;
  webStatus: 'idle' | 'on' | 'denied' | 'error';
  on: AssignDockHandlers;
}) {
  const c = SCAN_TAG_COPY;
  const wait = useRetryWait(a.error);
  const cancel = <DockButton onClick={on.cancel}>{SCAN_COPY.actions.cancel}</DockButton>;
  if (a.busy)
    return (
      <>
        {cancel}
        <DockButton primary variant="filled" disabled>
          {TAG_EXTRA_COPY.reading}
        </DockButton>
      </>
    );
  switch (a.step) {
    case 'tag':
      return (
        <>
          {cancel}
          {reader.kind === 'sheet' ? (
            <DockButton
              primary
              variant="filled"
              className="scan-dock-wide"
              onClick={on.readTag}
              autoFocus
            >
              <Nfc aria-hidden size={20} className="scan-dock-icon-extra" />
              {c.tag.readButton}
            </DockButton>
          ) : reader.kind === 'webnfc' && webStatus !== 'on' ? (
            <DockButton primary variant="filled" className="scan-dock-wide" onClick={on.startNfc}>
              <Nfc aria-hidden size={20} className="scan-dock-icon-extra" />
              {c.tag.allowNfc}
            </DockButton>
          ) : null}
        </>
      );
    case 'pass':
      return (
        <>
          {cancel}
          {a.banner === 'ambiguous' ? null : (
            <DockButton primary variant="filled" onClick={on.lookUp}>
              <Search aria-hidden size={20} />
              {TAG_EXTRA_COPY.look}
            </DockButton>
          )}
        </>
      );
    case 'confirm': {
      const w = a.preview?.warnings ?? [];
      const held = w.includes('held_by_other') || w.includes('lost');
      const move = held || w.includes('replaces_pass_tag') || w.includes('replaces_user_tag');
      return (
        <>
          <DockButton onClick={on.back}>{TAG_EXTRA_COPY.back}</DockButton>
          {held && !manager ? (
            // The form is open on the card: its own Continue is the one primary.
            a.pin?.open ? null : (
              <DockButton primary variant="filled" onClick={on.askManager}>
                {TAG_EXTRA_COPY.askManager}
              </DockButton>
            )
          ) : (
            <DockButton primary variant="filled" onClick={() => on.bind(held)}>
              {move ? c.confirm.move : c.confirm.assign}
            </DockButton>
          )}
        </>
      );
    }
    case 'done':
      return (
        <>
          {a.source === 'request' ? null : (
            <DockButton onClick={() => on.again(false)}>{c.dock.assignAnother}</DockButton>
          )}
          <DockButton
            primary
            variant="filled"
            shape={a.source === 'request' ? undefined : 'fixed'}
            onClick={on.done}
          >
            {TAG_EXTRA_COPY.done}
          </DockButton>
        </>
      );
    case 'error': {
      const kind = a.error?.kind;
      const retryable = kind === 'not_assigned' || kind === 'went_wrong';
      if (kind === 'too_many')
        return (
          <>
            {cancel}
            <DockButton primary variant="filled" disabled={wait !== 0} onClick={on.retry}>
              {c.dock.tryAgain}
            </DockButton>
          </>
        );
      if (kind === 'holder_changed')
        return (
          <>
            <DockButton onClick={on.done}>{TAG_EXTRA_COPY.done}</DockButton>
            <DockButton primary variant="filled" onClick={() => on.again(false)}>
              {c.dock.startAgain}
            </DockButton>
          </>
        );
      if (kind === 'secure_needed')
        return (
          <DockButton primary variant="filled" onClick={on.done}>
            {TAG_EXTRA_COPY.done}
          </DockButton>
        );
      return (
        <>
          {retryable ? (
            <>
              <DockButton primary variant="filled" onClick={on.retry}>
                {c.dock.tryAgain}
              </DockButton>
              {cancel}
            </>
          ) : kind === 'already_here' ? (
            <>
              <DockButton onClick={() => on.again(false)}>{c.dock.assignAnother}</DockButton>
              <DockButton primary variant="filled" shape="fixed" onClick={on.done}>
                {TAG_EXTRA_COPY.done}
              </DockButton>
            </>
          ) : (
            <>
              <DockButton
                {...(kind === 'lost' ? { primary: true, variant: 'filled' as const } : {})}
                onClick={on.done}
              >
                {TAG_EXTRA_COPY.done}
              </DockButton>
              {kind === 'lost' ? null : (
                <DockButton primary variant="filled" onClick={() => on.again(true)}>
                  {c.dock.tryAnother}
                </DockButton>
              )}
            </>
          )}
        </>
      );
    }
  }
}
