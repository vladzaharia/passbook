import { useQuery } from '@tanstack/react-query';
import { useMemo } from 'react';
import { myPassQuery } from './api.ts';
import { Detail } from './pass-detail-page.tsx';
import { PassHeader } from './pass-header.tsx';
import { holderState, type MyPass, toView } from './pass-view.ts';

/**
 * Master-detail (768 and up): the front pass's page beside the stack, the card left out (the
 * stack's front is it). The list's copy shows at once; the pass's own read adds what the list
 * leaves out (support contacts).
 */
export function StackPanel({ seed, level }: { seed: MyPass; level: 1 | 2 }) {
  const query = useQuery({ ...myPassQuery(seed.id), placeholderData: seed });
  const pass = query.data ?? seed;
  const view = useMemo(() => toView(pass), [pass]);
  const state = holderState(pass, view);
  return (
    <div className="wl-mp-panel min-w-0">
      <PassHeader pass={pass} view={view} state={state} panel level={level} />
      <Detail pass={pass} view={view} state={state} dealt={false} panel />
    </div>
  );
}
