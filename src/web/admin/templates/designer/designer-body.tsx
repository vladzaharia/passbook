// Lazy boundaries of the designer core (lazy-boundary.test.ts holds them).
//
// Eager, in the first load: the reducer and ops, the draft and save flow, the stage with the Apple
// card, the Issues list, the outline with its Template and Style sections (Style opens first), the
// Data panel and form. Everything below loads when what opens it does, behind a skeleton of the same
// size, so a panel never flashes empty or moves what is around it:
//   - Scan screen and its display editor, samples and preview (scan/scan-mode-safe.tsx)
//   - Wallets, with the Google and Samsung previews and compilers (wallets/wallets-mode.tsx)
//   - Paper and print (stage.tsx, when the Paper channel opens)
//   - every outline section but Template and Style, the stamps editor among them (outline.tsx)
//   - the stamps compositor and PNG codec (stamp-preview.ts, with the first strip)
//   - the local validators for access, scan actions and the scan screen (use-designer-issues.ts);
//     saving waits for them, as it waits for the dry run
//   - in the Workbench: the Code tab's snippet writers and the JSON editor (workbench/design)
// New code that adds a static import of any of these to an eager module undoes the split.

import { lazy, type ReactNode, Suspense } from 'react';
import type { ValidationIssue } from '@/passkit/types.ts';
import { Button, Callout } from '../../../ui/index.ts';
import type { Op } from './apply.ts';
import type { ReadOnlyDesign } from './designer.tsx';
import type { DesignerMode } from './designer-modes.tsx';
import { WalletsSkeleton } from './designer-skeleton.tsx';
import { useDesignerHost } from './host.tsx';
import { DesignerLayout } from './layout.tsx';
import { type DesignDoc, previewTargetOf } from './model.ts';
import { Outline } from './outline.tsx';
import { ScanModeSafe } from './scan/scan-mode-safe.tsx';
import { DesignerStage } from './stage.tsx';
import type { WalletName } from './wallets/roles-model.ts';
import type { WalletChannels } from './wallets/use-wallet-channels.ts';

/** Wallets loads when its mode opens, behind a skeleton of the same columns (the Scan screen does the same). */
const WalletsMode = lazy(() =>
  import('./wallets/wallets-mode.tsx').then((m) => ({ default: m.WalletsMode })),
);

/** "Restored your unsaved draft", with the way to drop it. */
export function RestoredNotice({ onDiscard }: { onDiscard: () => void }) {
  return (
    <Callout
      className="mb-4"
      tone="info"
      actions={
        <Button variant="outline" size="sm" onClick={onDiscard}>
          Discard draft
        </Button>
      }
    >
      Restored your unsaved draft.
    </Callout>
  );
}

/** The open mode: Wallets, Scan screen, or the pass with its structure, card and issues. */
export function DesignerModeView({
  mode,
  onPass,
  templateId,
  creating,
  orgId,
  readOnly,
  phone,
  doc,
  passJson,
  checking,
  issues,
  issuesList,
  wallets,
  wallet,
  onWallet,
  edit,
  assetBase,
  stripUrl,
}: {
  mode: DesignerMode;
  onPass: () => void;
  templateId: string;
  creating: boolean;
  orgId: string | undefined;
  readOnly: ReadOnlyDesign | undefined;
  phone: boolean;
  doc: DesignDoc;
  passJson: Record<string, unknown> | null;
  checking: boolean;
  issues: readonly ValidationIssue[];
  issuesList: ReactNode;
  wallets: WalletChannels;
  wallet: WalletName | undefined;
  onWallet: (wallet: WalletName) => void;
  edit: (op: Op, merge?: string) => void;
  assetBase: string;
  stripUrl: string | null;
}) {
  const extras = useDesignerHost().extras;
  const shown = readOnly ? readOnly.passJson : passJson;
  const busy = readOnly ? false : checking;
  if (mode === 'wallets')
    return (
      <Suspense fallback={<WalletsSkeleton />}>
        <WalletsMode
          templateId={templateId}
          passJson={shown}
          checking={busy}
          issues={issues}
          channels={wallets}
          wallet={wallet}
          onWallet={onWallet}
          onPass={onPass}
        />
      </Suspense>
    );
  if (mode === 'scan')
    return (
      <ScanModeSafe
        onBack={onPass}
        templateId={templateId}
        orgId={orgId ?? null}
        issues={issuesList}
      />
    );
  return (
    <DesignerLayout
      templateId={templateId}
      readOnly={Boolean(readOnly) && !extras}
      structure={
        extras ? (
          // The host's tabs stay live; only the section editor behind them goes inert.
          <extras.Panel
            structure={
              <div inert={Boolean(readOnly)} data-readonly={Boolean(readOnly) || undefined}>
                <Outline />
              </div>
            }
          />
        ) : (
          <Outline />
        )
      }
      below={extras ? <extras.Code /> : undefined}
      preview={
        <DesignerStage
          manifest={doc.manifest}
          templateId={creating ? undefined : templateId}
          orgId={orgId}
          onPaper={readOnly || phone ? undefined : (patch) => edit({ op: 'paper', patch }, 'paper')}
          passJson={shown}
          target={previewTargetOf(doc.passJson, doc.target)}
          assets={doc.assets}
          assetBase={assetBase}
          checking={busy}
          stripUrl={stripUrl}
        />
      }
      issues={issuesList}
    />
  );
}
