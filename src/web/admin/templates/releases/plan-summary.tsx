import type { ReleaseDiffValue, ReleasePlan } from '@/shared/contracts/template-release-flow.ts';
import { formatCount } from '../../../lib/format.ts';
import { ReleaseDiff } from './release-diff.tsx';

/** What a release or a restore changes and who it reaches: the dialogs' one body. */
export function PlanSummary({
  plan,
  templateId,
  orgId,
  diff = true,
}: {
  plan: Pick<ReleasePlan, 'diff' | 'modes'>;
  templateId: string;
  orgId: string;
  /** False on a first release, which shows the pass instead. */
  diff?: boolean;
}) {
  const impact = (plan.modes.live ?? plan.modes.test)?.impact;
  const image = (v: Extract<ReleaseDiffValue, { type: 'image' }>) =>
    `/api/v1/templates/${encodeURIComponent(templateId)}/versions/${encodeURIComponent(v.version)}/assets/${encodeURIComponent(v.asset)}?orgId=${encodeURIComponent(orgId)}`;
  return (
    <>
      {diff ? <ReleaseDiff groups={plan.diff} image={image} /> : null}
      {impact ? (
        <p className="text-sm text-fg-muted">
          {impact.passes.count === 0 ? (
            'No passes yet'
          ) : (
            <>
              <b className="text-fg-strong">{formatCount(impact.passes.count)}</b>
              {impact.passes.capped ? '+' : ''}{' '}
              {impact.passes.count === 1 ? 'pass updates' : 'passes update'}
              {impact.devices.count > 0 ? (
                <>
                  {' · '}
                  <b className="text-fg-strong">{formatCount(impact.devices.count)}</b> on phones
                </>
              ) : null}
            </>
          )}
        </p>
      ) : null}
    </>
  );
}
