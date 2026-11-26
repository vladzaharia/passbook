import { Link } from '@tanstack/react-router';
import type { ValidationIssue } from '@/passkit/types.ts';
import { CHANNEL_LABEL } from '@/shared/copy/channels.ts';
import { scanLine } from '@/shared/copy/scan.ts';
import { TEMPLATE_BRAND_COPY } from '@/shared/copy/template-brand.ts';
import { capabilityLabel, typeLabel, WALLETS_COPY } from '@/shared/copy/wallets.ts';
import { useInsertHighlight } from '../../../../lib/motion.ts';
import { Buddy } from '../../../../ui/art/buddy.tsx';
import { Button, Callout } from '../../../../ui/index.ts';
import { describeItem } from '../../../../wallet-report/describe.ts';
import { rowId, WalletReport } from '../../../../wallet-report/wallet-report.tsx';
import { useDesigner } from '../context.tsx';
import { type Selection, sectionLabel } from '../model.ts';
import { issueTarget } from '../targets.ts';
import { blockedFixes, type Fix } from './blocked-fixes.ts';
import { ReportRowMenu } from './report-menu.tsx';
import { requiredOf, targetBlock, type WalletEnv } from './wallets-env.ts';

const C = WALLETS_COPY;

/** The wallet-related dry-run issues, each focusing its control; other errors are one line. */
function Problems({
  issues,
  onOther,
}: {
  issues: readonly ValidationIssue[];
  onOther: () => void;
}) {
  const { focusTarget, doc } = useDesigner();
  const at = (i: ValidationIssue) => issueTarget(i, doc);
  const mine = issues.filter(
    (i) => /^wallets[./]/.test(i.path ?? '') || i.code.startsWith('WALLET'),
  );
  const other = issues.filter((i) => i.severity === 'error' && !mine.includes(i)).length;
  if (mine.length === 0 && other === 0) return null;
  return (
    <div className="grid gap-2">
      {mine.map((i) => (
        <Callout
          key={`${i.code}|${i.path}`}
          tone={i.severity === 'error' ? 'danger' : 'warning'}
          actions={
            at(i) ? (
              <Button size="sm" variant="outline" onClick={() => focusTarget(at(i) as Selection)}>
                {C.report.goTo.replace('{label}', sectionLabel((at(i) as Selection).section))}
              </Button>
            ) : undefined
          }
        >
          {i.message}
        </Callout>
      ))}
      {other > 0 ? (
        <button type="button" className="text-left text-sm text-danger underline" onClick={onOther}>
          {C.report.issuesInPass.replace('{n}', String(other))}
        </button>
      ) : null}
    </div>
  );
}

/** The focused wallet's report with its author extras: row menus, Blocked fixes, the buddy. */
export function WalletReportColumn({
  env,
  issues,
  templateOff,
  templateId,
  allReady,
  onPass,
}: {
  env: WalletEnv;
  issues: readonly ValidationIssue[];
  templateOff: boolean;
  templateId: string;
  /** Every listed wallet is Ready: the buddy counts them, once. */
  allReady: boolean;
  onPass: () => void;
}) {
  const { focusTarget } = useDesigner();
  const { target, out, block, edit, readOnly } = env;
  const fresh = useInsertHighlight(out.report.items.map(rowId));
  const { report, view } = out;
  const set = targetBlock(block, target);
  const labels = Object.fromEntries(view.fields.map((f) => [f.path, f.label ?? f.key]));
  const fixes = readOnly ? [] : blockedFixes(env, report);
  const type = typeLabel(
    target,
    typeof set.type === 'string' && set.type !== 'off' ? set.type : report.type,
  );
  const required = requiredOf(block).includes('type') ? ` · ${capabilityLabel('type')}` : '';
  const off = report.status.kind === 'off';
  const mood =
    report.status.kind === 'ready'
      ? 'happy'
      : report.status.kind === 'omissions'
        ? 'curious'
        : 'flat';
  const scene = report.status.kind === 'blocked' ? 'explain' : allReady ? 'count' : 'beat';
  const run = (f: Fix) => ('go' in f ? focusTarget(f.go) : edit(f.op));
  return (
    <div className="relative mt-14" data-testid="wallet-report-column">
      <WalletReport
        report={report}
        host="author"
        fresh={fresh}
        labels={labels}
        typeLine={`${type} · ${typeof set.type === 'string' && set.type !== 'off' ? C.setHere : C.automatic}${required}`}
        issues={<Problems issues={issues} onOther={onPass} />}
        note={
          templateOff ? (
            <>
              {scanLine(TEMPLATE_BRAND_COPY.designer.channelOff, {
                channel: CHANNEL_LABEL[target],
              }).replace(' Change it in Channels and brand.', '')}{' '}
              <Link
                to="/admin/templates/$templateId"
                params={{ templateId }}
                search={{ tab: 'channels' }}
                className="font-medium text-accent-fg underline"
              >
                Channels and brand
              </Link>
            </>
          ) : undefined
        }
        rowMenu={
          readOnly
            ? undefined
            : (item) => <ReportRowMenu item={item} env={env} where={describeItem(item, labels)} />
        }
        blockedActions={
          fixes.length > 0 ? (
            <span className="flex flex-wrap gap-2">
              {fixes.map((f) => (
                <Button key={f.label} size="sm" variant="outline" onClick={() => run(f)}>
                  {f.label}
                </Button>
              ))}
            </span>
          ) : undefined
        }
        footerAction={
          off && set.type === 'off' ? (
            <div className="grid gap-2">
              <p className="text-sm text-fg-muted">{C.offPackage}</p>
              {readOnly ? null : (
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => edit({ op: 'wallets-type', target, type: null })}
                >
                  {C.useAutomaticType}
                </Button>
              )}
            </div>
          ) : undefined
        }
        buddy={
          <Buddy
            key={scene}
            size="sm"
            at="end"
            mood={mood}
            scene={scene}
            replay={report.status.kind === 'blocked' ? report.status.reason.length : 0}
          />
        }
      />
    </div>
  );
}
