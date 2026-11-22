import type { SetupCheck } from '@/shared/contracts/pass-setup.ts';
import { PASS_SETUP_COPY } from '@/shared/copy/pass-setup.ts';
import { scanLine } from '@/shared/copy/scan.ts';
import { todoCount } from '@/shared/org-setup-checks.ts';
import { cn } from '@/web/lib/cn.ts';
import { BuddyFace } from '@/web/ui/art/face.tsx';
import { Card, CardBody, CardHeader } from '@/web/ui/index.ts';
import { CheckList } from './check-list.tsx';
import './brand.css';

/**
 * Setup checks as suggestions or to-dos, never gates. Each row has one fix that works in place;
 * when it lands the row draws a check, holds, and folds away. At zero the buddy cheers.
 */
export function ChecksCard({
  checks,
  onFix,
  canFix,
}: {
  checks: readonly SetupCheck[];
  onFix: (check: SetupCheck) => void;
  canFix: boolean;
}) {
  const todo = todoCount(checks);
  const pips = Math.min(todo, 5);
  return (
    <Card role="region" aria-label={PASS_SETUP_COPY.title}>
      <CardHeader
        title={
          <span className="inline-flex items-center gap-2">
            {todo > 0 ? scanLine(PASS_SETUP_COPY.toDo, { n: todo }) : PASS_SETUP_COPY.ready}
            <span aria-hidden className="inline-flex gap-1">
              {Array.from({ length: Math.max(pips, 1) }, (_, i) => (
                <span
                  // biome-ignore lint/suspicious/noArrayIndexKey: pips are positional
                  key={i}
                  className={cn('h-1 w-3 rounded-full', todo > 0 ? 'bg-warning' : 'bg-success')}
                />
              ))}
            </span>
          </span>
        }
        actions={<BuddyFace className="h-6 w-7" />}
      />
      <CardBody>
        <CheckList
          checks={checks}
          onFix={onFix}
          canFix={canFix}
          empty={
            <div className="flex flex-col items-center gap-2 py-2">
              <BuddyFace scene="cheer" size="md" className="h-16 w-20" />
              <p className="text-sm font-medium text-fg-strong">{PASS_SETUP_COPY.page.allSet}</p>
            </div>
          }
        />
      </CardBody>
    </Card>
  );
}
