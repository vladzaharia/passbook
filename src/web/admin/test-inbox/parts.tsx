import { Badge } from '../../ui/badge.tsx';

/** Simulate marked this message failed: the row and the details say so in the same words. */
export function FailedBadge() {
  return <Badge tone="danger">Failed</Badge>;
}
