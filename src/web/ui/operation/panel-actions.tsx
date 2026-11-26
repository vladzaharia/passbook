import type { Ref } from 'react';
import { Button } from '../button.tsx';
import type { Operation } from './types.ts';

export interface PanelActions {
  /** Stop: offered while it runs and the kind allows it. */
  onStop?: () => unknown;
  onRetry?: () => unknown;
  /** Close: a finished or failed panel leaves. */
  onClose?: () => unknown;
  /** Run in background (dialogs): the tray takes over. */
  onBackground?: () => unknown;
  /** The kind's next action after Done ("Show key", "Create sandbox"). */
  next?: { label: string; onClick: () => void };
}

/** The panel's buttons, by state (docs/design/ui-consistency.md "Progress"). Retry is the first control after the list. */
export function PanelButtons({
  op,
  actions,
  nextRef,
  retrying,
}: {
  op: Operation;
  actions: PanelActions;
  nextRef: Ref<HTMLButtonElement>;
  retrying?: boolean;
}) {
  const { onStop, onRetry, onClose, onBackground, next } = actions;
  const buttons = [];
  if (op.status === 'failed') {
    if (onClose)
      buttons.push(
        <Button key="close" variant="ghost" onClick={onClose}>
          Close
        </Button>,
      );
    if (onRetry && op.error?.retryable !== false)
      buttons.push(
        <Button key="retry" ref={nextRef} loading={retrying} onClick={onRetry}>
          Retry
        </Button>,
      );
  } else if (op.status === 'succeeded') {
    if (!next && onClose)
      buttons.push(
        <Button key="done" ref={nextRef} variant="ghost" onClick={onClose}>
          Done
        </Button>,
      );
    if (next && onClose)
      buttons.push(
        <Button key="done" variant="ghost" onClick={onClose}>
          Done
        </Button>,
      );
    if (next)
      buttons.push(
        <Button key="next" ref={nextRef} onClick={next.onClick}>
          {next.label}
        </Button>,
      );
  } else if (op.status === 'cancelled' || op.status === 'waiting') {
    if (onClose)
      buttons.push(
        <Button key="close" variant="ghost" onClick={onClose}>
          Close
        </Button>,
      );
  } else {
    // queued, running
    if (onBackground)
      buttons.push(
        <Button key="bg" variant="ghost" onClick={onBackground}>
          Run in background
        </Button>,
      );
    if (op.cancelable && onStop)
      buttons.push(
        <Button
          key="stop"
          variant="outline"
          loading={op.cancelRequested}
          onClick={onStop}
          aria-label={op.cancelRequested ? 'Stopping' : undefined}
        >
          {op.cancelRequested ? 'Stopping' : 'Stop'}
        </Button>,
      );
  }
  if (op.status === 'waiting' && onStop && op.cancelable)
    buttons.push(
      <Button key="stop" variant="outline" onClick={onStop}>
        Stop
      </Button>,
    );
  if (buttons.length === 0) return null;
  return (
    <div className="flex flex-wrap items-center justify-end gap-2 max-sm:[&>*]:flex-1">
      {buttons}
    </div>
  );
}
