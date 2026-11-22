import { useNavigate } from '@tanstack/react-router';
import { formatCount } from '../../../lib/format.ts';
import { useMode } from '../../../lib/mode.ts';
import { Button } from '../../../ui/index.ts';
import { vOf } from '../versions.ts';
import { useRollout } from './rollout-api.ts';
import type { RolloutScope, RolloutTemplate } from './rollout-card.tsx';

/** One line at the top of the template page while passes are still updating or holders can be told. */
export function RolloutBanner({
  template,
  scope,
}: {
  template: RolloutTemplate;
  scope: RolloutScope;
}) {
  const mode = useMode();
  const navigate = useNavigate();
  const rollout = useRollout(
    template.id,
    scope.orgId ?? '',
    mode,
    Boolean(scope.orgId && scope.membership),
  );
  const r = rollout.data;
  const waiting = r ? r.remaining - r.failedCount : 0;
  if (!r?.releaseVersion || r.total === 0 || (waiting === 0 && !r.tell)) return null;
  const version = vOf(template, r.releaseVersion);
  const text =
    waiting > 0
      ? `Updating passes to ${version}: ${formatCount(r.onRelease)} of ${formatCount(r.total)}`
      : `${version} is on every pass. You can tell holders.`;
  const view = () =>
    void navigate({ to: '.', search: { tab: 'versions' }, replace: true }).then(() =>
      requestAnimationFrame(() =>
        document.getElementById('rollout')?.scrollIntoView({ behavior: 'smooth', block: 'start' }),
      ),
    );
  return (
    <div
      role="status"
      className="mb-4 flex flex-wrap items-center justify-between gap-2 rounded-lg border border-border bg-surface-sunken px-4 py-2 text-sm"
    >
      <span>{text}</span>
      <Button size="sm" variant="outline" onClick={view}>
        View
      </Button>
    </div>
  );
}
