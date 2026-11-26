import type { Operation } from '../../ui/operation/types.ts';

export interface SandboxOperationProps {
  id: string;
  framing?: 'plain' | 'card';
  /** The kind's next action after Done ("Create sandbox"). */
  next?: { label: string; onClick: () => void };
  buddy?: boolean;
  onSucceeded?: (op: Operation) => void;
  onGone?: () => void;
  onClose?: () => void;
}
