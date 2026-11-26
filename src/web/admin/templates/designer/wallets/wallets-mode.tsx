import { Link } from '@tanstack/react-router';
import { useEffect, useMemo } from 'react';
import type { ValidationIssue } from '@/passkit/types.ts';
import { PREVIEW_COPY } from '@/shared/copy/previews.ts';
import { PHONE, useMediaQuery } from '../../../../lib/media.ts';
import { Button, Callout, Skeleton } from '../../../../ui/index.ts';
import { useDesigner } from '../context.tsx';
import { type Dict, legacyStyleOf, previewTargetOf } from '../model.ts';
import { DesignerPreview } from '../preview.tsx';
import { readWallets } from './ops-wallets.ts';
import { roleRows, type WalletName } from './roles-model.ts';
import type { WalletChannels } from './use-wallet-channels.ts';
import { useWalletsCompile } from './use-wallets-compile.ts';
import { WalletInspector } from './wallet-inspector.tsx';
import { WalletPreview } from './wallet-preview.tsx';
import { WalletRail } from './wallet-rail.tsx';
import { WalletReportColumn } from './wallet-report-column.tsx';
import { requiredOf, type WalletEnv } from './wallets-env.ts';
import './wallets.css';

const NO_ISSUES: readonly ValidationIssue[] = [];

/**
 * The designer's third mode: one pass compiling into the wallets. A rail of wallet tiles picks the
 * wallet; the inspector sets what Apple cannot say (type, roles, fields, art, required), the real
 * compiled card and the live report sit beside it. Every edit is an ordinary op in the designer's
 * history; the tab never writes a wallet on or off (that is the template's channel).
 */
export function WalletsMode({
  templateId,
  passJson,
  checking,
  issues,
  channels,
  wallet,
  onWallet,
  onPass,
}: {
  templateId: string;
  passJson: Record<string, unknown> | null | undefined;
  checking: boolean;
  issues: readonly ValidationIssue[];
  channels: WalletChannels;
  wallet: WalletName | undefined;
  onWallet: (wallet: WalletName) => void;
  onPass: () => void;
}) {
  const phone = useMediaQuery(PHONE);
  const { doc, edit, select, state, readOnly, assetBase } = useDesigner();
  const previews = useWalletsCompile(passJson);
  const listed = channels.listed ?? [];
  const block: Dict = readWallets(doc);
  const envOf = (target: WalletName): WalletEnv | null =>
    previews.state === 'ready'
      ? { target, out: previews.out[target], block, edit, assetBase, readOnly: readOnly || phone }
      : null;
  const focused = wallet ?? listed[0];
  const env = focused ? envOf(focused) : null;

  // On entry the section the report points at opens: the type when a block names it, the roles
  // when there are suggestions, else the type.
  const open = state.select.section.startsWith('wallets-');
  const first = useMemo(() => {
    if (!env) return null;
    if (env.out.compiled.blocked?.code === 'TYPE_UNSATISFIED') return 'wallets-type' as const;
    const roles = (block.roles ?? undefined) as Parameters<typeof roleRows>[3];
    const { proposals } = roleRows(
      env.out.view,
      env.target,
      env.out.compiled.type,
      roles,
      requiredOf(block),
    );
    return proposals.length > 0 ? ('wallets-roles' as const) : ('wallets-type' as const);
  }, [env, block]);
  useEffect(() => {
    if (!open && first && !phone) select({ section: first });
  }, [open, first, select, phone]);

  if (!focused) return null;
  const rail = listed.flatMap((target) => {
    const e = envOf(target);
    return e ? [{ target, env: e, off: channels.templateOff.has(target) }] : [];
  });
  const allReady = rail.length > 0 && rail.every((r) => r.env.out.report.status.kind === 'ready');
  const color =
    typeof doc.passJson.backgroundColor === 'string' ? doc.passJson.backgroundColor : undefined;
  const style = legacyStyleOf(doc.passJson);
  const failed = previews.state === 'error';
  return (
    <div className="wallets-mode" data-testid="wallets-mode" aria-busy={checking || undefined}>
      {phone ? (
        <Callout tone="info" title="Preview only">
          The designer needs a tablet or desktop screen.
        </Callout>
      ) : null}
      {previews.state === 'loading' ? (
        <div className="grid grid-cols-2 gap-3" role="status" aria-label={PREVIEW_COPY.loading}>
          <Skeleton className="h-[4.25rem] rounded-lg" />
          <Skeleton className="h-[4.25rem] rounded-lg" />
        </div>
      ) : (
        <WalletRail
          wallets={rail}
          value={focused}
          onChange={onWallet}
          color={color}
          styleName={style}
          onApple={onPass}
        />
      )}
      {failed ? (
        <p role="alert" className="text-sm text-danger">
          {PREVIEW_COPY.failed}
        </p>
      ) : null}
      <div className="wm-grid">
        {phone ? null : (
          <div className="wm-inspector" inert={readOnly} data-readonly={readOnly || undefined}>
            {env ? <WalletInspector env={env} /> : <Skeleton className="h-48 w-full rounded-lg" />}
          </div>
        )}
        <div className="wm-side">
          <div className="wm-preview">
            <WalletPreview
              target={focused}
              previews={previews}
              checking={checking}
              blocked={env?.out.report.status.kind === 'blocked'}
              off={env?.out.report.status.kind === 'off'}
              apple={
                <DesignerPreview
                  passJson={passJson}
                  assets={doc.assets}
                  assetBase={assetBase}
                  checking={false}
                  target={previewTargetOf(doc.passJson, doc.target) ?? 'ios27'}
                />
              }
            />
          </div>
          <div className="wm-report">
            {env ? (
              <WalletReportColumn
                env={env}
                issues={issues ?? NO_ISSUES}
                templateOff={channels.templateOff.has(focused)}
                allReady={allReady}
                onPass={onPass}
              />
            ) : (
              <Skeleton className="h-64 w-full rounded-lg" />
            )}
          </div>
        </div>
      </div>
      {phone ? (
        <Button asChild variant="outline" className="justify-self-center">
          <Link to="/admin/templates/$templateId" params={{ templateId }}>
            Back to template
          </Link>
        </Button>
      ) : null}
    </div>
  );
}
