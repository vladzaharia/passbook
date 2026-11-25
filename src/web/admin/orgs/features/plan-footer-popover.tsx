import { Info } from 'lucide-react';
import { FOOTER_SAMPLE, PLAN_COPY, PLAN_PLACES } from '@/shared/copy/plans.ts';
import type { FooterLevel } from '@/shared/plan-facts.ts';
import { IconButton, Popover, PopoverContent, PopoverTrigger } from '@/web/ui/index.ts';
import { BrandMark } from '@/web/ui/layout/brand-mark.tsx';

/** The footer as holders read it: the real wording, the glyph where the real footer has it. */
export function FooterSample({ level }: { level: FooterLevel }) {
  if (level !== 'full') return <span>{FOOTER_SAMPLE[level]}</span>;
  const lead = FOOTER_SAMPLE.full.replace(/ PassBook$/, '');
  return (
    <span className="inline-flex items-center gap-1">
      {lead}
      <BrandMark className="size-3.5" />
      <b className="font-semibold text-fg-strong">PassBook</b>
    </span>
  );
}

/** Where PassBook shows for a plan, one row per place. A button beside the footer sample opens it. */
export function PlanFooterInfo({
  plan,
  level,
  orgName,
  audience = 'platform',
}: {
  plan: string;
  level: FooterLevel;
  /** The org's name where it is known; the email sender row reads it. */
  orgName?: string | undefined;
  /** Who reads it: the org itself is told to pick its footer, a platform admin that the org does. */
  audience?: 'platform' | 'org';
}) {
  return (
    <Popover>
      <PopoverTrigger asChild>
        <IconButton size="sm" label={PLAN_COPY.placesLabel(plan)} icon={<Info aria-hidden />} />
      </PopoverTrigger>
      <PopoverContent align="end" className="w-80">
        <p className="mb-2 text-sm font-semibold text-fg-strong">{PLAN_COPY.placesTitle}</p>
        <dl className="flex flex-col gap-2 text-xs">
          {PLAN_PLACES.map((row) => (
            <div key={row.place} className="grid grid-cols-[6.5rem_1fr] gap-x-3">
              <dt className="text-fg-muted">{row.place}</dt>
              <dd className="text-fg-strong">
                {row.by[level].replace('{Org}', orgName || 'Org name')}
                {row.hint ? <span className="block text-fg-muted">{row.hint}</span> : null}
              </dd>
            </div>
          ))}
        </dl>
        {level === 'full' ? null : (
          <p className="mt-3 border-t border-border pt-2 text-xs text-fg-muted">
            {audience === 'org' ? PLAN_COPY.placesNoteOrg : PLAN_COPY.placesNote}
          </p>
        )}
      </PopoverContent>
    </Popover>
  );
}
